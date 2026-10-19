import { forwardRefluxEmailIngress, forwardRefluxRequest, isPrivateEmailIngressPath } from "./refluxClient";
import { normalizeEmail, parseIntegrations, requiredString, type AutomationIntegration } from "./configuration";
export { parseIntegrations } from "./configuration";
export type { AutomationScope, AutomationIntegration } from "./configuration";
import { privateEmailRoutes } from "./emailRoutes";
import { parseForwardedMail, MAX_RAW_EMAIL_BYTES } from "./email";
import { assertPublicHttpsUrl } from "./extraction";
import { parseWebsiteSubmission, issueHumanChallenge, verifyHumanChallenge, type WebsiteSubmission } from "./intake";
import { AutomationCoordinator, type EnqueueSuccess } from "./coordinator";
import type { AutomationEvent } from "./pipeline";
import type { AutomationActivationPacket } from "./replica";
import { handleOwnerApi } from "./ownerApi";
import { handleApplicationReviewApi } from "./applicationReviewApi";
import { handleAutomationInstanceApi } from "./automationInstanceApi";
import { corsHeaders, json, readJson } from "./http";
import { parseAutomationDefinition } from "../../../src/domain/automationContract";
import { workerReleaseIdentity, type WorkerReleaseBindings } from "./buildIdentity";
import { configureAutomationTelemetry, normalizedWorkerRoute, withAutomationSpan } from "./telemetry";
import { encryptEventPayload, encodeBase64Url } from "./eventPayload";

export { AutomationCoordinator } from "./coordinator";

export interface WorkerEnv {
  REFLUX_ORIGIN?: string;
  REFLUX_SERVICE_TOKEN?: string;
  AUTOMATION: DurableObjectNamespace<AutomationCoordinator>;
  AI: Ai;
  AUTOMATION_OWNER_IDS?: string;
  HUMAN_CHECK_SECRET?: string;
  INTEGRATIONS_JSON: string;
  CORS_ORIGINS: string;
  PUBLIC_ORIGIN: string;
  EMAIL_DOMAIN: string;
  EMAIL_ROUTES_JSON?: string;
  PROVISIONING_TOKEN?: string;
  IDENTITY_STORAGE_SECRET?: string;
  EVENT_STORAGE_SECRET?: string;
  /** Commit SHA embedded into this immutable Worker version; unset in local development. */
  RELEASE_SHA?: string;
  /** OTLP Collector base URL. Set as a Worker variable, never a public browser value. */
  OTEL_EXPORTER_OTLP_ENDPOINT?: string;
  /** TinSink server-source key; configure as a Worker secret. */
  TELEMETRY_TOKEN?: string;
  RELEASE_ARTIFACT_SHA256?: WorkerReleaseBindings["RELEASE_ARTIFACT_SHA256"];
  RELEASE_COHORT_ID?: WorkerReleaseBindings["RELEASE_COHORT_ID"];
  RELEASE_SDK_SHA?: WorkerReleaseBindings["RELEASE_SDK_SHA"];
  CF_VERSION_METADATA?: WorkerReleaseBindings["CF_VERSION_METADATA"];
}

type JsonObject = Record<string, unknown>;

