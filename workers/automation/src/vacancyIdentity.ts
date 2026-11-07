/** Posting identity ignores tracking while retaining employer and ATS identifiers. */
export function vacancyUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    url.hash = "";
    if (url.hostname === "jobs.ashbyhq.com" && /^\/[^/]+\/[a-f0-9-]{36}(?:\/application)?\/?$/i.test(url.pathname)) {
      url.pathname = url.pathname.replace(/\/application\/?$|\/$/g, "");
      url.search = "";
    }
    if (url.hostname.endsWith(".jobs.personio.com") && /^\/job\/\d+(?:\/apply)?\/?$/.test(url.pathname)) {
      url.pathname = url.pathname.replace(/\/apply\/?$|\/$/g, "");
      url.search = "";
    }
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_.+|gclid|fbclid|mc_cid|mc_eid)$/i.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    return url.toString().replace(/\/$/, "");
  } catch { return null; }
}
