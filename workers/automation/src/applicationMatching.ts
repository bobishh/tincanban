import type { ApplicationCandidate, CorrelationResult, ForwardedMail } from "./email.ts";
import type { JobPageFetcher } from "./extraction.ts";

/** Only retained application sources can authorize a mail-driven move; missing originals require review. */
export async function correlateApplicationFromJobPages(mail: ForwardedMail, candidates: ApplicationCandidate[],
  _fetcher: JobPageFetcher = fetch): Promise<CorrelationResult> {
  return import("./applicationSourceMatching.ts").then(({ correlateApplicationSources }) =>
    correlateApplicationSources(mail, candidates.map(candidate => ({ ...candidate, sources: candidate.sources ?? [] }))));
}