const maxActivationJsonBytes = 24 * 1024 * 1024;
const defaultHandler = {
  async fetch(request: Request, env: WorkerEnv, executionCtx?: ExecutionContext): Promise<Response> {
    const telemetry = configureAutomationTelemetry(env);
    let response: Response = json({ error: "Automation request failed" }, 500);
    try {
      response = await withAutomationSpan(telemetry, "automation.http.request", {
        "http.request.method": request.method,
        "http.route": normalizedWorkerRoute(new URL(request.url).pathname),
        "service.name": "tincanban-automation",
      }, async span => {
        const result = await handleFetch(request, env);
        span?.setAttribute("http.response.status_code", result.status);
        return result;
      }, request.headers.get("traceparent"));
    } catch (error) {
      let cors = new Headers();
      try { cors = corsHeaders(request, env); } catch { /* Disallowed origins receive no CORS access. */ }
      if (error instanceof TypeError || error instanceof SyntaxError) response = json({ error: error.message || "Invalid request" }, 400, cors);
      else if (error instanceof Error && /Integration is not configured/.test(error.message)) response = json({ error: error.message }, 404, cors);
      else if (error instanceof Error && /Provisioning authorization/.test(error.message)) response = json({ error: "Unauthorized" }, 401, cors);
      else if (error instanceof Error && /Integration authorization has expired/.test(error.message)) response = json({ error: error.message }, 403, cors);
      else if (error instanceof Error && /expired|already used|already used for different content/.test(error.message)) response = json({ error: error.message }, 409, cors);
      else if (error instanceof Error && /Integration configuration|Integration scope|Integration IDs/.test(error.message)) response = json({ error: error.message }, 500, cors);
      else if (error instanceof Error && /Human check/.test(error.message)) response = json({ error: error.message }, 409, cors);
      else response = json({ error: "Automation request failed" }, 500, cors);
    }
    executionCtx?.waitUntil(telemetry.flush());
    return response;
  },

  async email(message: ForwardableEmailMessage, env: WorkerEnv, executionCtx?: ExecutionContext): Promise<void> {
    const telemetry = configureAutomationTelemetry(env);
    try {
      await withAutomationSpan(telemetry, "automation.email.ingress", {
        "messaging.system": "cloudflare-email",
        "messaging.operation": "receive",
        "service.name": "tincanban-automation",
      }, async span => {
        const reject = (reason: string) => {
          span?.setAttribute("email.outcome", "rejected");
          message.setReject(reason);
        };
        try {
          const route = await findEmailIntegration(env, message.to);
          if (!route) {
            reject("Unknown automation forwarding address");
            return;
          }
          if (!env.REFLUX_ORIGIN) {
            if (!route.integration) {
              reject("Unknown automation forwarding address");
              return;
            }
            try {
              assertActiveIntegration(route.integration);
            } catch {
              reject("Automation integration is expired");
              return;
            }
          }
          const sender = normalizeEmail(message.from);
          if (!route.privateRecipient && !route.integration.allowedForwarders.includes(sender)) {
            reject("Sender is not approved for this automation integration");
            return;
          }
          if (!env.REFLUX_ORIGIN && (!env.EVENT_STORAGE_SECRET || new TextEncoder().encode(env.EVENT_STORAGE_SECRET).byteLength < 32)) {
            reject("Automation event storage is not configured");
            return;
          }

          if (message.rawSize > MAX_RAW_EMAIL_BYTES) {
            reject("Email exceeds the automation message size limit");
            return;
          }
          const bytes = await new Response(message.raw).arrayBuffer();
          if (bytes.byteLength > MAX_RAW_EMAIL_BYTES) {
            reject("Email exceeds the automation message size limit");
            return;
          }
          let parsed;
          try { parsed = await parseForwardedMail(bytes); }
          catch { reject("Email could not be parsed within the supported MIME limits"); return; }
          const rawHash = await digestBytes(bytes);
          const stableSourceId = parsed.messageId ?? `sha256:${rawHash}`;
          const eventId = await digestId(`${route.integrationId}:email:${stableSourceId}`);
          const payload: AutomationEvent = { source: "email", receivedAt: new Date().toISOString(), message: parsed, rawMime: encodeBase64Url(new Uint8Array(bytes)) };
          if (env.REFLUX_ORIGIN) {
            const result = await forwardRefluxEmailIngress(route.integrationId, {
              eventId,
              sourceId: stableSourceId,
              bodyHash: rawHash,
              payload,
            }, env);
            if (result === "conflict") reject("Email message ID conflicts with a stored intake event");
            else console.log(JSON.stringify({ event: "email.intake.accepted", integrationId: route.integrationId, eventId }));
            if (result !== "conflict") span?.setAttribute("email.outcome", "accepted");
            return;
          }
          const integration = route.integration;
          if (!integration) throw new Error("Local email route has no configured integration");
          const result = await coordinator(env, route.integrationId).enqueueEmail({
            eventId,
            sourceId: stableSourceId,
            bodyHash: rawHash,
            payload: await encryptEventPayload(env.EVENT_STORAGE_SECRET, eventId, payload),
          });
          if ("error" in result) reject("Email message ID conflicts with a stored intake event");
          else console.log(JSON.stringify({ event: "email.intake.accepted", integrationId: route.integrationId, eventId, duplicate: result.duplicate }));
          if (!("error" in result)) span?.setAttribute("email.outcome", "accepted");
        } catch (error) {
          span?.setAttribute("email.outcome", "retry");
          throw error;
        }
      });
    } finally {
      try { executionCtx?.waitUntil(telemetry.flush()); }
      catch { /* Telemetry lifecycle support must not alter email delivery. */ }
    }
  },
} satisfies ExportedHandler<WorkerEnv>;

