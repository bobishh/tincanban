import { canonicalizeJson, sha256Base64Url } from "../../../src/domain/identityCrypto";
import type { EmployeeProfile } from "../../../src/domain/jobPriority";
import { assertPublicHttpsUrl, type JobPageResult } from "./extraction";
import { readApplicationEventClassification, readOpportunityClassification } from "./clef";
import { parseWebsiteSubmission } from "./intake";
import type { AutomationEvent, AutomationPipelineResult } from "./pipeline";

const maxCommandBytes = 2_097_152;
const sourceEventPattern = /^[A-Za-z0-9_-]{43}$/;

export type ItemCommandEnvelope = {
  integrationId: string;
  sourceEventId: string;
  idempotencyKey: string;
  event: AutomationEvent;
  classification: AutomationPipelineResult;
};

export type PreparedItemCommand = {
  eventId: string;
  source: AutomationEvent["source"];
  sourceId: string;
  idempotencyKey: string;
  bodyHash: string;
  event: AutomationEvent;
  classification: AutomationPipelineResult;
};

/** Normalize and validate producer output before it enters the durable event queue. */
export async function prepareItemCommand(value: unknown, expectedIntegrationId: string): Promise<PreparedItemCommand> {
  const envelope = record(value, "Item command must be an object");
  exactKeys(envelope, ["integrationId", "sourceEventId", "idempotencyKey", "event", "classification"], "Item command has unsupported fields");
  const integrationId = boundedText(envelope.integrationId, "integrationId", 128);
  if (!integrationId || integrationId !== expectedIntegrationId) throw new TypeError("Item command integration does not match authenticated caller");
  const sourceEventId = boundedText(envelope.sourceEventId, "sourceEventId", 128);
  if (!sourceEventPattern.test(sourceEventId)) throw new TypeError("sourceEventId must be the stable intake event digest");
  const idempotencyKey = boundedText(envelope.idempotencyKey, "idempotencyKey", 256);
  if (!sourceEventPattern.test(idempotencyKey)) throw new TypeError("idempotencyKey must be the stable intake payload digest");
  const event = normalizeEvent(envelope.event);
  if (await sourceBodyHash(event) !== idempotencyKey) throw new TypeError("idempotencyKey does not match the original intake payload");
  const classification = validateItemCommandClassification(envelope.classification, event, []);
  const canonical = canonicalizeJson({ integrationId, sourceEventId, idempotencyKey, event, classification });
  if (new TextEncoder().encode(canonical).byteLength > maxCommandBytes) throw new TypeError("Item command exceeds the size limit");
  return { eventId: sourceEventId, source: event.source, sourceId: sourceEventId, idempotencyKey,
    bodyHash: await sha256Base64Url(new TextEncoder().encode(canonical)), event, classification };
}

async function sourceBodyHash(event: AutomationEvent): Promise<string> {
  const bytes = event.source === "website"
    ? new TextEncoder().encode(JSON.stringify(event.submission))
    : decodeBase64Url(event.rawMime);
  return sha256Base64Url(bytes);
}

/** Re-derive policy-sensitive priority against the currently admitted board before command application. */
export function revalidateItemCommandClassification(value: AutomationPipelineResult,
  bands?: Array<{ optionId: string; minScore: number }>, employeeProfile?: EmployeeProfile): AutomationPipelineResult {
  const decision = value.decision;
  const opportunity = value.opportunity;
  return {
    ...value,
    ...(opportunity ? { opportunity: readOpportunityClassification(opportunity, bands, employeeProfile) } : {}),
    ...(decision && "relevance" in decision ? { decision: readOpportunityClassification(decision, bands, employeeProfile) }
      : decision && "event" in decision ? { decision: readApplicationEventClassification(decision) } : {}),
  };
}

export function validateItemCommandClassification(value: unknown, event: AutomationEvent,
  bands?: Array<{ optionId: string; minScore: number }>, employeeProfile?: EmployeeProfile): AutomationPipelineResult {
  return revalidateItemCommandClassification(normalizeClassification(value, normalizeEvent(event)), bands, employeeProfile);
}

