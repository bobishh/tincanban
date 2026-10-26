export const identityBrowserReturnPath = "/identity/return"

export function safeReturnPath(path: string): string {
  if (!path.startsWith("/") || path.startsWith("//") || path.startsWith(identityBrowserReturnPath) || path.includes("\\")) {
    return "/"
  }
  return path
}

export function validOrigin(origin: string): boolean {
  try {
    const value = new URL(origin)
    return value.origin === origin && !value.username && !value.password &&
      (value.protocol === "https:" || (value.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(value.hostname)))
  } catch { return false }
}

