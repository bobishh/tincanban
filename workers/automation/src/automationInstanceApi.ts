import { automationBodyHash } from "../../../src/domain/automationProtocol";
import { parseAutomationInstanceBody } from "../../../src/domain/automationInstanceData";
import { verifyAutomationInstanceRequest, type AutomationInstanceAction, type AutomationInstanceRequestProof } from "../../../src/domain/automationInstanceProtocol";
import { parseIntegrations, type WorkerEnv } from "./index";
import { privateEmailRoutes } from "./emailRoutes";
import { json, readJson } from "./http";
import { callActiveExecutor, ExecutorRpcError } from "./executorClient";
import { ExecutorMigrationFencedError } from "./executorIntakeOutbox";

/** Manage an existing executor under current workspace Owner rights, independently of bootstrap enrollment. */
export async function handleAutomationInstanceApi(request: Request, env: WorkerEnv, cors: Headers): Promise<Response> {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/v2\/automation-instances\/(discover|identity|activate|refresh-access|prepare-storage-rotation|rotate-storage|prepare-history-baseline|activate-history-baseline)$/);
  if (!match) return json({ error: "Not found" }, 404, cors);
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, cors);
  if (!env.EVENT_STORAGE_SECRET || !env.IDENTITY_STORAGE_SECRET) return json({ error: "Automation storage is not configured" }, 503, cors);
  const action = match[1] as AutomationInstanceAction;
  let input;
  let body;
  try {
    input = await readJson(request, action === "activate" ? 24 * 1024 * 1024 : 384 * 1024);
    if (Object.keys(input).length !== 2 || !Object.hasOwn(input, "instanceRequest") || !Object.hasOwn(input, "body")) {
      throw new TypeError("Instance management requires exactly its request proof and body");
    }
    body = parseAutomationInstanceBody(action, input.body);
  } catch (error) { return json({ error: error instanceof Error ? error.message : "Invalid instance management body" }, 400, cors); }
  const expected = { action, origin: url.origin, workspaceId: body.workspaceId, definitionId: body.definitionId,
    integrationId: "integrationId" in body ? body.integrationId : null, executorPersonId: body.executorPersonId,
    bodyHash: await automationBodyHash(input.body) };
  try { await verifyAutomationInstanceRequest(input.instanceRequest, expected); }
  catch { return json({ error: "Instance signature is expired, invalid or targets another operation" }, 401, cors); }
  try {
    const proof = input.instanceRequest as AutomationInstanceRequestProof;
    if (action === "discover") {
      const routes = new Set([body.definitionId,
        ...parseIntegrations(env).filter(value => value.workspaceId === body.workspaceId).map(value => value.id),
        ...privateEmailRoutes(env).map(value => value.id)]);
      if (routes.size > 64) throw new Error("Instance discovery exceeds the configured route limit");
      const integrations: Array<{ integrationId: string }> = [];
      for (const integrationId of routes) {
        const found = await callActiveExecutor(env, integrationId, "manageInstance", [proof, action, input.body, url.origin],
          local => local.manageInstance(proof, action, input.body, url.origin));
        if (found && "integrationId" in found) integrations.push({ integrationId: found.integrationId });
      }
      await verifyAutomationInstanceRequest(proof, expected);
      return json({ origin: url.origin, workspaceId: body.workspaceId, definitionId: body.definitionId,
        executorPersonId: body.executorPersonId, integrations }, 200, cors);
    }
    if (!("integrationId" in body)) throw new TypeError("Instance route is missing");
    const result = await callActiveExecutor(env, body.integrationId, "manageInstance", [proof, action, input.body, url.origin],
      local => local.manageInstance(proof, action, input.body, url.origin));
    if (!result) return json({ error: "No existing instance is available to this owner and workspace" }, 403, cors);
    if ("ok" in result) return result.ok ? json({ status: result.status, synced: true }, 200, cors)
      : json({ error: result.error }, result.status, cors);
    return json(result, 200, cors);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Instance management is unavailable";
    if (error instanceof ExecutorRpcError) return json({ error: message }, error.status, cors);
    if (error instanceof ExecutorMigrationFencedError) return json({ error: message }, error.status, cors);
    const status = /currently authorized owner/.test(message) ? 403 : /signature|expired|expected scope/.test(message) ? 401
      : /already used|changed|superseded/.test(message) ? 409 : /Too many active/.test(message) ? 429 : 422;
    return json({ error: message }, status, cors);
  }
}
