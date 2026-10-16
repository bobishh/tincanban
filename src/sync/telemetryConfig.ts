export type TelemetryConfig = { enabled: boolean; endpoint: string; logsEndpoint: string; tracesEndpoint: string; project: string; browserKey?: string; level: "all" | "errors"; sampleRate: number; batchSize?: number }
const TELEMETRY_CONFIG_KEY = "tincanban.telemetry.v2"
const listeners = new Set<() => void>()
function validEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint)
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    return (url.protocol === "https:" || (url.protocol === "http:" && local)) && !url.username && !url.password && !url.search && !url.hash
  } catch { return false }
}
function otlpEndpoints(legacyEndpoint: string, explicitBase: string): { logsEndpoint: string; tracesEndpoint: string } | undefined {
  const base = explicitBase || legacyEndpoint
  if (!base) return { logsEndpoint: "", tracesEndpoint: "" }
  try {
    const url = new URL(base)
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    if (!(url.protocol === "https:" || (url.protocol === "http:" && local)) || url.username || url.password || url.search || url.hash) return undefined
    const path = url.pathname.replace(/\/+$/, "")
    const origin = url.origin
    const endpoint = (signal: "logs" | "traces") => {
      if (/\/v1\/(logs|traces)$/.test(path)) return `${origin}${path.replace(/\/(logs|traces)$/, `/${signal}`)}`
      if (/\/v1$/.test(path)) return `${origin}${path}/${signal}`
      return explicitBase ? `${origin}${path}/v1/${signal}` : `${origin}/v1/${signal}`
    }
    return { logsEndpoint: endpoint("logs"), tracesEndpoint: endpoint("traces") }
  } catch { return undefined }
}
function validCollectionLimits(value: TelemetryConfig): boolean {
  const batch = value.batchSize ?? 50
  return Number.isFinite(value.sampleRate) && value.sampleRate >= 0 && value.sampleRate <= 1 && Number.isInteger(batch) && batch >= 1 && batch <= 50
}
function validBrowserKey(value: TelemetryConfig): boolean {
  const key = value.browserKey ?? ""
  return typeof key === "string" && (!value.enabled || key.length > 0) && (key === "" || /^[A-Za-z0-9_-]{16,256}$/.test(key))
}
function configuredEndpoint(legacyEndpoint: string, explicitEndpoint: string): string {
  return explicitEndpoint || legacyEndpoint
}
function validateTelemetryConfig(value: TelemetryConfig): string {
  if (typeof value.enabled !== "boolean" || !["all", "errors"].includes(value.level)) return "Invalid diagnostic settings."
  if (!validCollectionLimits(value)) return "Sample rate must be 0–100%, and batch size 1–50."
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.project) || value.project.length > 64) return "Project must use lowercase letters, numbers and single hyphens (up to 64 characters)."
  if (!validBrowserKey(value)) return "Use the project's public browser key (16–256 letters, numbers, underscores or hyphens)."
  if (!value.endpoint && !value.enabled) return ""
  if (!validEndpoint(value.endpoint)) return "Use an HTTPS intake URL without credentials, query or fragment. HTTP is allowed on localhost."
  return ""
}
function deploymentConfig(): TelemetryConfig {
  const env = import.meta.env
  const legacyEndpoint = String(env.VITE_SYNC_TELEMETRY_URL || "").trim()
  const explicitEndpoint = String(env.VITE_OTEL_EXPORTER_OTLP_ENDPOINT || "").trim()
  const endpoint = configuredEndpoint(legacyEndpoint, explicitEndpoint)
  const otlp = otlpEndpoints(legacyEndpoint, explicitEndpoint)
  const project = String(env.VITE_SYNC_TELEMETRY_PROJECT || "tincanban").trim()
  const browserKey = String(env.VITE_SYNC_TELEMETRY_BROWSER_KEY || "").trim()
  const value: TelemetryConfig = { enabled: !!endpoint && !!browserKey && !!otlp, endpoint,
    logsEndpoint: otlp?.logsEndpoint ?? "", tracesEndpoint: otlp?.tracesEndpoint ?? "", project, browserKey,
    level: (env.VITE_SYNC_TELEMETRY_LEVEL || "all") as TelemetryConfig["level"],
    sampleRate: Number(env.VITE_SYNC_TELEMETRY_SAMPLE_RATE || "1"), batchSize: Number(env.VITE_SYNC_TELEMETRY_BATCH_SIZE || "50") }
  return validateTelemetryConfig(value) ? { enabled: false, endpoint: "", logsEndpoint: "", tracesEndpoint: "", project: "tincanban", browserKey: "", level: "all", sampleRate: 0, batchSize: 50 } : value
}
const DEVICE_CONSENT_KEY = "tincanban.telemetry.enabled.v1"
const deployment = deploymentConfig()
function load(): TelemetryConfig {
  let allowed = true
  try {
    const stored = localStorage.getItem(DEVICE_CONSENT_KEY)
    if (stored !== null) allowed = JSON.parse(stored) !== false
    else {
      const legacy = localStorage.getItem(TELEMETRY_CONFIG_KEY)
      // Preserve explicit opt-out; collector credentials and limits belong to the build.
      if (legacy) {
        const value: unknown = JSON.parse(legacy)
        allowed = !(value && typeof value === "object" && "enabled" in value && value.enabled === false)
      }
    }
  } catch { /* Unavailable preferences use the explicit deployment configuration. */ }
  return { ...deployment, enabled: deployment.enabled && allowed }
}
let config = load()
export function telemetryConfig(): TelemetryConfig { return { ...config } }
export function telemetryConfigured(): boolean { return deployment.enabled }
export function subscribeTelemetryConfig(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } }
export function setTelemetryEnabled(enabled: boolean): void {
  if (enabled && !telemetryConfigured()) throw new Error("Diagnostics are not configured for this application.")
  try { localStorage.setItem(DEVICE_CONSENT_KEY, JSON.stringify(enabled)) }
  catch { throw new Error("Diagnostic preference could not be saved on this device.") }
  config = { ...deployment, enabled: deployment.enabled && enabled }
  for (const listener of listeners) listener()
}
if (typeof window !== "undefined") window.addEventListener("storage", event => {
  if (event.key !== DEVICE_CONSENT_KEY && event.key !== null) return
  config = load()
  for (const listener of listeners) listener()
})
