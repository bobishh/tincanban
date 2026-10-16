import type { AutomationCoordinator, WorkerEnv } from "./index";
import type { ItemCommandEnvelope } from "./itemCommands";

/** Methods exposed to the standalone executor. Replica persistence and lifecycle stay local. */
export const executorRpcMethods = [
  "enrollOwner", "activateOwner", "getRegisteredIntegration", "observeOwner", "provisionIdentity",
  "activateReplica", "retryEmail", "bindEmailApplication",
  "retryBoundEmailApplication", "manageInstance", "applicationReview", "emailSetup", "getEvent", "classificationContext",
] as const;

export type ExecutorRpcMethod = typeof executorRpcMethods[number];
export type ExecutorRoute = { origin: string; epoch: number } | null;

type ExecutorRouteSource = Pick<DurableObjectStub<AutomationCoordinator>, "executionRoute">;

/** Use the executor only after the Durable Object has durably acknowledged the cutover. */
export async function callActiveExecutor<T>(
  env: Pick<WorkerEnv, "AUTOMATION" | "EXECUTOR_ORIGIN" | "EXECUTOR_SERVICE_TOKEN">,
  integrationId: string,
  method: ExecutorRpcMethod | "enqueueWebsite" | "enqueueEmail",
  args: unknown[],
  localCall: (coordinator: DurableObjectStub<AutomationCoordinator>) => Promise<T>,
): Promise<T> {
  const coordinator = env.AUTOMATION.getByName(integrationId) as DurableObjectStub<AutomationCoordinator> & ExecutorRouteSource;
  if (method === "enqueueWebsite" || method === "enqueueEmail") return localCall(coordinator);
  const route = await coordinator.executionRoute();
  if (!route) return localCall(coordinator);

  const configuredOrigin = executorOrigin(env.EXECUTOR_ORIGIN);
  if (route.origin !== configuredOrigin || !Number.isSafeInteger(route.epoch) || route.epoch < 1) {
    throw new Error("Acknowledged executor route does not match configured executor origin or epoch");
  }
  return callExecutorRpc(env, integrationId, route.epoch, method, args);
}

/** Call Node directly after the caller has already validated the durable route; avoids re-entering a DO alarm lane. */
export async function callExecutorRpc<T>(
  env: Pick<WorkerEnv, "EXECUTOR_ORIGIN" | "EXECUTOR_SERVICE_TOKEN">,
  integrationId: string,
  epoch: number,
  method: ExecutorRpcMethod,
  args: unknown[],
  maxResponseBytes = 24 * 1024 * 1024,
): Promise<T> {
  const configuredOrigin = executorOrigin(env.EXECUTOR_ORIGIN);
  if (!Number.isSafeInteger(epoch) || epoch < 1) throw new Error("Executor route epoch is invalid");
  const token = env.EXECUTOR_SERVICE_TOKEN;
  if (!token || new TextEncoder().encode(token).byteLength < 32) {
    throw new Error("Executor service authentication is not configured");
  }

  const response = await fetch(`${configuredOrigin}/internal/integrations/${encodeURIComponent(integrationId)}/rpc`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-tincanban-executor-epoch": String(epoch),
    },
    body: JSON.stringify({ method, args }),
    redirect: "error",
  });
  const payload = await readResponseJson(response, maxResponseBytes);
  if (!response.ok) {
    const message = isRecord(payload) && typeof payload.error === "string" ? payload.error : "Executor request failed";
    throw new ExecutorRpcError(response.status, message);
  }
  return payload as T;
}

export function authorizeInternalRequest(request: Request, expectedToken: string | undefined): boolean {
  if (!expectedToken || new TextEncoder().encode(expectedToken).byteLength < 32) return false;
  const authorization = request.headers.get("authorization") ?? "";
  const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  const encoder = new TextEncoder();
  const left = encoder.encode(supplied);
  const right = encoder.encode(expectedToken);
  let mismatch = left.byteLength ^ right.byteLength;
  for (let index = 0; index < Math.max(left.byteLength, right.byteLength); index += 1) {
    mismatch |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return mismatch === 0;
}

export class ExecutorRpcError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "ExecutorRpcError";
  }
}

/** Submit a normalized item command to the integration-scoped executor API. */
export async function submitExecutorItemCommand<T>(
  env: Pick<WorkerEnv, "EXECUTOR_ORIGIN" | "EXECUTOR_SERVICE_TOKEN">,
  integrationId: string,
  envelope: ItemCommandEnvelope,
): Promise<T> {
  const origin = executorOrigin(env.EXECUTOR_ORIGIN);
  const token = env.EXECUTOR_SERVICE_TOKEN;
  if (!token || new TextEncoder().encode(token).byteLength < 32) throw new Error("Executor service authentication is not configured");
  const response = await fetch(`${origin}/v1/items/commands`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-executor-integration": integrationId },
    body: JSON.stringify(envelope),
    redirect: "error",
  });
  const payload = await readResponseJson(response, 2 * 1024 * 1024);
  if (!response.ok) {
    const message = isRecord(payload) && typeof payload.error === "string" ? payload.error : "Executor item command failed";
    throw new ExecutorRpcError(response.status, message);
  }
  return payload as T;
}

/** Ask the acknowledged executor for the current classification profile for this integration. */
export function fetchExecutorClassificationContext<T>(
  env: Pick<WorkerEnv, "AUTOMATION" | "EXECUTOR_ORIGIN" | "EXECUTOR_SERVICE_TOKEN">,
  integrationId: string,
  localCall: (coordinator: DurableObjectStub<AutomationCoordinator>) => Promise<T>,
): Promise<T> {
  return callActiveExecutor(env, integrationId, "classificationContext", [], localCall);
}

function executorOrigin(value: string | undefined): string {
  if (!value) throw new Error("Executor origin is not configured");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Executor origin must be an HTTPS origin without credentials, path, query or fragment");
  }
  return url.origin;
}

async function readResponseJson(response: Response, maximumBytes: number): Promise<unknown> {
  if (!response.body) throw new Error("Executor returned an empty response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel("Executor response exceeds the size limit");
        throw new Error("Executor response exceeds the size limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
