import type { TelemetryConfig } from "../sync/telemetryConfig"

export function serviceLogsUrl(config: Pick<TelemetryConfig, "endpoint" | "project">, workspace: string): string | undefined {
  if (!workspace || workspace.length > 128 || !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(config.project)) return undefined
  try {
    const endpoint = new URL(config.endpoint)
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
        !(endpoint.protocol === "https:" || (endpoint.protocol === "http:" && loopback))) return undefined
    const url = new URL("/admin/logs/", endpoint.origin)
    url.searchParams.set("workspace", workspace)
    return url.href
  } catch { return undefined }
}
