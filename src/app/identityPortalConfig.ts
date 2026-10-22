/** Return an exact portal origin, or keep optional onboarding unavailable. */
export function configuredIdentityPortalOrigin(value: string | undefined): string | null {
  const configured = value?.trim()
  if (!configured) return null
  try {
    const url = new URL(configured)
    if (url.origin !== configured.replace(/\/$/u, "") || url.username || url.password || url.search || url.hash) return null
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalHost(url.hostname))) return null
    return url.origin
  } catch { return null }
}

function isLocalHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
}
