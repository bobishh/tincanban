import { privateEmailRoutes } from "./emailRoutes";
import { automationTypes, parseAutomationDefinition } from "../../../src/domain/automationContract";
import { automationBodyHash, verifyAutomationOwnerRequest } from "../../../src/domain/automationProtocol";
import type { WorkerEnv, AutomationIntegration } from "./index";
import type { AutomationActivationPacket } from "./replica";
import { json, readJson } from "./http";

/** Browser bootstrap needs a deployment-approved identity, never the operator credential. */
export async function handleOwnerApi(request: Request, env: WorkerEnv, cors: Headers): Promise<Response> {
  const url = new URL(request.url);
  const owners = (env.AUTOMATION_OWNER_IDS ?? "").split(",").map(value => value.trim()).filter(Boolean);
  if (request.method === "GET" && url.pathname === "/v2/capabilities") return json({
    version: 2, origin: url.origin, enrollment: owners.length > 0,
    types: automationTypes.map(value => ({ type: value.type, version: value.version, title: value.title })),
    emailRouting: privateEmailRoutes(env).length > 0,
    applicationReview: { version: 1, actions: ["discover", "list", "review", "bind", "retry", "retry-unbound"] },
    instanceManagement: { version: 1, actions: ["discover", "identity", "activate", "refresh-access"] },
  }, 200, cors);
  const match = url.pathname.match(/^\/v2\/integrations\/([0-9a-f-]{36})\/(identity|activation|observation|email)$/);
  if (!match) return json({ error: "Not found" }, 404, cors);
  const operation = match[2]!;
  if (request.method !== (operation === "activation" ? "PUT" : "POST")) return json({ error: "Method not allowed" }, 405, cors);
  if (!owners.length) return json({ error: "Owner enrollment is not configured on this Worker" }, 503, cors);
  if (!env.IDENTITY_STORAGE_SECRET || !env.EVENT_STORAGE_SECRET) return json({ error: "Automation storage is not configured" }, 503, cors);
  const input = await readJson(request, operation === "activation" ? 24 * 1024 * 1024 : 24 * 1024);
  let intent;
  try { intent = await verifyAutomationOwnerRequest(input.ownerRequest, url.origin, owners); }
  catch { return json({ error: "Owner signature is unauthorized, expired or invalid" }, 401, cors); }
  const action = operation === "identity" ? "enroll" : operation === "activation" ? "activate" : operation === "email" ? "email" : "observe";
  if (intent.action !== action || intent.integrationId !== match[1] ||
    (action !== "activate" && action !== "email" && intent.bodyHash !== null)) return json({ error: "Owner request does not match this operation" }, 400, cors);
  const coordinator = env.AUTOMATION.getByName(intent.integrationId);
  const registration = { integrationId: intent.integrationId, workspaceId: intent.workspaceId, ownerPersonId: intent.personId };
  try {
    if (operation === "identity") {
      const profile = await coordinator.enrollOwner(registration, env.IDENTITY_STORAGE_SECRET);
      return json({ integrationId: intent.integrationId, origin: url.origin, personId: profile.identity.personId,
        identityPublicKey: profile.identity.publicKey, deviceId: profile.device.deviceId, devicePublicKey: profile.device.publicKey,
        deviceCertificate: profile.deviceCertificate }, 200, cors);
    }
    if (operation === "email") {
      if (intent.bodyHash !== null && (typeof input.retryEventId !== "string" || !/^[A-Za-z0-9_-]{20,64}$/.test(input.retryEventId) ||
        intent.bodyHash !== await automationBodyHash({ retryEventId: input.retryEventId }))) return json({ error: "Email retry does not match its owner signature" }, 400, cors);
      await coordinator.observeOwner(registration, intent.nonce, url.origin);
      if (intent.bodyHash !== null) return json(await coordinator.retryEmail(registration, input.retryEventId as string), 200, cors);
      const route = privateEmailRoutes(env).find(value => value.id === intent.integrationId);
      return json({ route: route ?? null, receipt: await coordinator.emailSetup() }, 200, cors);
    }
    if (operation === "observation") {
      const observation = await coordinator.observeOwner(registration, intent.nonce, url.origin);
      return observation ? json(observation, 200, cors) : json({ error: "Waiting for activation" }, 409, cors);
    }
    if (intent.bodyHash !== await automationBodyHash(input.packet)) return json({ error: "Activation body does not match its owner signature" }, 400, cors);
    const packet = input.packet as AutomationActivationPacket;
    const definition = parseAutomationDefinition(packet.definition?.payload);
    if (packet.version !== 2 || packet.workspaceId !== intent.workspaceId || packet.blind?.workspaceId !== intent.workspaceId ||
      definition.id !== intent.integrationId || definition.scope.workspaceId !== intent.workspaceId ||
      packet.initial?.authorization?.authority?.currentOwner?.personId !== intent.personId) {
      return json({ error: "Activation does not match its enrolled owner, workspace or instance" }, 422, cors);
    }
    const grant = packet.grant?.payload?.automation;
    if (!grant || definition.typeVersion !== grant.version || definition.scope.boardId !== grant.boardId || definition.scope.grantId !== packet.grant.payload.grantId) {
      return json({ error: "Activation scope is incomplete" }, 422, cors);
    }
    const integration: AutomationIntegration = { id: intent.integrationId, workspaceId: intent.workspaceId,
      scope: { ...packet.bindings, version: 1, expiresAt: new Date(grant.expiresAt).toISOString() }, allowedForwarders: [] };
    const result = await coordinator.activateOwner(registration, packet, integration, url.origin);
    return result.ok ? json({ status: result.status, synced: true }, 200, cors)
      : json({ error: result.error }, result.status, cors);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Automation setup failed";
    return json({ error: message }, /enrolled|bound/.test(message) ? 409 : 422, cors);
  }
}
