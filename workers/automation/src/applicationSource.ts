import type { ForwardedMail } from "./email.ts";
import { assertPublicHttpsUrl } from "./extraction.ts";

const MAX_ID_LENGTH = 256;
const MAX_URL_LENGTH = 4_096;
const MAX_COMPANY_LENGTH = 500;
const MAX_ROLE_LENGTH = 500;
const MAX_DESCRIPTION_LENGTH = 20_000;
const MAX_VERSION_LENGTH = 128;
const MAX_MESSAGE_ID_LENGTH = 500;

export interface PostingObservation {
  company?: string;
  role?: string;
  description?: string;
  fetchedAt: string;
  extractionVersion: string;
  jobUrl?: string;
  status?: "available" | "not-found" | "unavailable";
}

export interface ApplicationSourceInput {
  applicationId: string;
  cardId?: string;
  jobUrl: string;
  company: string;
  role: string;
  description: string;
  fetchedAt: string;
  extractionVersion: string;
  atsId?: string;
  messageIds?: string[];
}

export interface ApplicationSource {
  version: 1;
  applicationId: string;
  cardId: string;
  jobUrl: string;
  original: PostingObservation;
  observations: PostingObservation[];
  messageIds?: string[];
  atsId?: string;
}

export type ApplicationSourceCorrelation =
  | { kind: "matched"; cardId: string; method: "thread" | "job-url" | "ats-id" | "company-role" }
  | { kind: "review"; reason: string; candidates: string[] };

/** Create a durable source record with its first retained posting observation. */
export function createApplicationSource(input: ApplicationSourceInput): ApplicationSource {
  const applicationId = requiredText(input.applicationId, "applicationId", MAX_ID_LENGTH);
  const cardId = requiredText(input.cardId ?? applicationId, "cardId", MAX_ID_LENGTH);
  const jobUrl = normalizeJobUrl(input.jobUrl);
  const observation = validateObservation({
    company: input.company,
    role: input.role,
    description: input.description,
    fetchedAt: input.fetchedAt,
    extractionVersion: input.extractionVersion,
    jobUrl,
    status: "available",
  });
  const messageIds = normalizeMessageIds(input.messageIds);
  const atsId = optionalText(input.atsId, "atsId", MAX_ID_LENGTH);

  return {
    version: 1,
    applicationId,
    cardId,
    jobUrl,
    original: { ...observation },
    observations: [{ ...observation }],
    ...(messageIds.length ? { messageIds } : {}),
    ...(atsId ? { atsId } : {}),
  };
}

/** Return a copied record with a distinct observation appended; original evidence stays fixed. */
export function appendPostingObservation(source: ApplicationSource, value: PostingObservation): ApplicationSource {
  assertSource(source);
  const observation = validateObservation(value);
  const observations = source.observations.map(item => ({ ...item }));
  if (!observations.some(item => stableObservation(item) === stableObservation(observation))) {
    observations.push(observation);
  }
  return {
    ...source,
    original: { ...source.original },
    observations,
    ...(source.messageIds ? { messageIds: [...source.messageIds] } : {}),
  };
}

/** Prefer exact retained references; use only immutable original posting fields for context. */
export function correlateApplicationSource(mail: ForwardedMail, sources: ApplicationSource[]): ApplicationSourceCorrelation {
  const incomingIds = new Set([mail.messageId, mail.inReplyTo, ...mail.references]
    .filter((value): value is string => typeof value === "string" && !!value.trim())
    .map(normalizeMessageId));
  const threadMatches = sources.filter(source => (source.messageIds ?? []).some(id => incomingIds.has(normalizeMessageId(id))));
  if (threadMatches.length === 1) return matched(threadMatches[0], "thread");
  if (threadMatches.length > 1) return review("Message thread references multiple applications", threadMatches);

  const incomingUrls = new Set(mail.urls.map(normalizeJobUrlForComparison));
  const urlMatches = sources.filter(source => incomingUrls.has(normalizeJobUrlForComparison(source.jobUrl)));
  if (urlMatches.length === 1) return matched(urlMatches[0], "job-url");
  if (urlMatches.length > 1) return review("Job URL matches multiple applications", urlMatches);

  const context = `${mail.from}\n${mail.subject}\n${mail.text}`.normalize("NFKC").toLocaleLowerCase();
  const atsMatches = sources.filter(source => source.atsId && containsExactToken(context, source.atsId));
  if (atsMatches.length === 1) return matched(atsMatches[0], "ats-id");
  if (atsMatches.length > 1) return review("ATS identifier matches multiple applications", atsMatches);

  const contextMatches = sources.filter(source => {
    const company = normalizePhrase(source.original.company);
    const role = normalizePhrase(source.original.role);
    return company.length >= 3 && role.length >= 3 && context.includes(company) && context.includes(role);
  });
  if (contextMatches.length === 1) return matched(contextMatches[0], "company-role");
  if (contextMatches.length > 1) return review("Company and original role context matches multiple applications", contextMatches);

  const sameCompany = sources.filter(source => {
    const company = normalizePhrase(source.original.company);
    return company.length >= 3 && context.includes(company);
  });
  return review(sameCompany.length ? "Company context does not identify an original role" : "No existing application matched", sameCompany.length ? sameCompany : sources);
}