function normalizeEvent(value: unknown): AutomationEvent {
  const input = record(value, "Automation event must be an object");
  if (input.source !== "website" && input.source !== "email") throw new TypeError("Automation event source is unsupported");
  const receivedAt = boundedText(input.receivedAt, "receivedAt", 64);
  if (!Number.isFinite(Date.parse(receivedAt))) throw new TypeError("Automation event receivedAt is invalid");
  if (input.source === "website") {
    exactKeys(input, ["source", "receivedAt", "submission"], "Website event has unsupported fields");
    const submission = record(input.submission, "Website submission is invalid");
    const submissionKeys = ["message", "contact", "company", "role", "jobUrl"];
    if (Object.keys(submission).some((key) => !submissionKeys.includes(key)) ||
      ["message", "contact", "company", "role"].some((key) => !(key in submission))) {
      throw new TypeError("Website submission has an invalid shape");
    }
    const normalized = parseWebsiteSubmission({ ...submission, humanCheckToken: "", humanCheckAnswer: "" });
    const { humanCheckToken: _token, humanCheckAnswer: _answer, ...safeSubmission } = normalized;
    return { source: "website", receivedAt, submission: safeSubmission };
  }
  exactKeys(input, ["source", "receivedAt", "message", "rawMime"], "Email event has unsupported fields");
  const message = normalizeMail(input.message);
  const rawMime = boundedText(input.rawMime, "rawMime", 1_398_102);
  const decodedMime = decodeBase64Url(rawMime);
  if (!decodedMime.byteLength || encodeBase64Url(decodedMime) !== rawMime) throw new TypeError("rawMime is not canonical base64url data");
  return { source: "email", receivedAt, message, rawMime };
}

function normalizeMail(value: unknown): Extract<AutomationEvent, { source: "email" }>["message"] {
  const mail = record(value, "Forwarded message is invalid");
  exactKeys(mail, ["messageId", "inReplyTo", "references", "from", "to", "subject", "text", "date", "urls", "confirmation", "attachments"],
    "Forwarded message has unsupported fields");
  const nullable = (candidate: unknown, name: string, limit: number): string | null => candidate === null ? null : boundedText(candidate, name, limit);
  const references = stringList(mail.references, "references", 40, 500);
  const urls = stringList(mail.urls, "urls", 50, 2_048);
  if (typeof mail.confirmation !== "boolean") throw new TypeError("Forwarded message confirmation flag is invalid");
  if (!Array.isArray(mail.attachments) || mail.attachments.length > 10) throw new TypeError("Forwarded message attachments are invalid");
  const attachments = mail.attachments.map((candidate) => {
    const attachment = record(candidate, "Forwarded attachment is invalid");
    exactKeys(attachment, ["filename", "contentType", "size"], "Forwarded attachment has unsupported fields");
    const size = attachment.size;
    if (!Number.isSafeInteger(size) || (size as number) < 0 || (size as number) > 1_048_576) throw new TypeError("Forwarded attachment size is invalid");
    return { filename: nullable(attachment.filename, "attachment filename", 256),
      contentType: boundedText(attachment.contentType, "attachment content type", 128), size: size as number };
  });
  return { messageId: nullable(mail.messageId, "messageId", 500), inReplyTo: nullable(mail.inReplyTo, "inReplyTo", 500), references,
    from: boundedText(mail.from, "from", 500), to: boundedText(mail.to, "to", 500), subject: boundedText(mail.subject, "subject", 500),
    text: boundedText(mail.text, "text", 64_000), date: nullable(mail.date, "date", 128), urls, confirmation: mail.confirmation, attachments };
}

