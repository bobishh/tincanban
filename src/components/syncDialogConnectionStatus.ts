import { isKeeper, type MeshMemberView } from "../ui/deviceInfo"

type SyncDialogConnectionInput = {
  meshPresence?: "connected" | "reconnecting" | "offline" | "empty"
  workspaceConnected?: boolean
  workspaceReconnecting?: boolean
  networkOnline?: boolean
  retryAt?: number
  now: number
  live?: boolean
  localDeviceId?: string
  meshMembers?: MeshMemberView[]
}

export function syncDialogConnectionStatus(input: SyncDialogConnectionInput) {
  const otherBrowserOnline = (input.meshMembers ?? []).some(member => member.deviceList.some(device =>
    device.deviceId !== input.localDeviceId && device.online && !isKeeper(device.userAgent),
  ))
  const rustyAvailableWithoutOtherBrowser = input.meshPresence === "connected" && !input.workspaceConnected &&
    input.networkOnline !== false && !input.workspaceReconnecting && !otherBrowserOnline
  return {
    title: connectionTitle(input, rustyAvailableWithoutOtherBrowser),
    message: connectionMessage(input, rustyAvailableWithoutOtherBrowser),
    warning: input.live !== false && !input.workspaceConnected && !rustyAvailableWithoutOtherBrowser,
  }
}

function connectionTitle(input: SyncDialogConnectionInput, rustyAvailableWithoutOtherBrowser: boolean) {
  if (input.workspaceConnected) return "Devices connected"
  if (input.workspaceReconnecting) return "Devices reconnecting"
  return rustyAvailableWithoutOtherBrowser ? "No other devices online" : "Devices offline"
}

function connectionMessage(input: SyncDialogConnectionInput, rustyAvailableWithoutOtherBrowser: boolean) {
  if (input.workspaceConnected) return "Channel open on this device."
  if (input.networkOnline === false) return "Waiting for internet. Changes stay saved on this device."
  if (input.workspaceReconnecting) return "Checking live channel. Changes stay saved on this device."
  if (rustyAvailableWithoutOtherBrowser) return "Rusty sync remains available."
  if (!input.retryAt) return "No live channel. Reconnecting automatically."
  const seconds = Math.max(1, Math.ceil((input.retryAt - input.now) / 1_000))
  return `No live channel. Retrying in ${seconds}s.`
}
