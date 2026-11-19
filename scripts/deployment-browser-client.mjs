/** Optional hosting dependency. No browser extension is included in source builds. */
export function deploymentBrowserClient(environment) {
  const src = environment.ANALYTICS_CLIENT_URL?.trim()
  const project = environment.ANALYTICS_PROJECT?.trim()
  const token = environment.ANALYTICS_BROWSER_TOKEN?.trim()
  if (!src || !project || !token) return []
  const url = new URL(src)
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("Use an HTTPS browser extension without URL credentials")
  return [{ tag: "script", attrs: { defer: true, src: url.href, "data-project": project, "data-token": token }, injectTo: "head" }]
}