function normalizeClassification(value: unknown, event: AutomationEvent): AutomationPipelineResult {
  const result = record(value, "Automation classification is invalid");
  const allowed = ["status", "reason", "source", "extraction", "opportunity", "decision"];
  if (Object.keys(result).some((key) => !allowed.includes(key))) throw new TypeError("Automation classification has unsupported fields");
  if (result.status !== "review") throw new TypeError("Automation classification status is invalid");
  const reason = boundedText(result.reason, "classification reason", 1_000);
  const source = record(result.source, "Classification source is invalid");
  const expectedSource = event.source;
  if (source.type !== expectedSource || source.receivedAt !== event.receivedAt) throw new TypeError("Classification does not match its source event");
  const allowedSourceKeys = expectedSource === "email" ? ["type", "receivedAt", "messageId"] : ["type", "receivedAt", "jobUrl"];
  if (Object.keys(source).some((key) => !allowedSourceKeys.includes(key)) ||
    allowedSourceKeys.slice(0, 2).some((key) => !(key in source)) || expectedSource === "email" && !("messageId" in source)) {
    throw new TypeError("Classification source has unsupported fields");
  }
  const normalizedSource: AutomationPipelineResult["source"] = expectedSource === "email"
    ? { type: "email", receivedAt: event.receivedAt, messageId: nullableText(source.messageId, "messageId", 500) }
    : { type: "website", receivedAt: event.receivedAt,
      ...(source.jobUrl === undefined ? {} : { jobUrl: assertPublicHttpsUrl(boundedText(source.jobUrl, "source job URL", 2_048)) }) };
  if (expectedSource === "email" && normalizedSource.type === "email" && normalizedSource.messageId !== event.message.messageId) {
    throw new TypeError("Classification message identity differs from its source event");
  }
  const output: AutomationPipelineResult = { status: "review", reason, source: normalizedSource };
  if (result.extraction !== undefined) {
    output.extraction = normalizeExtraction(result.extraction);
    if (event.source === "website" && (!event.submission.jobUrl ||
      assertPublicHttpsUrl(event.submission.jobUrl) !== output.extraction.url || normalizedSource.type !== "website" ||
      normalizedSource.jobUrl !== output.extraction.finalUrl)) {
      throw new TypeError("Website extraction does not match its submitted URL evidence");
    }
  } else if (event.source === "website" && normalizedSource.type === "website" && normalizedSource.jobUrl !== undefined) {
    throw new TypeError("Website source URL requires matching extraction evidence");
  }
  if (result.opportunity !== undefined) output.opportunity = readOpportunityClassification(result.opportunity, []);
  if (result.decision !== undefined) {
    const decision = record(result.decision, "Classification decision is invalid");
    output.decision = "relevance" in decision ? readOpportunityClassification(decision, []) : readApplicationEventClassification(decision);
  }
  if (output.opportunity && !output.decision) throw new TypeError("Opportunity classification requires a source decision");
  return output;
}

function normalizeExtraction(value: unknown): JobPageResult {
  const page = record(value, "Job extraction is invalid");
  const keys = ["url", "finalUrl", "status", "contentType", "fetchedAt", "company", "role", "title", "atsId", "description", "body", "source"];
  if (Object.keys(page).some((key) => !keys.includes(key)) || keys.some((key) => key !== "atsId" && !(key in page))) {
    throw new TypeError("Job extraction has an invalid shape");
  }
  const status = page.status;
  if (!(status === null || Number.isSafeInteger(status) && (status as number) >= 100 && (status as number) <= 599)) {
    throw new TypeError("Job extraction status is invalid");
  }
  const contentType = nullableText(page.contentType, "content type", 256);
  const fetchedAt = boundedText(page.fetchedAt, "fetchedAt", 64);
  if (!Number.isFinite(Date.parse(fetchedAt))) throw new TypeError("Job extraction time is invalid");
  if (!["jobposting", "opengraph", "html", "unavailable"].includes(String(page.source))) throw new TypeError("Job extraction source is invalid");
  return { url: assertPublicHttpsUrl(boundedText(page.url, "job URL", 2_048)),
    finalUrl: assertPublicHttpsUrl(boundedText(page.finalUrl, "final job URL", 2_048)), status: status as number | null,
    contentType, fetchedAt, company: boundedText(page.company, "extracted company", 256), role: boundedText(page.role, "extracted role", 256),
    title: boundedText(page.title, "extracted title", 1_000), ...(page.atsId === undefined ? {} : { atsId: boundedText(page.atsId, "ATS ID", 256) }),
    description: boundedText(page.description, "extracted description", 40_000), body: boundedText(page.body, "extracted body", 64_000),
    source: page.source as JobPageResult["source"] };
}

function record(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(message);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: string[], message: string): void {
  if (Object.keys(value).sort().join("\0") !== [...expected].sort().join("\0")) throw new TypeError(message);
}

function boundedText(value: unknown, name: string, maxBytes: number): string {
  if (typeof value !== "string" || new TextEncoder().encode(value).byteLength > maxBytes) throw new TypeError(`${name} is invalid`);
  return value;
}

function nullableText(value: unknown, name: string, maxBytes: number): string | null {
  return value === null ? null : boundedText(value, name, maxBytes);
}

function stringList(value: unknown, name: string, maxItems: number, maxBytes: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new TypeError(`${name} is invalid`);
  return value.map((item) => boundedText(item, name, maxBytes));
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new TypeError("rawMime is not base64url data");
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < value.length; index += 0x8000) binary += String.fromCharCode(...value.subarray(index, index + 0x8000));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
