/** Public links carry only a server address; private storage credentials never belong in a URL. */
export function validPublicBoardOrigin(origin: string): boolean {
  try {
    const url = new URL(origin)
    return url.origin === origin && !url.username && !url.password &&
      (url.protocol === "https:" || url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
  } catch { return false }
}

export function publicBoardOrigin(search: string): string {
  const values = new URLSearchParams(search).getAll("rusty")
  return values.length === 1 && validPublicBoardOrigin(values[0]!) ? values[0]! : ""
}

export function withPublicBoardOrigin(path: string, origin: string): string {
  if (!validPublicBoardOrigin(origin)) throw new Error("A public board link needs a secure Rusty address")
  const url = new URL(path, "https://tincanban.invalid")
  url.searchParams.set("rusty", origin)
  return `${url.pathname}${url.search}${url.hash}`
}
