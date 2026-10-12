import { privateEmailRoutes } from "./emailRoutes";
import { parseForwardedMail, MAX_RAW_EMAIL_BYTES } from "./email";
import { assertPublicHttpsUrl } from "./extraction";
import { parseWebsiteSubmission, issueHumanChallenge, verifyHumanChallenge, type WebsiteSubmission } from "./intake";
import { AutomationCoordinator, type EnqueueSuccess } from "./coordinator";
import type { AutomationEvent } from "./pipeline";
import type { AutomationActivationPacket } from "./replica";
import { handleOwnerApi } from "./ownerApi";
import { corsHeaders, json, readJson } from "./http";
import { parseAutomationDefinition } from "../../../src/domain/automationContract";

export { AutomationCoordinator } from "./coordinator";

export type AutomationScope = {
  version: 1;
  boardId: string;
  columns: { lead: string; applied?: string; interview: string; rejected: string };
  fieldIds: { company: string; role: string; jobUrl: string; notes?: string; sourceText?: string; roleType?: string; seniority?: string };
  expiresAt: string;
};

export type AutomationIntegration = {
  id: string;
  workspaceId: string;
  scope: AutomationScope;
  emailAddress?: string;
  allowedForwarders: string[];
};

export interface WorkerEnv {
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
}

type JsonObject = Record<string, unknown>;

const maxActivationJsonBytes = 24 * 1024 * 1024;
const allowedIntegrationId = /^[A-Za-z0-9_-]{1,128}$/;
const defaultHandler = {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    try {
      return await handleFetch(request, env);
    } catch (error) {
      let cors = new Headers();
      try { cors = corsHeaders(request, env); } catch { /* Disallowed origins receive no CORS access. */ }
      if (error instanceof TypeError || error instanceof SyntaxError) return json({ error: error.message || "Invalid request" }, 400, cors);
      if (error instanceof Error && /Integration is not configured/.test(error.message)) return json({ error: error.message }, 404, cors);
      if (error instanceof Error && /Provisioning authorization/.test(error.message)) return json({ error: "Unauthorized" }, 401, cors);
      if (error instanceof Error && /Integration authorization has expired/.test(error.message)) return json({ error: error.message }, 403, cors);
      if (error instanceof Error && /expired|already used|already used for different content/.test(error.message)) return json({ error: error.message }, 409, cors);
      if (error instanceof Error && /Integration configuration|Integration scope|Integration IDs/.test(error.message)) {
        return json({ error: error.message }, 500, cors);
      }
      if (error instanceof Error && /Human check/.test(error.message)) return json({ error: error.message }, 409, cors);
      return json({ error: "Automation request failed" }, 500, cors);
    }
  },

  async email(message: ForwardableEmailMessage, env: WorkerEnv): Promise<void> {
    const route = await findEmailIntegration(env, message.to);
    if (!route) {
      message.setReject("Unknown automation forwarding address");
      return;
    }
    try {
      assertActiveIntegration(route.integration);
    } catch {
      message.setReject("Automation integration is expired");
      return;
    }
    const sender = normalizeEmail(message.from);
    if (!route.privateRecipient && !route.integration.allowedForwarders.includes(sender)) {
      message.setReject("Sender is not approved for this automation integration");
      return;
    }
    if (!env.EVENT_STORAGE_SECRET || new TextEncoder().encode(env.EVENT_STORAGE_SECRET).byteLength < 32) {
      message.setReject("Automation event storage is not configured");
      return;
    }

    if (message.rawSize > MAX_RAW_EMAIL_BYTES) {
      message.setReject("Email exceeds the automation message size limit");
      return;
    }
    const bytes = await new Response(message.raw).arrayBuffer();
    if (bytes.byteLength > MAX_RAW_EMAIL_BYTES) {
      message.setReject("Email exceeds the automation message size limit");
      return;
    }
    const parsed = await parseForwardedMail(bytes);
    const rawHash = await digestBytes(bytes);
    const stableSourceId = parsed.messageId ?? `sha256:${rawHash}`;
    const eventId = await digestId(`${route.integration.id}:email:${stableSourceId}`);
    const payload: AutomationEvent = { source: "email", receivedAt: new Date().toISOString(), message: parsed, rawMime: encodeBase64Url(new Uint8Array(bytes)) };
    const result = await coordinator(env, route.integration.id).enqueueEmail({
      eventId,
      sourceId: stableSourceId,
      bodyHash: rawHash,
      payload: await encryptEventPayload(env.EVENT_STORAGE_SECRET, eventId, payload),
    });
    if ("error" in result) message.setReject("Email message ID conflicts with a stored intake event");
    else console.log(JSON.stringify({ event: "email.intake.accepted", integrationId: route.integration.id, eventId, duplicate: result.duplicate }));
  },
} satisfies ExportedHandler<WorkerEnv>;

