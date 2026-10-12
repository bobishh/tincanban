export type ServiceLoginRequest = {
  origin: string
  challenge: string
  expires_at: number
}

export function parseServiceLoginRequest(encoded: string, now: number): ServiceLoginRequest {
  if (encoded.length > 4096) throw new Error("Invalid sign-in request")
  const value = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(encoded), c => c.charCodeAt(0)))) as ServiceLoginRequest
  if (!validServiceOrigin(value.origin) || !/^[a-f0-9]{64}$/u.test(value.challenge) ||
      !Number.isSafeInteger(value.expires_at) || value.expires_at <= now || value.expires_at > now + 120)
    throw new Error("Sign-in request is invalid or expired. Retry from TinSink.")
  return value
}

export function serviceLoginPayload(request: ServiceLoginRequest, now: number) {
  if (request.expires_at <= now) throw new Error("Sign-in expired. Retry from TinSink.")
  return { kind: "tinsink-login" as const, version: 2 as const,
    origin: request.origin, challenge: request.challenge,
    issuedAt: now * 1000, expiresAt: request.expires_at * 1000 }
}

function validServiceOrigin(origin: string): boolean {
  const url = new URL(origin)
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  return url.origin === origin && !url.username && !url.password &&
    (url.protocol === "https:" || (url.protocol === "http:" && loopback))
}
