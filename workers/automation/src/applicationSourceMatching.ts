import { parseApplicationSourceData, type ApplicationSourceData } from "../../../src/domain/applicationSourceData.ts";
import { correlateApplication, type ApplicationCandidate, type CorrelationResult, type ForwardedMail } from "./email.ts";

export type SourceBackedApplicationCandidate = ApplicationCandidate & { sources: ApplicationSourceData[] };

/** Match retained email against immutable original posting evidence only. */
export function correlateApplicationSources(mail: ForwardedMail,
  candidates: SourceBackedApplicationCandidate[]): CorrelationResult {
  const prepared = candidates.map(candidate => prepareCandidate(candidate));
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
  return { cardId: candidate.cardId, originals, availableOriginals,
    conflictingOriginals: originals.length > 1, unknownEvidence };
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
