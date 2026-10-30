export type KeeperWorkspace = { id: string; title: string }
export type KeeperDiscovery = {
  origin: string
  displayName: string
  personId: string
  publicKey: string
  deviceId: string
  certificates: unknown[]
  fingerprint: string
  capabilities: {
    modes: string[]
    documentReplication: boolean
    chatReplication: boolean
    blobReplication: boolean
    pairing: boolean
    ownerOriginAdmission?: boolean
  }
}

function isLoopback(hostname: string) { return ["localhost", "127.0.0.1", "[::1]"].includes(hostname) }

function normalizeOrigin(input: string, allowLoopbackHttp = false) {
  const value = input.trim()
  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `https://${value}`
  const url = new URL(candidate)
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Enter a hostname without a path, login or query string.")
  }
  const loopback = isLoopback(url.hostname)
  const localHttp = url.protocol === "http:" && loopback && (import.meta.env.DEV || allowLoopbackHttp && typeof window !== "undefined" && isLoopback(window.location.hostname))
  if (url.protocol !== "https:" && !localHttp) {
    throw new Error("Keeper discovery requires HTTPS. Plain HTTP works only on loopback during local development.")
  }
  return url.origin
}

function parseDescriptor(value: unknown, origin: string): Omit<KeeperDiscovery, "fingerprint"> {
  if (!value || typeof value !== "object") throw new Error("Rusty returned an invalid discovery descriptor.")
  const descriptor = value as Record<string, unknown>
  const service = descriptor.service as Record<string, unknown> | undefined
  const rawCapabilities = descriptor.capabilities as Record<string, unknown> | undefined
  if (descriptor.publicOrigin !== origin) throw new Error("The advertised public origin does not match the requested origin.")
  if (!Array.isArray(descriptor.protocolVersions) || !descriptor.protocolVersions.includes(1)) {
    throw new Error("This Rusty service supports no shared protocol version. Upgrade the service and retry.")
  }
  if (!service || typeof service.personId !== "string" || typeof service.publicKey !== "string" ||
    typeof service.deviceId !== "string" || !Array.isArray(service.certificates) ||
    typeof descriptor.displayName !== "string" || !rawCapabilities || !Array.isArray(rawCapabilities.modes)) {
    throw new Error("Rusty returned an invalid discovery descriptor.")
  }
  const modes = rawCapabilities.modes.filter((mode): mode is string => typeof mode === "string")
  if (!modes.includes("replicate")) throw new Error("This Rusty service does not support visitor replication.")
  return {
    origin, displayName: descriptor.displayName, personId: service.personId,
    publicKey: service.publicKey, deviceId: service.deviceId, certificates: service.certificates,
    capabilities: {
      modes,
      documentReplication: rawCapabilities.documentReplication === true,
      chatReplication: rawCapabilities.chatReplication === true,
      blobReplication: rawCapabilities.blobReplication === true,
      pairing: rawCapabilities.pairing === true,
      ownerOriginAdmission: rawCapabilities.ownerOriginAdmission === true,
    },
  }
}

async function publicKeyFingerprint(publicKey: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(publicKey))
  return [...new Uint8Array(digest)].slice(0, 12).map(byte => byte.toString(16).padStart(2, "0")).join("").match(/.{1,4}/g)?.join(":") ?? "unavailable"
}

export async function discoverKeeper(input: string, options: { allowLoopbackHttp?: boolean } = {}): Promise<KeeperDiscovery> {
  const origin = normalizeOrigin(input, options.allowLoopbackHttp === true)
  const response = await fetch(`${origin}/.well-known/mesh-lighthouse`, { redirect: "error", headers: { Accept: "application/json" } })
  if (!response.ok) {
    const detail = await response.json().catch(() => null) as { message?: string } | null
    throw new Error(detail?.message || `Discovery failed (${response.status}).`)
  }
  const value = await response.json() as Record<string, unknown>
  const parsed = parseDescriptor(value, origin)
  const service = value.service as Record<string, unknown>
  if (typeof service.publicKey !== "string") throw new Error("Rusty returned an invalid public key.")
  return { ...parsed, fingerprint: await publicKeyFingerprint(service.publicKey) }
}
