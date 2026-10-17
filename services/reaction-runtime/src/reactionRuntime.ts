import { createHash } from "node:crypto";
import ts from "typescript";
import { CLEF_MODEL, classifyApplicationEvent, classifyOpportunity, type ApplicationEventClassification,
  type OpportunityClassification, type DecisionAi } from "../../../workers/automation/src/clef.ts";
import type { EmployeeProfile } from "../../../src/domain/jobPriority.ts";

export const reactionJsonLimit = 1_048_576;

export type ReactionSignal = { id: string; source: string; body: string; payload: unknown };
export type ReactionRequest = {
  version: 1;
  runId: string;
  sourceDigest: string;
  signals: ReactionSignal[];
  classification?: unknown;
  participant: { integrationId: string; epoch: number };
  capabilities: { operations: string[]; targets: string[] };
};
export type ReactionCommandResult = {
  status: string;
  changeHash?: string;
  storageReceipt?: unknown;
  [key: string]: unknown;
};
export type ReactionCommandIdentity = { runId: string; sourceDigest: string; slot: number };
export interface ReactionParticipant {
  enqueueItemCommand(commandId: string, command: unknown, identity: ReactionCommandIdentity): Promise<unknown>;
  getItemCommandResult(commandId: string): Promise<ReactionCommandResult | null>;
  flushPendingCommands?(): Promise<void>;
  getOrCreateOpportunity(evidenceKey: string, inputHash: string, compute: () => Promise<OpportunityClassification>): Promise<OpportunityClassification>;
  getOrCreateApplicationEvent(evidenceKey: string, inputHash: string, compute: () => Promise<ApplicationEventClassification>): Promise<ApplicationEventClassification>;
  classificationContext(): Promise<{ employeeProfile?: EmployeeProfile; priorityBands?: Array<{ optionId: string; minScore: number }> }>;
}
export interface ReactionContext {
  enqueueItemCommand(command: unknown): Promise<{ commandId: string; status: string; error?: string }>;
  getItemCommandResult(commandId: string): Promise<ReactionCommandResult | null>;
  classifyApplicationEvent(state: string): Promise<ApplicationEventClassification>;
  classifyOpportunity(state: string, profile?: EmployeeProfile, bands?: Array<{ optionId: string; minScore: number }>): Promise<OpportunityClassification>;
}
export type ReactionOutput = {
  version: 1;
  status: "completed" | "pending" | "failed";
  result?: Record<string, unknown>;
  commands: Array<{ commandId: string; status: string; changeHash?: string; storageReceipt?: unknown }>;
  error?: string;
};

