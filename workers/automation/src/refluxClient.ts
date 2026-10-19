import type { ForwardedMail } from "./email";

type RefluxEnvironment = { REFLUX_ORIGIN?: string; REFLUX_SERVICE_TOKEN?: string; PUBLIC_ORIGIN: string };
const maximumResponseBytes = 24 * 1024 * 1024;
const maximumEmailIngressResponseBytes = 64 * 1024;
const maximumEmailIngressRequestBytes = 2 * 1024 * 1024;

/** This private route must never become an unauthenticated public proxy target. */
export function isPrivateEmailIngressPath(pathname: string): boolean {
  let decodedPath: string;
  try { decodedPath = decodeURIComponent(pathname); }
  catch { return false; }
  const segments = decodedPath.split("/").filter(Boolean);
  return segments.length >= 4 && segments[0]?.toLowerCase() === "v2" &&
    segments[1]?.toLowerCase() === "integrations" && segments.slice(3).some(segment => segment.toLowerCase() === "email-ingress");
}

export type RefluxEmailIngress = {
  eventId: string;
  sourceId: string;
  bodyHash: string;
  payload: {
    source: "email";
    receivedAt: string;
    message: ForwardedMail;
    rawMime: string;
  };
};

/** Submit normalized, retained mail to Reflux; only an explicit event conflict is permanent. */
export async function forwardRefluxEmailIngress(integrationId: string, input: RefluxEmailIngress,
  env: RefluxEnvironment): Promise<"accepted" | "conflict"> {
  if (!env.REFLUX_ORIGIN || !env.REFLUX_SERVICE_TOKEN || new TextEncoder().encode(env.REFLUX_SERVICE_TOKEN).byteLength < 32) {
    throw new Error("Reflux email ingress is not configured");
  }
  const origin = new URL(env.REFLUX_ORIGIN);
  if (origin.protocol !== "https:" || origin.origin !== env.REFLUX_ORIGIN || origin.username || origin.password) {
    throw new Error("Reflux origin is invalid");
  }
  const endpoint = `${origin.origin}/internal/tincanban/v2/integrations/${encodeURIComponent(integrationId)}/email-ingress`;
  const body = JSON.stringify(input);
  if (new TextEncoder().encode(body).byteLength > maximumEmailIngressRequestBytes) {
    throw new Error("Email ingress request exceeds its size limit");
  }
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.REFLUX_SERVICE_TOKEN}`,
        "content-type": "application/json",
        "x-tincanban-public-origin": env.PUBLIC_ORIGIN,
      },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(55_000),
    });
  } catch {
    throw new Error("Reflux is unavailable. Retry the same email event.");
  }
  if (response.status === 409) {
    const conflictBody = await readBoundedResponse(response, maximumEmailIngressResponseBytes);
    let conflict: unknown;
    try { conflict = JSON.parse(conflictBody); }
    catch { throw new Error("Reflux email ingress returned an invalid conflict outcome. Retry the same email event."); }
    if (conflict && typeof conflict === "object" && !Array.isArray(conflict) &&
        (conflict as Record<string, unknown>).code === "email-content-conflict") return "conflict";
    throw new Error("Reflux email ingress returned an unexpected conflict. Retry the same email event.");
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new Error("Reflux email ingress redirects are not allowed. Retry the same email event.");
  }
  if (response.status !== 200 && response.status !== 202) {
    await response.body?.cancel();
    throw new Error(`Reflux email ingress returned an unexpected status (HTTP ${response.status}). Retry the same email event.`);
  }
  const text = await readBoundedResponse(response, maximumEmailIngressResponseBytes);
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new Error("Reflux email ingress returned invalid JSON. Retry the same email event."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Reflux email ingress returned an invalid outcome. Retry the same email event.");
  }
  const outcome = value as Record<string, unknown>;
  if (outcome.eventId !== input.eventId || outcome.durable !== true || typeof outcome.duplicate !== "boolean" ||
      outcome.status !== "pending") {
    throw new Error("Reflux email ingress returned an invalid outcome. Retry the same email event.");
  }
  return "accepted";
}

/** Preserve the existing signed public API while Reflux owns its processing and state. */
export async function forwardRefluxRequest(request: Request, env: RefluxEnvironment, cors: Headers): Promise<Response> {
  const result = (error: string, status: number) => Response.json({ error }, { status, headers: cors });
  const url = new URL(request.url);
  if (isPrivateEmailIngressPath(url.pathname)) return result("Not found", 404);
  if (!env.REFLUX_ORIGIN || !env.REFLUX_SERVICE_TOKEN || new TextEncoder().encode(env.REFLUX_SERVICE_TOKEN).byteLength < 32) {
    return result("Reflux processing is not configured", 503);
  }
  const origin = new URL(env.REFLUX_ORIGIN);
  if (origin.protocol !== "https:" || origin.origin !== env.REFLUX_ORIGIN || origin.username || origin.password) {
    return result("Reflux origin is invalid", 503);
  }
  if (!url.pathname.startsWith("/v2/") && !/^\/v1\/(challenge|intake\/[^/]+)$/.test(url.pathname)) return result("Not found", 404);
  if (request.method !== "GET" && request.method !== "POST" && request.method !== "PUT") return result("Method not allowed", 405);
  const headers = new Headers({
    authorization: `Bearer ${env.REFLUX_SERVICE_TOKEN}`,
    "content-type": "application/json",
    "x-tincanban-public-origin": env.PUBLIC_ORIGIN,
  });
  const publicIntake = url.pathname.startsWith("/v1/");
  if (publicIntake) {
    headers.delete("authorization");
    headers.delete("x-tincanban-public-origin");
    const callerOrigin = request.headers.get("origin");
    if (callerOrigin) headers.set("origin", callerOrigin);
  }
  const traceparent = request.headers.get("traceparent");
  if (traceparent) headers.set("traceparent", traceparent);
  const idempotencyKey = request.headers.get("idempotency-key");
  if (idempotencyKey) headers.set("idempotency-key", idempotencyKey);
  try {
    const response = await fetch(`${origin.origin}${publicIntake ? "" : "/internal/tincanban"}${url.pathname}${url.search}`, {
      method: request.method, headers, body: request.method === "GET" ? undefined : request.body,
      redirect: "manual", signal: AbortSignal.timeout(55_000),
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      return result("Reflux redirects are not allowed", 502);
    }
    const text = await readResponse(response);
    try { JSON.parse(text); }
    catch {
      return result(response.ok ? "Reflux returned invalid JSON" : `Reflux is unavailable (HTTP ${response.status}). Retry the same operation.`, response.ok ? 502 : response.status);
    }
    const responseHeaders = new Headers(cors);
    responseHeaders.set("content-type", "application/json");
    responseHeaders.set("cache-control", "no-store");
    return new Response(text, { status: response.status, headers: responseHeaders });
  } catch {
    return result("Reflux is unavailable. Retry the same operation.", 503);
  }
}

async function readResponse(response: Response): Promise<string> {
  return readBoundedResponse(response, maximumResponseBytes);
}

async function readBoundedResponse(response: Response, maximumBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) { await reader.cancel(); throw new Error("Reflux response exceeds its bound"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
