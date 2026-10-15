import { assertPublicHttpsUrl, type JobPageResult } from "./extraction.ts";
import { MAX_APPLICATION_SOURCE_BYTES, readApplicationSourceData, type ApplicationSourceData } from "../../../src/domain/applicationSourceData.ts";
import { canonicalizeJson, sha256Base64Url } from "../../../src/domain/identity.ts";

const EXTRACTOR_VERSION = "job-page-v1";

/** Capture only extracted page evidence. Submission labels never enter this module. */
export async function captureApplicationSource(
  workspaceId: string,
  cardId: string,
  eventId: string,
  origin: "website" | "email",
  page: JobPageResult | undefined,
  jobUrl?: string,
): Promise<ApplicationSourceData> {
  page = page ? structuredClone(page) : undefined;
  const recordId = await sha256Base64Url(new TextEncoder().encode(canonicalizeJson([workspaceId, eventId, "original"])));
  const sourceUrl = resolveJobUrl(page?.url, jobUrl);

  if (!page || page.status === null || page.status < 200 || page.status >= 300 || page.source === "unavailable") {
    return unavailable(workspaceId, cardId, recordId, origin, sourceUrl, "Original posting page is unavailable");
  }

  const company = page.company;
  const title = page.role;
  const text = page.body || page.description;
  if (!sourceUrl || !company.trim() || !title.trim() || !text.trim()) {
    return unavailable(workspaceId, cardId, recordId, origin, sourceUrl,
      "Original posting is missing a safe URL, company, title, or text");
  }

  try {
    const candidate = {
      kind: "application-source-observation" as const,
      version: 1 as const,
      recordId,
      workspaceId,
      cardId,
      applicationId: `${workspaceId}:${cardId}`,
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
    return unavailable(workspaceId, cardId, recordId, origin, sourceUrl, boundedReason(error));
  }
}

function unavailable(workspaceId: string, cardId: string, recordId: string,
  origin: "website" | "email", jobUrl: string | undefined, reason: string): ApplicationSourceData {
  const data: ApplicationSourceData = {
    kind: "application-source-observation",
    version: 1,
    recordId,
    workspaceId,
    cardId,
    applicationId: `${workspaceId}:${cardId}`,
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
