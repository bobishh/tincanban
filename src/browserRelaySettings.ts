export type BrowserRelaySettings =
  | { mode: "public" }
  | { mode: "custom"; urls: string[] }
  | { mode: "rusty"; origin: string; url: string }

const storageKey = "tincanban.browser-relay.v1"

function relayUrl(input: string): string {
  let url: URL
  const invalid = "Enter a relay HTTPS origin. HTTP is allowed only on loopback."
  try { url = new URL(input) }
  catch { throw new Error(invalid) }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  if ((url.protocol !== "https:" && !(loopback && url.protocol === "http:")) ||
      url.pathname !== "/" || url.username || url.password || url.search || url.hash) {
    throw new Error(invalid)
  }
  return url.origin
}

function relayList(input: string[]): string[] {
  const urls = [...new Set(input.map(relayUrl))]
  if (urls.length === 0 || urls.length > 8) throw new Error("Enter between one and eight relay URLs.")
  return urls
}

export function readBrowserRelaySettings(): BrowserRelaySettings {
  const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(storageKey)
  if (raw === null) return { mode: "public" }
  const value = JSON.parse(raw) as Partial<BrowserRelaySettings> | null
  if (value?.mode === "public") return { mode: "public" }
  if (value?.mode === "custom" && Array.isArray(value.urls) && value.urls.every(url => typeof url === "string")) {
    return { mode: "custom", urls: relayList(value.urls) }
  }
  if (value?.mode === "rusty" && typeof value.origin === "string" && typeof value.url === "string") {
    return { mode: "rusty", origin: relayUrl(value.origin), url: relayUrl(value.url) }
  }
  throw new Error("Saved mesh relay settings are invalid. Update them in Settings.")
}

export function browserRelayUrls(): string[] | undefined {
  const settings = readBrowserRelaySettings()
  if (settings.mode === "custom") return settings.urls
  if (settings.mode === "rusty") return [settings.url]
  return undefined
}

export async function saveBrowserRelaySettings(mode: BrowserRelaySettings["mode"], input: string): Promise<void> {
  if (mode === "custom") {
    const urls = relayList(input.split(/\s+/).filter(Boolean))
    localStorage.setItem(storageKey, JSON.stringify({ mode, urls }))
  } else if (mode === "rusty") {
    const { discoverRustyService } = await import("@meta-uber/mesh-replication/rusty-management")
    const { origin, capabilities } = await discoverRustyService(relayUrl(input.trim()), (request, init) =>
      fetch(request, { ...init, redirect: "error" }))
    const relay = capabilities.irohRelay
    if (!relay || typeof relay !== "object" || !("version" in relay) || relay.version !== 1 ||
        !("url" in relay) || typeof relay.url !== "string") {
      throw new Error("This Rusty service does not advertise an Iroh relay.")
    }
    localStorage.setItem(storageKey, JSON.stringify({ mode, origin, url: relayUrl(relay.url) }))
  } else {
    localStorage.removeItem(storageKey)
  }
}
