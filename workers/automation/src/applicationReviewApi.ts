import { automationBodyHash } from "../../../src/domain/automationProtocol";
import { parseApplicationReviewBody, type ApplicationReviewAction } from "../../../src/domain/applicationReviewData";
import { verifyApplicationReviewRequest, type ApplicationReviewRequestProof } from "../../../src/domain/applicationReviewProtocol";
import { parseIntegrations } from "./configuration";
import type { WorkerEnv } from "./index";
import { privateEmailRoutes } from "./emailRoutes";
import { json, readJson } from "./http";

/** Review existing data under current workspace Owner authority; deployment allowlists only bootstrap enrollment. */
export async function handleApplicationReviewApi(request: Request, env: WorkerEnv, cors: Headers): Promise<Response> {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/v2\/application-review\/(discover|list|review|bind|retry|retry-unbound)$/);
  if (!match) return json({ error: "Not found" }, 404, cors);
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, cors);
  if (!env.EVENT_STORAGE_SECRET || !env.IDENTITY_STORAGE_SECRET) return json({ error: "Automation storage is not configured" }, 503, cors);
  const action = match[1] as ApplicationReviewAction;
  let input;
  let body;
  try {
    input = await readJson(request, 384 * 1024);
    if (Object.keys(input).length !== 2 || !Object.hasOwn(input, "reviewRequest") || !Object.hasOwn(input, "body")) {
      throw new TypeError("Application review requires exactly its request proof and body");
    }
    body = parseApplicationReviewBody(action, input.body);
  } catch (error) { return json({ error: error instanceof Error ? error.message : "Invalid application review body" }, 400, cors); }
  const expected = { action, origin: url.origin, workspaceId: body.workspaceId, definitionId: body.definitionId,
    integrationId: "integrationId" in body ? body.integrationId : null, bodyHash: await automationBodyHash(input.body) };
  try { await verifyApplicationReviewRequest(input.reviewRequest, expected); }
  catch { return json({ error: "Application review signature is expired, invalid or targets another operation" }, 401, cors); }
  try {
    const proof = input.reviewRequest as ApplicationReviewRequestProof;
    if (action === "discover") {
      const routes = new Set([body.definitionId,
        ...parseIntegrations(env).filter(value => value.workspaceId === body.workspaceId).map(value => value.id),
        ...privateEmailRoutes(env).map(value => value.id)]);
      if (routes.size > 64) throw new Error("Application review discovery exceeds the configured route limit");
      const integrations: Array<{ integrationId: string; personId: string }> = [];
      for (const id of routes) {
        try {
          const identity = await env.AUTOMATION.getByName(id).applicationReview(proof, action, input.body, url.origin);
          if (identity && typeof identity === "object" && "integrationId" in identity && "personId" in identity &&
            typeof identity.integrationId === "string" && typeof identity.personId === "string") {
            integrations.push({ integrationId: identity.integrationId, personId: identity.personId });
          }
        } catch (error) {
          if (!(error instanceof Error) || !/currently authorized owner|definition does not match/.test(error.message)) throw error;
        }
      }
      await verifyApplicationReviewRequest(proof, expected);
      if (!integrations.length) return json({ error: "No application review route is available to this owner and workspace" }, 403, cors);
      return json({ origin: url.origin, workspaceId: body.workspaceId, definitionId: body.definitionId, integrations }, 200, cors);
    }
    if (!("integrationId" in body)) throw new TypeError("Application review integration is missing");
    return json(await env.AUTOMATION.getByName(body.integrationId).applicationReview(proof, action, input.body, url.origin), 200, cors);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Application review is unavailable";
    const status = /currently authorized owner/.test(message) ? 403 : /signature|expired|expected scope/.test(message) ? 401
      : /already used|changed|superseded/.test(message) ? 409 : /Too many active/.test(message) ? 429 : 422;
    return json({ error: message }, status, cors);
  }
}