/** Run a self-contained TypeScript reaction against a host-provided, capability-limited participant port. */
export async function runReaction(request: ReactionRequest & { source: string }, participant: ReactionParticipant): Promise<ReactionOutput> {
  validateRequest(request);
  const sourceBytes = Buffer.byteLength(request.source, "utf8");
  if (sourceBytes > reactionJsonLimit) throw new TypeError("Reaction source exceeds its size bound");
  const actualSourceDigest = createHash("sha256").update(request.source, "utf8").digest("hex");
  if (actualSourceDigest !== request.sourceDigest) throw new TypeError("Reaction source digest does not match its immutable snapshot");
  const input = { version: request.version, runId: request.runId, sourceDigest: request.sourceDigest,
    signals: request.signals, ...(request.classification === undefined ? {} : { classification: request.classification }),
    participant: request.participant, capabilities: request.capabilities };
  assertBoundedJson(input, "Reaction input");
  const moduleSource = compileReaction(request.source, request.capabilities.operations);
  const commands: ReactionOutput["commands"] = [];
  let commandFailure: string | undefined;
  const api: ReactionContext = {
    async enqueueItemCommand(command: unknown) {
      if (!request.capabilities.operations.includes("item-command")) throw new Error("Reaction capability denied: item-command");
      if (!request.capabilities.targets.includes(request.participant.integrationId)) {
        throw new Error("Reaction target capability denied for this participant");
      }
      if (commands.length >= 100) throw new TypeError("Reaction command count exceeds its bound");
      assertBoundedJson(command, "Reaction command");
      const slot = commands.length;
      const stableId = await stableCommandId(request.runId, request.sourceDigest, slot);
      const pending = { commandId: stableId, status: "pending" };
      commands.push(pending);
      try {
        const result = await participant.enqueueItemCommand(stableId, command,
          { runId: request.runId, sourceDigest: request.sourceDigest, slot });
        const record = object(result, "Participant enqueue result is invalid");
        pending.status = typeof record.status === "string" ? record.status : record.error ? "failed" : "pending";
        if (pending.status === "review") {
          pending.status = "failed";
          commandFailure = "review_required";
        }
        if (typeof record.error === "string") commandFailure = record.error.slice(0, 2_000);
        return { commandId: stableId, status: pending.status, ...(typeof record.error === "string" ? { error: record.error.slice(0, 2_000) } : {}) };
      } catch {
        // The journal may have accepted this exact ID and payload before the response was lost.
        return { commandId: stableId, status: "pending" };
      }
    },
    async getItemCommandResult(commandId: string) {
      const record = commands.find(command => command.commandId === commandId);
      if (!record) throw new TypeError("Reaction requested a command outside this run");
      let result: ReactionCommandResult | null;
      try { result = await participant.getItemCommandResult(commandId); }
      catch { return null; }
      if (result) {
        if (result.status === "applied" && (typeof result.changeHash !== "string" || result.storageReceipt === undefined)) {
          throw new Error("Participant applied result is missing its verified storage receipt");
        }
        record.status = result.status === "review" ? "failed" : result.status;
        if (result.status === "review") commandFailure = "review_required";
        if (result.changeHash) record.changeHash = result.changeHash;
        if (result.storageReceipt !== undefined) record.storageReceipt = result.storageReceipt;
      }
      return result;
    },
    classifyApplicationEvent: async state => {
      requireCapability(request, "clef.application-event");
      const inputHash = digestJson({ state });
      const evidenceKey = await stableEvidenceKey(request, "application-event", inputHash);
      return participant.getOrCreateApplicationEvent(evidenceKey, inputHash, () => classifyApplicationEvent(createReactionAi(), state));
    },
    classifyOpportunity: async (state, profile, bands) => {
      requireCapability(request, "clef.opportunity");
      const context = profile && bands ? { employeeProfile: profile, priorityBands: bands } : await participant.classificationContext();
      const selectedProfile = profile ?? context.employeeProfile;
      const selectedBands = bands ?? context.priorityBands;
      const inputHash = digestJson({ state, profile: selectedProfile ?? null, bands: selectedBands ?? null });
      const evidenceKey = await stableEvidenceKey(request, "opportunity", inputHash);
      return participant.getOrCreateOpportunity(evidenceKey, inputHash,
        () => classifyOpportunity(createReactionAi(), state, selectedProfile, selectedBands));
    },
  };
  let result: unknown;
  try {
    const url = `data:text/javascript;base64,${Buffer.from(moduleSource).toString("base64")}`;
    const loaded = await import(url) as { default?: unknown };
    if (typeof loaded.default !== "function") throw new TypeError("Reaction must export a default function");
    result = await loaded.default(input, Object.freeze(api));
  } catch (error) {
    return { version: 1, status: "failed", commands, error: boundedError(error) };
  }
  assertBoundedJson(result, "Reaction result");
  if (result !== undefined && (result === null || typeof result !== "object" || Array.isArray(result))) {
    throw new TypeError("Reaction result must be a JSON object");
  }
  if (participant.flushPendingCommands && commands.some(command => command.status !== "failed" &&
    (command.status !== "applied" || !command.changeHash || command.storageReceipt === undefined))) {
    try { await participant.flushPendingCommands(); } catch { /* Durable queue remains available for the next retry. */ }
  }
  for (const command of commands) {
    if (command.status === "applied" && command.changeHash && command.storageReceipt !== undefined) continue;
    try { await api.getItemCommandResult(command.commandId); } catch { /* Preserve pending journal identity for a retry. */ }
  }
  const pending = commands.some(command => command.status !== "applied" || !command.changeHash || command.storageReceipt === undefined);
  const failed = commands.some(command => command.status === "failed");
  const output: ReactionOutput = { version: 1, status: failed ? "failed" : pending ? "pending" : "completed", commands,
    ...(result === undefined ? {} : { result: result as Record<string, unknown> }),
    ...(commandFailure ? { error: commandFailure } : {}) };
  assertBoundedJson(output, "Reaction output");
  return output;
}