export default defaultHandler;

async function handleFetch(request: Request, env: WorkerEnv): Promise<Response> {
  const url = new URL(request.url);
  const cors = corsHeaders(request, env);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method === "GET" && url.pathname === "/health") return json({ status: "ready", ...workerReleaseIdentity(env) }, 200, cors);
  if (isPrivateEmailIngressPath(url.pathname)) return json({ error: "Not found" }, 404, cors);
  if (env.REFLUX_ORIGIN) return forwardRefluxRequest(request, env, cors);
  if (url.pathname.startsWith("/v2/application-review/")) return handleApplicationReviewApi(request, env, cors);
  if (url.pathname.startsWith("/v2/automation-instances/")) return handleAutomationInstanceApi(request, env, cors);
  if (url.pathname.startsWith("/v2/")) return handleOwnerApi(request, env, cors);

  if (request.method === "POST" && url.pathname === "/v1/challenge") {
    const input = await readJson(request);
    const integrationId = requiredString(input.integrationId, "integrationId", 128);
    const integration = await getIntegration(env, integrationId);
    assertActiveIntegration(integration);
    const secret = env.HUMAN_CHECK_SECRET;
    if (!secret || new TextEncoder().encode(secret).byteLength < 32) {
      return json({ error: "Human-check service is not configured" }, 503, cors);
    }
    return json(await issueHumanChallenge(secret, integrationId), 200, cors);
  }

  const identityMatch = url.pathname.match(/^\/v1\/integrations\/([A-Za-z0-9_-]{1,128})\/identity$/);
  if (request.method === "POST" && identityMatch) {
    authorizeProvisioning(request, env);
    const integrationId = identityMatch[1]!;
    const secret = env.IDENTITY_STORAGE_SECRET;
    if (!secret || new TextEncoder().encode(secret).byteLength < 32) return json({ error: "Automation identity storage is not configured" }, 503, cors);
    const profile = await env.AUTOMATION.getByName(integrationId).provisionIdentity(integrationId, secret);
    return json({ integrationId, origin: url.origin, personId: profile.identity.personId, identityPublicKey: profile.identity.publicKey,
      deviceId: profile.device.deviceId, devicePublicKey: profile.device.publicKey,
      deviceCertificate: profile.deviceCertificate }, 200, cors);
  }

  const activationMatch = url.pathname.match(/^\/v1\/integrations\/([A-Za-z0-9_-]{1,128})\/activation$/);
  if (request.method === "PUT" && activationMatch) {
    authorizeProvisioning(request, env);
    try {
    const integrationId = activationMatch[1]!;
    const integration = await getIntegration(env, integrationId);
    assertActiveIntegration(integration);
    const encryptionSecret = env.EVENT_STORAGE_SECRET;
    const identitySecret = env.IDENTITY_STORAGE_SECRET;
    if (!encryptionSecret || new TextEncoder().encode(encryptionSecret).byteLength < 32 ||
      !identitySecret || new TextEncoder().encode(identitySecret).byteLength < 32) {
      return json({ error: "Automation activation storage is not configured" }, 503, cors);
    }
    const input = await readJson(request, maxActivationJsonBytes) as unknown as AutomationActivationPacket;
    assertActivationMatchesIntegration(input, integration);
    const result = await env.AUTOMATION.getByName(integrationId).activateReplica(integrationId, identitySecret, encryptionSecret, input);
    return result.ok ? json({ status: result.status, workspaceId: result.workspaceId, synced: result.synced }, 200, cors)
      : json({ error: result.error, ...(result.detail ? { detail: result.detail } : {}) }, result.status, cors);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Automation activation failed";
      return json({ error: message }, error instanceof TypeError || error instanceof SyntaxError ? 400 : 500, cors);
    }
  }

  const intakeMatch = url.pathname.match(/^\/v1\/intake\/([A-Za-z0-9_-]{1,128})$/);
  if (request.method === "POST" && intakeMatch) {
    const integration = await getIntegration(env, intakeMatch[1]!);
    assertActiveIntegration(integration);
    if (!env.HUMAN_CHECK_SECRET) return json({ error: "Human-check service is not configured" }, 503, cors);
    if (!env.EVENT_STORAGE_SECRET || new TextEncoder().encode(env.EVENT_STORAGE_SECRET).byteLength < 32) return json({ error: "Automation event storage is not configured" }, 503, cors);
    const submission = parseWebsiteSubmission(await readJson(request));
    if (submission.jobUrl) submission.jobUrl = assertPublicHttpsUrl(submission.jobUrl);
    const verified = await verifyHumanChallenge(env.HUMAN_CHECK_SECRET, integration.id,
      submission.humanCheckToken ?? "", submission.humanCheckAnswer ?? "");
    const idempotencyKey = request.headers.get("Idempotency-Key")?.trim() || crypto.randomUUID();
    if (idempotencyKey.length > 200 || /[\r\n]/.test(idempotencyKey)) throw new TypeError("Idempotency-Key is invalid");
    const eventId = await digestId(`${integration.id}:website:${idempotencyKey}`);
    const normalized = stripHumanCheck(submission);
    const payload: AutomationEvent = { source: "website", receivedAt: new Date().toISOString(), submission: normalized };
    const result = await coordinator(env, integration.id).enqueueWebsite({
      eventId,
      sourceId: eventId,
      bodyHash: await digest(JSON.stringify(normalized)),
      nonce: verified.nonce,
      challengeExpiresAt: verified.expiresAt,
      payload: await encryptEventPayload(env.EVENT_STORAGE_SECRET, eventId, payload),
    });
    if ("error" in result) return json({ error: result.error }, 409, cors);
    return json(acceptedResponse(result), result.duplicate ? 200 : 202, cors);
  }

  const emailSetupMatch = url.pathname.match(/^\/v1\/integrations\/([A-Za-z0-9_-]{1,128})\/email$/);
  if (request.method === "GET" && emailSetupMatch) {
    authorizeProvisioning(request, env);
    await getIntegration(env, emailSetupMatch[1]!);
    const route = privateEmailRoutes(env).find(value => value.id === emailSetupMatch[1]);
    const integrationId = emailSetupMatch[1]!;
    const receipt = await env.AUTOMATION.getByName(integrationId).emailSetup();
    return json({ route: route ?? null, receipt }, 200, cors);
  }

  const eventMatch = url.pathname.match(/^\/v1\/integrations\/([A-Za-z0-9_-]{1,128})\/events\/([A-Za-z0-9_-]{20,64})$/);
  if (request.method === "GET" && eventMatch) {
    authorizeProvisioning(request, env);
    await getIntegration(env, eventMatch[1]!);
    const integrationId = eventMatch[1]!;
    const event = await env.AUTOMATION.getByName(integrationId).getEvent(eventMatch[2]!);
    return event ? json(event, 200, cors) : json({ error: "Event not found" }, 404, cors);
  }

  return json({ error: "Not found" }, 404, cors);
}

