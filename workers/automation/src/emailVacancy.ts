import { assertPublicHttpsUrl } from "./extraction.ts";

/** Resolve SES tracking links without spending the bounded vacancy fetch budget on email decoration. */
export function emailVacancyUrls(values: string[]): string[] {
  const addresses = new Set<string>();
  for (const value of values) {
    try {
      const url = resolveEmailUrl(value);
      // Homepages, search, privacy and candidate dashboards do not identify a vacancy.
      if (!url.pathname.split("/").some(part => part && !/^[a-z]{2}(?:[-_][a-z]{2})?$/i.test(part)) ||
        !(/(?:^|\/)(?:jobs?|careers|positions|vacancies)\/[^/]+/i.test(url.pathname) || /(?:^|\.)(?:jobs?|careers)\./i.test(url.hostname)) ||
        /(?:^|\/)(?:search|privacy|content|candidate|dashboard)(?:\/|$)/i.test(url.pathname)) continue;
      addresses.add(url.toString());
    } catch { /* Invalid links are not vacancy evidence. */ }
  }
  return [...addresses];
}

/** Locale, slug and www aliases still identify one Amazon requisition. */
export function emailJobIdentity(value: string): string {
  const url = resolveEmailUrl(value);
  if (url.hostname === "amazon.jobs" || url.hostname === "www.amazon.jobs") {
    const id = url.pathname.match(/(?:^|\/)jobs\/(\d+)(?:\/|$)/)?.[1];
    if (id) return `https://amazon.jobs/jobs/${id}`;
  }
  return url.toString();
}

function resolveEmailUrl(value: string): URL {
  let url = new URL(assertPublicHttpsUrl(value));
  if (url.hostname.endsWith(".awstrack.me")) {
    const embedded = url.pathname.match(/^\/L\d+\/(https:%2F%2F[^/]+)\/\d+(?:\/|$)/i)?.[1];
    if (embedded) url = new URL(assertPublicHttpsUrl(decodeURIComponent(embedded)));
  }
  return url;
}
