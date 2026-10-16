import { parseAutomationDefinition, type AutomationDefinition } from "../../../src/domain/automationContract";
import type { EmployeeProfile } from "../../../src/domain/jobPriority";
import { assertPublicHttpsUrl } from "./extraction";
import type { ForwardedMail } from "./email";
import { parseWebsiteSubmission } from "./intake";
import type { AutomationEvent, AutomationPipelineResult } from "./pipeline";
import { runRegisteredAutomation } from "./handlers";
import { runPipeline } from "./pipeline";
import { authorizeInternalRequest } from "./executorClient";
import { json, readJson } from "./http";
import type { DecisionAi } from "./clef";
import type { WorkerEnv } from "./index";

const MAX_CLASSIFICATION_BYTES = 2 * 1024 * 1024;
const MAX_RAW_MIME_BASE64URL = 1_398_102;

/** Private, bounded classification bridge. This accepts supported intake events only, never prompts. */
export async function handleClassificationRequest(request: Request, env: WorkerEnv): Promise<Response> {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!authorizeInternalRequest(request, env.CLASSIFICATION_SERVICE_TOKEN)) return json({ error: "Unauthorized" }, 401);

  const input = await readJson(request, MAX_CLASSIFICATION_BYTES);
  if (!hasOnlyKeys(input, ["event", "context"]) || !Object.hasOwn(input, "event") || !Object.hasOwn(input, "context")) {
    throw new TypeError("Classification request has unsupported fields");
  }
  const result = await classifyExecutorEvent(input.event, input.context, env.AI);
  return json(result, 200);
}

export type ClassificationContext = {
  definition?: AutomationDefinition;
  employeeProfile?: EmployeeProfile;
  priorityBands?: Array<{ optionId: string; minScore: number }>;
};

/** Shared by private HTTP ingress and the Durable Object's bounded outbox drain. */
export async function classifyExecutorEvent(eventValue: unknown, contextValue: unknown, ai: DecisionAi): Promise<AutomationPipelineResult> {
  const event = parseEvent(eventValue);
  const context = parseContext(contextValue);
  return context.definition
    ? runRegisteredAutomation(context.definition, event, ai, context.employeeProfile, context.priorityBands)
    : runPipeline(event, ai, fetch, context.employeeProfile, context.priorityBands);
}

function parseEvent(value: unknown): AutomationEvent {
  if (!isRecord(value) || typeof value.source !== "string" || typeof value.receivedAt !== "string" || !Number.isFinite(Date.parse(value.receivedAt))) {
    throw new TypeError("Classification event is invalid");
  }
  if (value.source === "website" && hasOnlyKeys(value, ["source", "receivedAt", "submission"])) {
    const submission = parseWebsiteSubmission(value.submission);
    const jobUrl = submission.jobUrl ? assertPublicHttpsUrl(submission.jobUrl) : undefined;
    return { source: "website", receivedAt: value.receivedAt, submission: {
      message: submission.message,
      contact: submission.contact,
      company: submission.company,
      role: submission.role,
      ...(jobUrl ? { jobUrl } : {}),
    } };
  }
  if (value.source === "email" && hasOnlyKeys(value, ["source", "receivedAt", "message", "rawMime"])) {
    if (typeof value.rawMime !== "string" || value.rawMime.length > MAX_RAW_MIME_BASE64URL || !/^[A-Za-z0-9_-]*$/.test(value.rawMime)) {
      throw new TypeError("Classification email evidence is invalid");
    }
    return { source: "email", receivedAt: value.receivedAt, message: parseMail(value.message), rawMime: value.rawMime };
  }
  throw new TypeError("Classification event source or shape is unsupported");
}

function parseMail(value: unknown): ForwardedMail {
  const keys = ["messageId", "inReplyTo", "references", "from", "to", "subject", "text", "date", "urls", "confirmation", "attachments"];
  if (!isRecord(value) || !hasOnlyKeys(value, keys) || !Array.isArray(value.references) || value.references.length > 40 ||
    !Array.isArray(value.urls) || value.urls.length > 50 || !Array.isArray(value.attachments) || value.attachments.length > 10 ||
    typeof value.confirmation !== "boolean") throw new TypeError("Classification email message is invalid");
  const optionalToken = (input: unknown, maximum: number): string | null => input === null ? null : boundedString(input, maximum);
  const references = value.references.map(entry => boundedString(entry, 500));
  const urls = value.urls.map(entry => boundedString(entry, 2_048));
  const attachments = value.attachments.map(entry => {
    if (!isRecord(entry) || !hasOnlyKeys(entry, ["filename", "contentType", "size"]) || !Number.isSafeInteger(entry.size) || (entry.size as number) < 0 || (entry.size as number) > 1_048_576) {
      throw new TypeError("Classification email attachment is invalid");
    }
    return { filename: optionalToken(entry.filename, 256), contentType: boundedString(entry.contentType, 128), size: entry.size as number };
  });
  return {
    messageId: optionalToken(value.messageId, 500),
    inReplyTo: optionalToken(value.inReplyTo, 500),
    references,
    from: boundedString(value.from, 500),
    to: boundedString(value.to, 500),
    subject: boundedString(value.subject, 500),
    text: boundedString(value.text, 64_000),
    date: optionalToken(value.date, 128),
    urls,
    confirmation: value.confirmation,
    attachments,
  };
}

function parseProfile(value: unknown): EmployeeProfile {
  if (!isRecord(value) || !hasOnlyKeys(value, ["stack", "work_profile"])) throw new TypeError("Employee profile is invalid");
  return { stack: boundedString(value.stack, 16_384), work_profile: boundedString(value.work_profile, 16_384) };
}

function parseContext(value: unknown): ClassificationContext {
  if (!isRecord(value) || !hasOnlyKeys(value, ["definition", "employeeProfile", "priorityBands"])) {
    throw new TypeError("Classification context is invalid");
  }
  return {
    ...(value.definition === undefined ? {} : { definition: parseAutomationDefinition(value.definition) }),
    ...(value.employeeProfile === undefined ? {} : { employeeProfile: parseProfile(value.employeeProfile) }),
    ...(value.priorityBands === undefined ? {} : { priorityBands: parsePriorityBands(value.priorityBands) }),
  };
}

function parsePriorityBands(value: unknown): Array<{ optionId: string; minScore: number }> {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) throw new TypeError("Priority bands are invalid");
  const seen = new Set<string>();
  return value.map(entry => {
    if (!isRecord(entry) || !hasOnlyKeys(entry, ["optionId", "minScore"]) || typeof entry.optionId !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(entry.optionId) || seen.has(entry.optionId) || typeof entry.minScore !== "number" ||
      !Number.isFinite(entry.minScore) || entry.minScore < 0 || entry.minScore > 10) throw new TypeError("Priority bands are invalid");
    seen.add(entry.optionId);
    return { optionId: entry.optionId, minScore: entry.minScore };
  });
}

function boundedString(value: unknown, maximumBytes: number): string {
  if (typeof value !== "string" || new TextEncoder().encode(value).byteLength > maximumBytes) throw new TypeError("Classification field is invalid");
  return value;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