function acceptedResponse(result: EnqueueSuccess): JsonObject {
  return {
    eventId: result.eventId,
    status: result.status,
    duplicate: result.duplicate,
    durable: true,
    message: "Saved for classification; no board change is reported as complete.",
  };
}

function coordinator(env: WorkerEnv, integrationId: string): DurableObjectStub<AutomationCoordinator> {
  return env.AUTOMATION.getByName(integrationId);
}

function assertActivationMatchesIntegration(packet: AutomationActivationPacket, integration: AutomationIntegration): void {
  if (!packet || ![1, 2].includes(packet.version) || packet.workspaceId !== integration.workspaceId || packet.blind?.workspaceId !== integration.workspaceId ||
    !packet.grant?.payload || packet.grant.payload.kind !== "workspace-grant" || packet.grant.payload.role !== "automation" ||
    packet.grant.payload.workspaceId !== integration.workspaceId || ![1, 2].includes(packet.grant.payload.automation?.version ?? 0) ||
    packet.grant.payload.automation?.boardId !== integration.scope.boardId ||
    !Number.isFinite(packet.grant.payload.automation?.expiresAt) || packet.grant.payload.automation!.expiresAt <= Date.now() ||
    packet.grant.payload.automation!.expiresAt !== Date.parse(integration.scope.expiresAt)) {
    throw new TypeError("Activation grant does not match configured integration scope");
  }
  if (packet.version === 2) {
    const definition = parseAutomationDefinition(packet.definition?.payload);
    if (definition.id !== integration.id) throw new TypeError("Automation contract ID does not match its integration");
  }
  const expectedFields = integration.scope.fieldIds;
  const actualFields = packet.bindings?.fieldIds;
  const optionalKeys = ["notes", "sourceText", "roleType", "seniority"] as const;
  if (!packet.bindings || packet.bindings.boardId !== integration.scope.boardId ||
    packet.bindings.columns.lead !== integration.scope.columns.lead ||
    packet.bindings.columns.interview !== integration.scope.columns.interview ||
    packet.bindings.columns.rejected !== integration.scope.columns.rejected ||
    actualFields?.company !== expectedFields.company || actualFields.role !== expectedFields.role || actualFields.jobUrl !== expectedFields.jobUrl ||
    optionalKeys.some((key) => actualFields?.[key] !== expectedFields[key]) ||
    packet.grant.payload.automation.columns.lead !== integration.scope.columns.lead ||
    packet.grant.payload.automation.columns.interview !== integration.scope.columns.interview ||
    packet.grant.payload.automation.columns.rejected !== integration.scope.columns.rejected) {
    throw new TypeError("Activation bindings do not match configured integration scope");
  }
  const mapped = Object.values(expectedFields).filter((value): value is string => typeof value === "string").sort();
  const authorized = [...packet.grant.payload.automation.fieldIds].sort();
  if (mapped.length !== authorized.length || mapped.some((fieldId, index) => fieldId !== authorized[index])) {
    throw new TypeError("Activation field IDs do not match signed grant scope");
  }
  if (!packet.initial || typeof packet.initial.document !== "string" || !packet.initial.authorization) {
    throw new TypeError("Activation snapshot is invalid");
  }
}

