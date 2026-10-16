import { assertPublicHttpsUrl, type JobPageResult } from "./extraction.ts";
import { MAX_APPLICATION_SOURCE_BYTES, readApplicationSourceData, type ApplicationSourceData } from "../../../src/domain/applicationSourceData.ts";
import { canonicalizeJson, sha256Base64Url } from "../../../src/domain/identityCrypto.ts";

const EXTRACTOR_VERSION = "job-page-v1";
export type ApplicationSourceReferences = { messageIds?: string[]; atsId?: string };

/** Capture only extracted page evidence. Submission labels never enter this module. */
export async function captureApplicationSource(
  workspaceId: string,
  cardId: string,
  eventId: string,
  origin: "website" | "email",
  page: JobPageResult | undefined,
  jobUrl?: string,
  references?: ApplicationSourceReferences,
): Promise<ApplicationSourceData> {
  page = page ? structuredClone(page) : undefined;
  const capturedReferences = captureReferences(references);
  if (page && page.status !== null && page.status >= 200 && page.status < 300 && page.source !== "unavailable" && page.atsId) {
    capturedReferences.atsId = captureReferences({ atsId: page.atsId }).atsId;
  }
  const recordId = await sha256Base64Url(new TextEncoder().encode(canonicalizeJson([workspaceId, eventId, "original"])));
  const sourceUrl = resolveJobUrl(page?.url, jobUrl);

  if (!page || page.status === null || page.status < 200 || page.status >= 300 || page.source === "unavailable") {
    return unavailable(workspaceId, cardId, recordId, origin, sourceUrl, "Original posting page is unavailable", capturedReferences);
  }

  const company = page.company;
  const title = page.role;
  const text = page.body || page.description;
  if (!sourceUrl || !company.trim() || !title.trim() || !text.trim()) {
    return unavailable(workspaceId, cardId, recordId, origin, sourceUrl,
      "Original posting is missing a safe URL, company, title, or text", capturedReferences);
  }

  try {
    const candidate = {
      kind: "application-source-observation" as const,
      version: sourceVersion(capturedReferences),
      recordId,
      workspaceId,
      cardId,
      applicationId: `${workspaceId}:${cardId}`,
      ...capturedReferences,
      observation: {
        phase: "original" as const,
        origin,
        status: "available" as const,
        observedAt: page.fetchedAt,
        jobUrl: sourceUrl,
        company,
        title,
        text,
        extractorVersion: EXTRACTOR_VERSION,
        contentDigest: await sha256Base64Url(new TextEncoder().encode(text)),
      },
    };
    const encoded = canonicalizeJson(candidate);
    if (new TextEncoder().encode(encoded).byteLength > MAX_APPLICATION_SOURCE_BYTES) {
      throw new Error("Original posting exceeds the source record byte limit");
    }
    return readApplicationSourceData(encoded);
  } catch (error) {
    return unavailable(workspaceId, cardId, recordId, origin, sourceUrl, boundedReason(error), capturedReferences);
  }
}

function unavailable(workspaceId: string, cardId: string, recordId: string,
  origin: "website" | "email", jobUrl: string | undefined, reason: string,
  references: ApplicationSourceReferences): ApplicationSourceData {
  const data: ApplicationSourceData = {
    kind: "application-source-observation",
    version: sourceVersion(references),
    recordId,
    workspaceId,
    cardId,
    applicationId: `${workspaceId}:${cardId}`,
    ...references,
    observation: {
      phase: "original",
      origin,
      status: "unavailable",
      observedAt: new Date().toISOString(),
      ...(jobUrl ? { jobUrl } : {}),
      reason: reason.slice(0, 2048),
    },
  };
  return readApplicationSourceData(canonicalizeJson(data));
}

function sourceVersion(references: ApplicationSourceReferences): 1 | 2 {
  return references.messageIds?.length || references.atsId ? 2 : 1;
}

function captureReferences(value: ApplicationSourceReferences | undefined): ApplicationSourceReferences {
  if (value === undefined) return {};
  let snapshot: unknown;
  try { snapshot = structuredClone(value); }
  catch { throw new TypeError("Application source references are not cloneable"); }
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) throw new TypeError("Application source references are invalid");
  const input = snapshot as Record<string, unknown>;
  if (Object.keys(input).some(key => key !== "messageIds" && key !== "atsId")) throw new TypeError("Application source references contain unknown fields");
  const messageIds = input.messageIds;
  if (messageIds !== undefined && (!Array.isArray(messageIds) || messageIds.length > 40 ||
    messageIds.some(id => typeof id !== "string" || id.length < 1 || id.length > 500 || !id.trim()))) {
    throw new TypeError("Application source message references are invalid");
  }
  const atsId = input.atsId;
  if (atsId !== undefined && (typeof atsId !== "string" || atsId.length < 1 || atsId.length > 256 || !atsId.trim())) {
    throw new TypeError("Application source ATS reference is invalid");
  }
  return {
    ...(Array.isArray(messageIds) && messageIds.length ? { messageIds: [...new Set(messageIds as string[])] } : {}),
    ...(typeof atsId === "string" ? { atsId } : {}),
  };
}

function resolveJobUrl(pageUrl: string | undefined, fallbackUrl: string | undefined): string | undefined {
  const candidate = pageUrl || fallbackUrl;
  if (!candidate) return undefined;
  try {
    const normalized = assertPublicHttpsUrl(candidate);
    return normalized.length <= 4096 ? normalized : undefined;
  } catch {
    return undefined;
  }
}

function boundedReason(error: unknown): string {
  const detail = error instanceof Error ? error.message : "Source record validation failed";
  return `Original posting could not be retained: ${detail}`.slice(0, 2048);
}