export function createReactionAi(): DecisionAi {
  return {
    async run(model, input) {
      if (model !== CLEF_MODEL) throw new Error("Reaction CLEF model is not supported");
      const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
      const token = process.env.CLOUDFLARE_API_TOKEN;
      if (!accountId || !/^[a-f0-9]{32}$/.test(accountId) || !token || token.length < 20) {
        throw new Error("Reaction CLEF credential is unavailable");
      }
      const body = JSON.stringify(input);
      if (Buffer.byteLength(body, "utf8") > reactionJsonLimit) throw new TypeError("CLEF request exceeds its JSON bound");
      const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(90_000),
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body,
      });
      if (!response.ok) throw new Error(`Reaction CLEF request failed (HTTP ${response.status})`);
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > reactionJsonLimit) throw new TypeError("CLEF response exceeds its JSON bound");
      const payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as { success?: unknown; result?: unknown };
      if (payload.success === false) throw new Error("Reaction CLEF request failed");
      return payload.result ?? payload;
    },
  };
}

function compileReaction(source: string, capabilities: string[] = []): string {
  const file = ts.createSourceFile("reaction.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if (file.parseDiagnostics.length) throw new TypeError("Reaction source has invalid TypeScript syntax");
  const visit = (node: ts.Node) => {
    if (node.kind === ts.SyntaxKind.ImportDeclaration || node.kind === ts.SyntaxKind.ImportEqualsDeclaration) {
      throw new TypeError("Reaction imports must be resolved into the pinned image before execution");
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      throw new TypeError("Reaction imports must be resolved into the pinned image before execution");
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require") {
      throw new TypeError("Reaction imports must be resolved into the pinned image before execution");
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "Math" && node.expression.name.text === "random") {
      throw new TypeError("Reaction cannot use nondeterministic Math.random");
    }
    if (ts.isIdentifier(node) && ["process", "require", "Date", "crypto", "performance", "globalThis", "setTimeout", "setInterval", "eval", "Function"].includes(node.text)) {
      throw new TypeError(`Reaction cannot access ${node.text}`);
    }
    if (ts.isIdentifier(node) && node.text === "fetch" && !capabilities.includes("job-page-fetch")) {
      throw new TypeError("Reaction capability denied: job-page-fetch");
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }, reportDiagnostics: true });
  if (output.diagnostics?.some(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error)) throw new TypeError("Reaction source could not be compiled");
  return output.outputText;
}

async function stableCommandId(runId: string, sourceDigest: string, index: number): Promise<string> {
  return createHash("sha256").update(`${runId}\0${sourceDigest}\0${index}`).digest("base64url");
}
async function stableEvidenceKey(request: ReactionRequest, kind: string, inputHash: string): Promise<string> {
  return createHash("sha256").update(`${request.runId}\0${request.sourceDigest}\0${kind}\0${inputHash}`).digest("hex");
}
function digestJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function validateRequest(request: ReactionRequest & { source: string }): void {
  if (request.version !== 1 || !/^[A-Za-z0-9_-]{1,128}$/.test(request.runId) || !/^[a-f0-9]{64}$/.test(request.sourceDigest)) {
    throw new TypeError("Reaction request identity is invalid");
  }
  if (!Array.isArray(request.signals) || request.signals.length > 100 || !Array.isArray(request.capabilities?.operations) ||
    !Array.isArray(request.capabilities?.targets) || !/^[A-Za-z0-9_-]{1,128}$/.test(request.participant?.integrationId) ||
    !Number.isSafeInteger(request.participant?.epoch) || request.participant.epoch < 1) throw new TypeError("Reaction request shape is invalid");
}
function assertBoundedJson(value: unknown, label: string): void {
  let encoded: string | undefined;
  try { encoded = JSON.stringify(value); } catch { throw new TypeError(`${label} must be bounded JSON`); }
  if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > reactionJsonLimit) throw new TypeError(`${label} exceeds its JSON bound`);
}
function object(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(message);
  return value as Record<string, unknown>;
}
function boundedError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
}
function requireCapability(request: ReactionRequest, capability: string): void {
  if (!request.capabilities.operations.includes(capability)) throw new Error(`Reaction capability denied: ${capability}`);
}
