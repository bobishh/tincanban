import { registerWebMcpTools } from "./ui/webmcpTools";
import type { ModelContext, ToolStore } from "./webmcpContract";
import { meshTraceSnapshot } from "./sync/meshTrace";
import { telemetryStatus } from "./sync/telemetry";

export {
  type ModelContext,
  type ToolStore,
} from "./webmcpContract";

type ModelContextHost = {
  document?: globalThis.Document & { modelContext?: ModelContext };
  navigator?: Navigator & { modelContext?: ModelContext };
};

function modelContext(): ModelContext | undefined {
  const host = globalThis as typeof globalThis & ModelContextHost;
  return host.document?.modelContext ?? host.navigator?.modelContext;
}

async function waitForModelContext(
  timeoutMs = 3000,
): Promise<ModelContext | undefined> {
  const deadline = Date.now() + timeoutMs;
  do {
    const context = modelContext();
    if (context?.registerTool) return context;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  return undefined;
}

export async function registerWebMcp(
  store: ToolStore,
  explicitContext?: ModelContext,
): Promise<(() => void) | undefined> {
  const context = explicitContext ?? (await waitForModelContext());
  if (!context?.registerTool) return undefined;
  const lifecycle = new AbortController();
  await registerWebMcpTools({ ...store, getSyncTrace: meshTraceSnapshot, getSyncDiagnostics: telemetryStatus }, (tool) =>
    context.registerTool(tool, { signal: lifecycle.signal }),
  );
  return () => lifecycle.abort();
}