export default defaultHandler;

async function handleFetch(request: Request, env: WorkerEnv): Promise<Response> {
  const url = new URL(request.url);
  const cors = corsHeaders(request, env);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method === "GET" && url.pathname === "/health") return json({ status: "ready" }, 200, cors);
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
    const profile = await coordinator(env, integrationId).provisionIdentity(integrationId, secret);
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
    const result = await coordinator(env, integrationId).activateReplica(integrationId, identitySecret, encryptionSecret, input);
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
    return json({ route: route ?? null, receipt: await coordinator(env, emailSetupMatch[1]!).emailSetup() }, 200, cors);
  }

  const eventMatch = url.pathname.match(/^\/v1\/integrations\/([A-Za-z0-9_-]{1,128})\/events\/([A-Za-z0-9_-]{20,64})$/);
  if (request.method === "GET" && eventMatch) {
    authorizeProvisioning(request, env);
    await getIntegration(env, eventMatch[1]!);
    const event = await coordinator(env, eventMatch[1]!).getEvent(eventMatch[2]!);
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

function parseIntegrations(env: WorkerEnv): AutomationIntegration[] {
  let value: unknown;
  try {
    value = JSON.parse(env.INTEGRATIONS_JSON || "[]") as unknown;
  } catch {
    throw new Error("Integration configuration is invalid");
  }
  if (!Array.isArray(value)) throw new Error("Integration configuration must be a list");
  const ids = new Set<string>();
  const emailAddresses = new Set<string>();
  return value.map((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("Invalid integration configuration");
    const input = candidate as Record<string, unknown>;
    const id = requiredString(input.id, "integration.id", 128);
    const workspaceId = requiredString(input.workspaceId, "integration.workspaceId", 128);
    if (!allowedIntegrationId.test(id) || ids.has(id)) throw new Error("Integration IDs must be unique and URL-safe");
    ids.add(id);
    const scope = parseScope(input.scope);
    const allowedForwarders = parseEmailList(input.allowedForwarders, "allowedForwarders");
    const emailAddress = input.emailAddress === undefined ? undefined : normalizeEmail(requiredString(input.emailAddress, "emailAddress", 320));
    if (emailAddress && emailAddresses.has(emailAddress)) throw new Error("Email routing addresses must be unique");
    if (emailAddress) emailAddresses.add(emailAddress);
    return { id, workspaceId, scope, allowedForwarders, ...(emailAddress ? { emailAddress } : {}) };
  });
}

function parseScope(value: unknown): AutomationScope {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Integration scope is missing");
  const input = value as Record<string, unknown>;
  if (input.version !== 1) throw new Error("Unsupported integration scope version");
  const columns = input.columns as Record<string, unknown> | undefined;
  const fields = input.fieldIds as Record<string, unknown> | undefined;
  if (!columns || typeof columns !== "object" || !fields || typeof fields !== "object") throw new Error("Integration scope bindings are invalid");
  const expiresAt = requiredString(input.expiresAt, "scope.expiresAt", 64);
  if (!Number.isFinite(Date.parse(expiresAt))) throw new Error("Integration scope expiry is invalid");
  const scope: AutomationScope = {
    version: 1,
    boardId: requiredString(input.boardId, "scope.boardId", 128),
    columns: {
      ...(columns.applied === undefined ? {} : { applied: requiredString(columns.applied, "scope.columns.applied", 128) }),
      lead: requiredString(columns.lead, "scope.columns.lead", 128),
      interview: requiredString(columns.interview, "scope.columns.interview", 128),
      rejected: requiredString(columns.rejected, "scope.columns.rejected", 128),
    },
    fieldIds: {
      company: requiredString(fields.company, "scope.fieldIds.company", 128),
      role: requiredString(fields.role, "scope.fieldIds.role", 128),
      jobUrl: requiredString(fields.jobUrl, "scope.fieldIds.jobUrl", 128),
      ...(optionalField(fields.notes, "scope.fieldIds.notes")),
      ...(optionalField(fields.sourceText, "scope.fieldIds.sourceText")),
      ...(optionalField(fields.roleType, "scope.fieldIds.roleType")),
      ...(optionalField(fields.seniority, "scope.fieldIds.seniority")),
    },
    expiresAt,
  };
  const bindings = [scope.boardId, ...Object.values(scope.columns), ...Object.values(scope.fieldIds).filter((value): value is string => !!value)];
  if (new Set(bindings).size !== bindings.length) throw new Error("Integration scope bindings must be distinct");
  return scope;
}

function assertActivationMatchesIntegration(packet: AutomationActivationPacket, integration: AutomationIntegration): void {
  if (!packet || ![1, 2].includes(packet.version) || packet.workspaceId !== integration.workspaceId || packet.blind?.workspaceId !== integration.workspaceId ||
    !packet.grant?.payload || packet.grant.payload.kind !== "workspace-grant" || packet.grant.payload.role !== "automation" ||
    packet.grant.payload.workspaceId !== integration.workspaceId || packet.grant.payload.automation?.version !== 1 ||
    packet.grant.payload.automation.boardId !== integration.scope.boardId ||
    !Number.isFinite(packet.grant.payload.automation.expiresAt) || packet.grant.payload.automation.expiresAt <= Date.now() ||
    packet.grant.payload.automation.expiresAt !== Date.parse(integration.scope.expiresAt)) {
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

function optionalField(value: unknown, name: string): { [key: string]: string } {
  return value === undefined ? {} : { [name.split(".").at(-1)!]: requiredString(value, name, 128) };
}

async function getIntegration(env: WorkerEnv, integrationId: string): Promise<AutomationIntegration> {
  const integration = parseIntegrations(env).find((candidate) => candidate.id === integrationId) ??
    (/^[0-9a-f-]{36}$/.test(integrationId) ? await coordinator(env, integrationId).getRegisteredIntegration() : null);
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

async function findEmailIntegration(env: WorkerEnv, recipient: string): Promise<{ integration: AutomationIntegration; privateRecipient?: boolean } | null> {
  const address = normalizeEmail(recipient);
  const route = privateEmailRoutes(env).find(value => constantTimeEqual(value.address, address));
  if (route) {
    const integration = await getIntegration(env, route.id);
    return { integration, privateRecipient: true };
  }
  const integration = parseIntegrations(env).find((candidate) => candidate.emailAddress === address);
  return integration ? { integration } : null;
}

function normalizeEmail(value: string): string {
  const match = value.trim().match(/^(?:[^<>]*<)?([^<>\s]+@[^<>\s]+)>?$/);
  const address = (match?.[1] ?? "").toLocaleLowerCase("en-US");
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address)) throw new TypeError("Email address is invalid");
  return address;
}

function parseEmailList(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length > 20) throw new Error(`${name} must contain at most 20 addresses`);
  return [...new Set(value.map((item) => normalizeEmail(requiredString(item, name, 320))))];
}


function requiredString(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== "string") throw new TypeError(`${name} must be text`);
  const normalized = value.trim();
  if (!normalized || new TextEncoder().encode(normalized).byteLength > maxLength) throw new TypeError(`${name} is invalid`);
  return normalized;
}

function stripHumanCheck(submission: WebsiteSubmission): Omit<WebsiteSubmission, "humanCheckToken" | "humanCheckAnswer"> {
  const { humanCheckToken: _token, humanCheckAnswer: _answer, ...normalized } = submission;
  return normalized;
}


async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return encodeBase64Url(new Uint8Array(bytes));
}

async function digestBytes(value: ArrayBuffer): Promise<string> {
  return encodeBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", value)));
}

async function encryptEventPayload(secret: string, eventId: string, event: AutomationEvent): Promise<string> {
  if (new TextEncoder().encode(secret).byteLength < 32) throw new Error("Event storage secret must contain at least 32 bytes");
  const keyBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`TIN/event-key/v1/${secret}`));
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt"]);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(event));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce,
    additionalData: new TextEncoder().encode(`TIN/event-payload/v1/${eventId}`), tagLength: 128 }, key, plaintext);
  return `${encodeBase64Url(nonce)}.${encodeBase64Url(new Uint8Array(ciphertext))}`;
}

async function digestId(value: string): Promise<string> {
  return digest(value);
}

function encodeBase64Url(bytes: Uint8Array): string {
  let text = "";
  for (let index = 0; index < bytes.length; index += 0x8000) text += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
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
