import type { ApplicationCandidate, CorrelationResult, ForwardedMail } from "./email.ts";
import type { JobPageFetcher } from "./extraction.ts";

/** Match retained posting evidence or explicit legacy email identity; ambiguous evidence requires review. */
export async function correlateApplicationFromJobPages(mail: ForwardedMail, candidates: ApplicationCandidate[],
  _fetcher: JobPageFetcher = fetch): Promise<CorrelationResult> {
  return import("./applicationSourceMatching.ts").then(({ correlateApplicationSources }) =>
    correlateApplicationSources(mail, candidates.map(candidate => ({ ...candidate, sources: candidate.sources ?? [] }))));
}
