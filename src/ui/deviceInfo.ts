import { isGeneratedDeviceName, unprovidedDisplayName } from "../chat/names"

export function keeperDisplayName(name: string): string {
  if (!name.trim() || name === "Lighthouse" || name === "mesh-lighthouse") return "Rusty keeper"
  return name.replace(/^Participant(?= · |$)/, "Rusty keeper")
}

export function isKeeper(userAgent?: string): boolean {
  return /^mesh-lighthouse\/\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(userAgent ?? "")
}

export function describeUserAgent(userAgent?: string): string {
  if (isKeeper(userAgent)) return "Rusty"
  if (!userAgent?.trim()) return "Browser / OS unknown"
  const os = identifyUserAgent(userAgent, [
    [/iPhone|iPad|iPod/, "iOS"], [/Android/, "Android"], [/Windows NT/, "Windows"],
    [/CrOS/, "ChromeOS"], [/Macintosh|Mac OS X/, "macOS"], [/Linux/, "Linux"],
  ])
  const browser = identifyUserAgent(userAgent, [
    [/Edg\//, "Edge"], [/OPR\//, "Opera"], [/Firefox\/|FxiOS\//, "Firefox"],
    [/Chrome\/|CriOS\//, "Chrome"], [/Safari\/.*Version\/|Version\/.*Safari\//, "Safari"],
  ])

  return browser && os ? `Likely ${browser} · ${os}` : "Browser / OS unknown"
}

function identifyUserAgent(userAgent: string, signatures: Array<[RegExp, string]>): string {
  return signatures.find(([signature]) => signature.test(userAgent))?.[1] ?? ""
}

export type MeshMemberView = {
    personId: string
    name: string
    role: "owner" | "editor" | "visitor"
    online: boolean
    reconnecting: boolean
    onlineDevices: number
    devices: number
    self: boolean
    pendingRemoval?: boolean
    integrationId?: string
    integrationRevision?: number
    integrationBoardIds?: string[]
    integrationAvailability?: "unknown" | "available" | "unavailable" | "needs-review"
    integrationAvailabilityReason?: string
    deviceList: Array<{
      deviceId: string
      name: string
      online: boolean
      reconnecting: boolean
      lastSeen: string
      userAgent?: string
      description: string
      tabs: number
    }>
  }

/** Historical generated labels are presentation-only; never rewrite certificates or saved operations. */
export function deviceDisplayName(device: { deviceId: string; name?: string; userAgent?: string; description?: string }): string {
  const name = device.name?.trim() ?? ""
  if (name && !isGeneratedDeviceName(name) && name !== `${unprovidedDisplayName}'s device`) return name
  const description = device.description || describeUserAgent(device.userAgent)
  const shortId = device.deviceId.slice(0, 8)
  return description !== "Browser / OS unknown" ? `${description} · ${shortId}` : `Device ${shortId}`
}