function matched(source: ApplicationSource, method: "thread" | "job-url" | "ats-id" | "company-role"): ApplicationSourceCorrelation {
  return { kind: "matched", cardId: source.cardId, method };
}

function review(reason: string, sources: ApplicationSource[]): ApplicationSourceCorrelation {
  return { kind: "review", reason, candidates: [...new Set(sources.map(source => source.cardId))] };
}

function assertSource(source: ApplicationSource): void {
  if (!source || source.version !== 1) throw new TypeError("Application source version is unsupported");
  requiredText(source.applicationId, "applicationId", MAX_ID_LENGTH);
  requiredText(source.cardId, "cardId", MAX_ID_LENGTH);
  normalizeJobUrl(source.jobUrl);
  validateObservation(source.original);
  if (!Array.isArray(source.observations) || !source.observations.length) throw new TypeError("Application source observations are required");
  for (const observation of source.observations) validateObservation(observation);
  normalizeMessageIds(source.messageIds);
  optionalText(source.atsId, "atsId", MAX_ID_LENGTH);
}

function validateObservation(value: PostingObservation): PostingObservation {
  if (!value || typeof value !== "object") throw new TypeError("Posting observation is required");
  const fetchedAt = validDate(value.fetchedAt);
  const extractionVersion = requiredText(value.extractionVersion, "extractionVersion", MAX_VERSION_LENGTH);
  const company = optionalText(value.company, "company", MAX_COMPANY_LENGTH);
  const role = optionalText(value.role, "role", MAX_ROLE_LENGTH);
  const description = optionalText(value.description, "description", MAX_DESCRIPTION_LENGTH);
  const jobUrl = value.jobUrl === undefined ? undefined : normalizeJobUrl(value.jobUrl);
  const status = value.status ?? "available";
  if (status !== "available" && status !== "not-found" && status !== "unavailable") {
    throw new TypeError("Posting observation status is invalid");
  }
  if (status === "available" && !company && !role && !description) {
    throw new TypeError("Available posting observation needs source fields");
  }
  return {
    ...(company ? { company } : {}),
    ...(role ? { role } : {}),
    ...(description ? { description } : {}),
    fetchedAt,
    extractionVersion,
    ...(jobUrl ? { jobUrl } : {}),
    status,
  };
}

function validDate(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)
    || !Number.isFinite(Date.parse(value))) {
    throw new TypeError("fetchedAt must be a valid UTC timestamp");
  }
  return new Date(value).toISOString();
}

function normalizeJobUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > MAX_URL_LENGTH) throw new TypeError("Job URL is invalid");
  return assertPublicHttpsUrl(value);
}

function requiredText(value: unknown, name: string, maximum: number): string {
  const normalized = optionalText(value, name, maximum);
  if (!normalized) throw new TypeError(`${name} is required`);
  return normalized;
}

function optionalText(value: unknown, name: string, maximum: number): string {
  if (typeof value !== "string") {
    if (value === undefined || value === null) return "";
    throw new TypeError(`${name} must be text`);
  }
  const normalized = value.trim();
  if (normalized.length > maximum) throw new TypeError(`${name} exceeds its size limit`);
  return normalized;
}

function normalizeMessageIds(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError("messageIds must be an array");
  const ids = value.map(id => requiredText(id, "messageId", MAX_MESSAGE_ID_LENGTH));
  return [...new Set(ids.map(normalizeMessageId))];
}

function normalizeMessageId(value: string): string {
  return value.trim().replace(/^<|>$/g, "").toLocaleLowerCase();
}

function normalizePhrase(value: string | undefined): string {
  return (value ?? "").normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

function normalizeJobUrlForComparison(value: string): string {
  try {
    const url = new URL(normalizeJobUrl(value));
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_.+|gclid|fbclid|mc_cid|mc_eid)$/i.test(key)) url.searchParams.delete(key);
    }
    url.hostname = url.hostname.toLowerCase();
    return url.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

function containsExactToken(text: string, value: string): boolean {
  const token = value.normalize("NFKC").toLocaleLowerCase().trim();
  if (token.length < 3) return false;
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?:$|[^\\p{L}\\p{N}])`, "u").test(text);
}

function stableObservation(observation: PostingObservation): string {
  return JSON.stringify({
    company: observation.company ?? "",
    role: observation.role ?? "",
    description: observation.description ?? "",
    fetchedAt: observation.fetchedAt,
    extractionVersion: observation.extractionVersion,
    jobUrl: observation.jobUrl ?? "",
    status: observation.status ?? "available",
  });
}
