import { correlateApplication, type ApplicationCandidate, type CorrelationResult, type ForwardedMail } from "./email.ts";
import { extractJobPage, type JobPageFetcher } from "./extraction.ts";

/** Card labels only narrow the lookup; vacancy pages supply all matching fields. */
export async function correlateApplicationFromJobPages(mail: ForwardedMail, candidates: ApplicationCandidate[],
  fetcher: JobPageFetcher = fetch): Promise<CorrelationResult> {
  const references = candidates.map(({ cardId, jobUrl, messageIds }) => ({ cardId, jobUrl, messageIds }));
  const direct = correlateApplication(mail, references);
  if (direct.kind === "matched" || direct.reason !== "No existing application matched") return direct;
  const context = `${mail.from}\n${mail.subject}\n${mail.text}`.normalize("NFKC").toLowerCase();
  const hinted = candidates.filter(candidate => {
    const company = candidate.company?.normalize("NFKC").trim().toLowerCase();
    return company && company.length >= 3 && context.includes(company) || urlMentionsCompany(candidate.jobUrl, context);
  });
  const relevant = hinted.length ? hinted : candidates;
  const review = (reason: string): CorrelationResult => ({ kind: "review", reason, candidates: relevant.map(candidate => candidate.cardId) });
  if (relevant.some(candidate => !candidate.jobUrl)) return review("Application has no vacancy URL to read its original role");
  const urls = [...new Set(relevant.map(candidate => candidate.jobUrl!))];
  // Each page may follow three redirects; leave room for replication and classification.
  if (urls.length > 8) return review("Too many vacancy URLs to establish a unique match; email needs a specific application reference");
  const pages = new Map<string, { company: string; role: string }>();
  for (let offset = 0; offset < urls.length; offset += 4) {
    const results = await Promise.allSettled(urls.slice(offset, offset + 4).map(async url => {
      const page = await extractJobPage(url, {}, fetcher);
      if (!page.company.trim() || !page.role.trim()) throw new Error("Vacancy page does not identify a company and role");
      pages.set(url, { company: page.company, role: page.role });
    }));
    const failure = results.find(result => result.status === "rejected");
    if (failure?.status === "rejected") return review(`Cannot match vacancy page: ${failure.reason instanceof Error ? failure.reason.message : "fetch failed"}`);
  }
  const sourced = relevant.map(candidate => ({ ...references.find(reference => reference.cardId === candidate.cardId)!, ...pages.get(candidate.jobUrl!)! }));
  const result = correlateApplication(mail, sourced);
  return result.kind === "review" && result.reason === "Company context does not identify a role"
    ? { ...result, reason: "Email role does not match the original vacancy title" } : result;
}

function urlMentionsCompany(value: string | undefined, context: string): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    const tokens = `${url.hostname} ${url.pathname}`.toLowerCase().split(/[^\p{L}\p{N}]+/u);
    return tokens.some(token => token.length >= 3 && !/^(www|com|net|org|jobs?|careers|boards?|positions|vacancies|https|ashbyhq|greenhouse|lever)$/.test(token)
      && !/^\d+$/.test(token) && context.includes(token));
  } catch { return false; }
}
