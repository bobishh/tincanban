export function blindOrigin(input: string): string {
  const url = new URL(input.includes("://") ? input : `https://${input}`)
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
    throw new Error("Rusty needs an HTTPS origin; HTTP is allowed only on loopback")
  }
  return url.origin
}
