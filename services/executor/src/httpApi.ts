import { authorizeInternalRequest, executorRpcMethods } from "../../../workers/automation/src/executorClient";

export type ParticipantRequest = {
  operation: "rpc" | "reaction" | "status" | "bootstrap" | "import-manifest" | "import-page" | "activate" | "tick";
  method?: string; args?: unknown[]; epoch?: number; body?: unknown;
  traceparent?: string;
};
export interface ParticipantRuntime { call(integrationId: string, request: ParticipantRequest): Promise<unknown> }
export type ExecutorHttpConfig = { serviceToken: string; producers: Array<{ token: string; integrationIds: string[] }> };
export type ExecutorArtifact = { component: string; sourceSha: string; sdkSha: string; artifactSha256: string };

export function createExecutorHandler(runtime: ParticipantRuntime, config: ExecutorHttpConfig, artifact: ExecutorArtifact) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/health") return json({ status: "ready", ...artifact });
      if (url.pathname === "/v1/items/commands" || url.pathname.startsWith("/v1/items/commands/")) {
        const integrationId = request.headers.get("x-executor-integration") ?? "";
        if (!validIntegration(integrationId) || !config.producers.some(producer => authorizeInternalRequest(request, producer.token) && producer.integrationIds.includes(integrationId))) {
          return json({ error: "Producer is not authorized for this integration" }, 403);
        }
        if (request.method === "POST" && url.pathname === "/v1/items/commands") {
          const body = await readJson(request, 2 * 1024 * 1024);
          if (!body || typeof body !== "object" || Array.isArray(body) || (body as Record<string, unknown>).integrationId !== integrationId) throw new HttpError(400, "Command targets another integration");
          const result = await runtime.call(integrationId, { operation: "rpc", method: "enqueueItemCommand", args: [body],
            ...(request.headers.get("traceparent") ? { traceparent: request.headers.get("traceparent")! } : {}) }) as {
            eventId: string; status: string; duplicate: boolean; error?: string;
          };
          if (result.error) return json({ error: result.error }, 409);
          return json({ commandId: result.eventId, ...result, durable: true, resultUrl: `/v1/items/commands/${result.eventId}` }, result.duplicate ? 200 : 202);
        }
        const match = url.pathname.match(/^\/v1\/items\/commands\/([A-Za-z0-9_-]{43})$/);
        if (request.method === "GET" && match) {
          const result = await runtime.call(integrationId, { operation: "rpc", method: "getItemCommandResult", args: [match[1], integrationId] });
          return result ? json(result) : json({ error: "Command not found" }, 404);
        }
        return json({ error: "Method or route not supported" }, 405);
      }
      if (!authorizeInternalRequest(request, config.serviceToken)) return json({ error: "Service authentication required" }, 401);
      const match = url.pathname.match(/^\/internal\/integrations\/([A-Za-z0-9_-]{1,128})\/(rpc|status|bootstrap|migration-manifest|migration-page|activate)$/);
      if (!match) return json({ error: "Not found" }, 404);
      const [, integrationId, action] = match;
      if (request.method === "GET" && action === "status") return json(await runtime.call(integrationId!, { operation: "status" }));
      if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
      const body = await readJson(request, action === "rpc" ? 32 * 1024 * 1024 : 6 * 1024 * 1024);
      if (action === "bootstrap") return json(await runtime.call(integrationId!, { operation: "bootstrap", body }));
      if (action === "rpc") {
        const value = body as { method?: unknown; args?: unknown };
        if (!value || typeof value.method !== "string" || !executorRpcMethods.some(method => method === value.method) ||
          !Array.isArray(value.args) || value.args.length > 8) throw new HttpError(400, "Unsupported executor method");
        const epochText = request.headers.get("x-tincanban-executor-epoch");
        if (epochText === null || !/^[1-9][0-9]*$/.test(epochText)) throw new HttpError(409, "Executor routing epoch required");
        return json(await runtime.call(integrationId!, { operation: "rpc", method: value.method, args: value.args, epoch: Number(epochText) }));
      }
      const operation = action === "migration-manifest" ? "import-manifest" : action === "migration-page" ? "import-page" : "activate";
      return json(await runtime.call(integrationId!, { operation, body }));
    } catch (error) {
      const status = error instanceof HttpError ? error.status : error && typeof error === "object" && "status" in error && Number.isInteger(error.status) ? Number(error.status)
        : error instanceof TypeError || error instanceof SyntaxError ? 400 : 500;
      return json({ error: error instanceof Error ? error.message : "Executor request failed" }, status >= 400 && status <= 599 ? status : 500);
    }
  };
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

async function readJson(request: Request, maximum: number): Promise<unknown> {
  if (!request.body) throw new TypeError("JSON request body required");
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maximum) { await reader.cancel(); throw new HttpError(413, "Request exceeds its size bound"); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value ?? null), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
function validIntegration(value: string): boolean { return /^[A-Za-z0-9_-]{1,128}$/.test(value); }
