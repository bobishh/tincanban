import { parseApplicationSourceData, type ApplicationSourceData } from "../../../src/domain/applicationSourceData.ts";
import { correlateApplication, type ApplicationCandidate, type CorrelationResult, type ForwardedMail } from "./email.ts";

export type SourceBackedApplicationCandidate = ApplicationCandidate & { sources: ApplicationSourceData[] };

/** Match retained email against immutable original posting evidence only. */
export function correlateApplicationSources(mail: ForwardedMail,
  candidates: SourceBackedApplicationCandidate[]): CorrelationResult {
  const prepared = candidates.map(candidate => prepareCandidate(candidate));
  const threadResult = correlateApplication(mail, prepared.map(candidate => ({ cardId: candidate.cardId, messageIds: candidate.messageIds })));
  if (threadResult.kind === "matched" && threadResult.method === "thread") return threadResult;
  if (threadResult.kind === "review" && threadResult.reason === "Message thread references multiple applications") return threadResult;

  const urls = prepared.flatMap(value => value.originals.map(source => ({
    cardId: value.cardId,
    ...(source.observation.jobUrl ? { jobUrl: source.observation.jobUrl } : {}),
  })).filter(source => source.jobUrl));
  const urlResult = correlateApplication(mail, urls);
  if (urlResult.kind === "matched" && urlResult.method === "job-url") {
    const selected = prepared.find(value => value.cardId === urlResult.cardId);
    if (selected?.conflictingOriginals) return review("Application has conflicting original posting records", [urlResult.cardId]);
    return urlResult;
  }
  if (urlResult.kind === "review" && urlResult.reason === "Job URL matches multiple applications") {
    return urlResult;
  }

  const context = `${mail.subject}\n${mail.text}`.normalize("NFKC").toLocaleLowerCase();
  const atsMatches = prepared.filter(value => value.atsIds.some(id => containsExactToken(context, id)));
  if (atsMatches.length === 1) return { kind: "matched", cardId: atsMatches[0]!.cardId, method: "ats-id" };
  if (atsMatches.length > 1) return review("ATS identifier matches multiple applications", atsMatches.map(value => value.cardId));

  if (prepared.some(value => value.unknownEvidence || value.availableOriginals.length === 0)) {
    return review("Original posting evidence is missing or unavailable; choose an application", prepared.map(value => value.cardId));
  }

  const sourced: ApplicationCandidate[] = prepared.flatMap(value => value.availableOriginals.map(source => {
    const observation = source.observation;
    if (observation.status !== "available") throw new Error("Application original evidence changed during matching");
    return { cardId: value.cardId, company: observation.company, role: observation.title,
      ...(observation.jobUrl ? { jobUrl: observation.jobUrl } : {}) };
  }));
  const contextResult = correlateApplication(mail, sourced);
  if (contextResult.kind === "matched" && prepared.find(value => value.cardId === contextResult.cardId)?.conflictingOriginals) {
    return review("Application has conflicting original posting records", [contextResult.cardId]);
  }
  return contextResult;
}

type PreparedCandidate = {
  cardId: string;
  messageIds: string[];
  atsIds: string[];
  originals: ApplicationSourceData[];
  availableOriginals: ApplicationSourceData[];
  conflictingOriginals: boolean;
  unknownEvidence: boolean;
};

function prepareCandidate(candidate: SourceBackedApplicationCandidate): PreparedCandidate {
  const parsed: ApplicationSourceData[] = [];
  let unknownEvidence = !Array.isArray(candidate.sources);
  for (const value of Array.isArray(candidate.sources) ? candidate.sources : []) {
    try {
      const source = parseApplicationSourceData(value);
      if (source.cardId !== candidate.cardId) { unknownEvidence = true; continue; }
      if (source.observation.phase === "original") parsed.push(source);
    } catch {
      unknownEvidence = true;
    }
  }
  const originals = [...new Map(parsed.map(source => [semanticOriginalKey(source), source])).values()];
  const availableOriginals = originals.filter(source => source.observation.status === "available");
  const originalReferences = parsed.filter(source => source.observation.phase === "original");
  const messageIds = [...new Set(originalReferences.flatMap(source => source.messageIds ?? []))];
  const atsIds = [...new Set(originalReferences.flatMap(source => source.atsId ? [source.atsId] : []))];
  return { cardId: candidate.cardId, messageIds, atsIds, originals, availableOriginals,
    conflictingOriginals: originals.length > 1, unknownEvidence };
}

function containsExactToken(context: string, value: string): boolean {
  const token = value.normalize("NFKC").toLocaleLowerCase().trim();
  if (token.length < 3) return false;
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?:$|[^\\p{L}\\p{N}])`, "u").test(context);
}

function semanticOriginalKey(source: ApplicationSourceData): string {
  const observation = source.observation;
  const available = observation.status === "available";
  return JSON.stringify({ company: normalizePhrase(available ? observation.company : undefined),
    title: normalizePhrase(available ? observation.title : undefined),
    jobUrl: observation.jobUrl ? normalizeUrl(observation.jobUrl) : "",
    contentDigest: available ? observation.contentDigest : "" });
}

function normalizePhrase(value: string | undefined): string {
  return (value ?? "").normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

function normalizeUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_.+|gclid|fbclid|mc_cid|mc_eid)$/i.test(key)) url.searchParams.delete(key);
    }
    url.hostname = url.hostname.toLowerCase();
    return url.toString().replace(/\/$/, "");
  } catch { return ""; }
}

function review(reason: string, candidates: string[]): CorrelationResult {
  return { kind: "review", reason, candidates: [...new Set(candidates)] };
}
