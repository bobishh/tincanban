import { DurableObject } from "cloudflare:workers";
import productionWorker, { AutomationCoordinator as ProductionCoordinator, type WorkerEnv } from "./index";
import { MAX_RAW_EMAIL_BYTES } from "./email";

const testAi = {
  async run(_model: string, input: unknown): Promise<unknown> {
    const request = input as { state?: unknown; questions?: Record<string, unknown> };
    const questions = Object.keys(request.questions ?? {});
    if (questions.includes("application_event")) {
      const rejection = /\b(rejected|not moving forward|declined)\b/i.test(String(request.state ?? ""));
      const probabilities = rejection
        ? { new_opportunity: 0, interview: 0, rejected: 0.96, offer: 0, follow_up: 0, unrelated: 0.02, uncertain: 0.02 }
        : { new_opportunity: 0, interview: 0.96, rejected: 0, offer: 0, follow_up: 0.02, unrelated: 0, uncertain: 0.02 };
      return { answers: { application_event: { type: "choice", choice: rejection ? "rejected" : "interview",
        confidence: 0.96, probabilities } } };
    }
    return { answers: {
      ...Object.fromEntries(['company_recognition', 'company_stability', 'stack_fit', 'work_fit'].map(key => [key, {
        type: 'choice', choice: 'unknown', confidence: 1, probabilities: { strong: 0, partial: 0, weak: 0, unknown: 1 },
      }])),
      job_opportunity: { type: "choice", choice: "yes", confidence: 0.96,
        probabilities: { yes: 0.96, no: 0.02, uncertain: 0.02 } },
      role_type: { type: "choice", choice: "backend", confidence: 0.96,
        probabilities: { backend: 0.96, frontend: 0, fullstack: 0, platform_devops: 0, data_ai: 0, mobile: 0, engineering_management: 0, other_unknown: 0.04 } },
      seniority: { type: "choice", choice: "senior", confidence: 0.96,
        probabilities: { intern_junior: 0, middle: 0, senior: 0.96, staff_principal: 0, lead_manager: 0, unknown: 0.04 } },
    } };
  },
};

const provisioningToken = "automation-e2e-provisioning-token-with-at-least-32-bytes";

interface E2EEnv extends WorkerEnv { TEST_CONFIG: DurableObjectNamespace<AutomationE2eConfig> }

export class AutomationE2eConfig extends DurableObject<E2EEnv> {
  async setOwners(value: string): Promise<void> { await this.ctx.storage.put("owners", value); }
  async getOwners(): Promise<string> { return await this.ctx.storage.get<string>("owners") ?? ""; }
  async setIntegrations(value: string): Promise<void> { await this.ctx.storage.put("integrations", value); }
  async getIntegrations(): Promise<string> { return await this.ctx.storage.get<string>("integrations") ?? "[]"; }
}

export class AutomationCoordinator extends ProductionCoordinator {
  constructor(ctx: DurableObjectState, env: WorkerEnv) {
    super(ctx, { ...env, AI: testAi as unknown as Ai });
  }
}

const testWorker: ExportedHandler<E2EEnv> = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/__test/configure") return configureTestIntegration(request, env);
    const testEnv = await withTestConfiguration(env);
    if (url.pathname === "/__test/email") return handleTestEmail(request, testEnv);
    return productionWorker.fetch!(request, testEnv);
  },
  async email(message, env) {
    return productionWorker.email!(message, await withTestConfiguration(env));
  },
};

export default testWorker;

async function handleTestEmail(request: Request, env: WorkerEnv): Promise<Response> {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_RAW_EMAIL_BYTES + 4_096) return json({ error: "Message too large" }, 413);
  let value: unknown;
  try { value = await request.json(); }
  catch { return json({ error: "Invalid JSON" }, 400); }
  if (!value || typeof value !== "object" || Array.isArray(value)) return json({ error: "Invalid test email" }, 400);
  const input = value as Record<string, unknown>;
  if (typeof input.from !== "string" || typeof input.to !== "string" || typeof input.raw !== "string" ||
    new TextEncoder().encode(input.raw).byteLength > MAX_RAW_EMAIL_BYTES) return json({ error: "Invalid test email" }, 400);
  const raw = new TextEncoder().encode(input.raw);
  let rejection: string | undefined;
  await productionWorker.email!({
    from: input.from, to: input.to, rawSize: raw.byteLength,
    raw: new ReadableStream({ start(controller) { controller.enqueue(raw); controller.close(); } }),
    headers: new Headers(),
    setReject(reason) { rejection = reason; },
    async forward() { throw new Error("Test route does not forward mail"); },
    async reply() { throw new Error("Test route does not reply to mail"); },
  } as ForwardableEmailMessage, env);
  return rejection ? json({ accepted: false, reason: rejection }, 403) : json({ accepted: true }, 202);
}

async function configureTestIntegration(request: Request, env: E2EEnv): Promise<Response> {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  let input: unknown;
  try { input = await request.json(); }
  catch { return json({ error: "Invalid JSON" }, 400); }
  if (!input || typeof input !== "object" || Array.isArray(input)) return json({ error: "Invalid integration" }, 400);
  const value = input as Record<string, unknown>;
  const columns = value.columns as Record<string, unknown> | undefined;
  const fieldIds = value.fieldIds as Record<string, unknown> | undefined;
  const expiresAt = value.expiresAt === undefined ? "2099-01-01T00:00:00.000Z"
    : typeof value.expiresAt === "number" ? new Date(value.expiresAt).toISOString()
    : typeof value.expiresAt === "string" ? new Date(value.expiresAt).toISOString() : "";
  if (typeof value.workspaceId !== "string" || !value.workspaceId || typeof value.boardId !== "string" || !columns || !fieldIds ||
    !expiresAt || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now() ||
    ![columns.lead, columns.interview, columns.rejected, fieldIds.company, fieldIds.role, fieldIds.jobUrl].every(item => typeof item === "string" && item)) {
    return json({ error: "Integration scope bindings are incomplete" }, 400);
  }
  const optionalIds: Record<string, string> = {};
  for (const key of ["notes", "sourceText", "roleType", "seniority"] as const) {
    if (typeof fieldIds[key] === "string" && fieldIds[key]) optionalIds[key] = fieldIds[key] as string;
  }
  const integration = {
    id: "e2e", workspaceId: value.workspaceId, scope: { version: 1, boardId: value.boardId,
      columns: { lead: columns.lead, interview: columns.interview, rejected: columns.rejected },
      fieldIds: { company: fieldIds.company, role: fieldIds.role, jobUrl: fieldIds.jobUrl, ...optionalIds },
      expiresAt },
    ...(typeof value.emailAddress === "string" ? { emailAddress: value.emailAddress } : {}),
    allowedForwarders: ["owner@example.test"],
  };
  if (typeof value.ownerPersonId === "string") await env.TEST_CONFIG.getByName("integration").setOwners(value.ownerPersonId);
  await env.TEST_CONFIG.getByName("integration").setIntegrations(JSON.stringify([integration]));
  return json({ integrationId: "e2e", provisioningToken }, 200);
}

async function withTestConfiguration(env: E2EEnv): Promise<WorkerEnv> {
  return { ...env, AI: testAi as unknown as Ai,
    AUTOMATION_OWNER_IDS: await env.TEST_CONFIG.getByName("integration").getOwners(),
    INTEGRATIONS_JSON: await env.TEST_CONFIG.getByName("integration").getIntegrations(), PROVISIONING_TOKEN: provisioningToken };
}

function json(value: unknown, status: number): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