async function getIntegration(env: WorkerEnv, integrationId: string): Promise<AutomationIntegration> {
  let integration: AutomationIntegration | null | undefined = parseIntegrations(env).find((candidate) => candidate.id === integrationId);
  if (!integration && /^[0-9a-f-]{36}$/.test(integrationId)) {
    integration = await env.AUTOMATION.getByName(integrationId).getRegisteredIntegration();
  }
  if (!integration) throw new Error("Integration is not configured");
  return integration;
}

function authorizeProvisioning(request: Request, env: WorkerEnv): void {
  const expected = env.PROVISIONING_TOKEN;
  const authorization = request.headers.get("authorization") ?? "";
  const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!expected || !constantTimeEqual(supplied, expected)) throw new Error("Provisioning authorization failed");
}

function assertActiveIntegration(integration: AutomationIntegration): void {
  if (Date.parse(integration.scope.expiresAt) <= Date.now()) throw new Error("Integration authorization has expired");
}

type EmailIntegrationRoute =
  | { integrationId: string; privateRecipient: true; integration?: AutomationIntegration }
  | { integrationId: string; privateRecipient: false; integration: AutomationIntegration };

async function findEmailIntegration(env: WorkerEnv, recipient: string): Promise<EmailIntegrationRoute | null> {
  const address = normalizeEmail(recipient);
  const route = privateEmailRoutes(env).find(value => constantTimeEqual(value.address, address));
  if (route) {
    if (env.REFLUX_ORIGIN) return { integrationId: route.id, privateRecipient: true };
    const integration = await getIntegration(env, route.id);
    return { integrationId: route.id, integration, privateRecipient: true };
  }
  const integration = parseIntegrations(env).find((candidate) => candidate.emailAddress === address);
  return integration ? { integrationId: integration.id, integration, privateRecipient: false } : null;
}

function stripHumanCheck(submission: WebsiteSubmission): Omit<WebsiteSubmission, "humanCheckToken" | "humanCheckAnswer"> {
  const normalized = { ...submission };
  delete normalized.humanCheckToken;
  delete normalized.humanCheckAnswer;
  return normalized;
}


async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return encodeBase64Url(new Uint8Array(bytes));
}

async function digestBytes(value: ArrayBuffer): Promise<string> {
  return encodeBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", value)));
}

async function digestId(value: string): Promise<string> {
  return digest(value);
}

function constantTimeEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  let mismatch = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < Math.max(leftBytes.length, rightBytes.length); index += 1) {
    mismatch |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return mismatch === 0;
}
