import type { DeviceSyncState } from "./deviceSyncState"

export const pairingLocationClearedEvent = "tincanban:pairing-location-cleared"

export async function showInviteQr(
  state: DeviceSyncState,
  inviteUrl: string,
): Promise<void> {
  state.inviteUrl.value = inviteUrl
  const { default: QRCode } = await import("qrcode")
  state.qrCode.value = await QRCode.toDataURL(inviteUrl, {
    width: 240,
    margin: 2,
    errorCorrectionLevel: "M",
  })
}

export async function copyInviteLink(state: DeviceSyncState, targetUrl?: string): Promise<void> {
  const url = targetUrl || state.inviteUrl.value
  if (!url) return
  try {
    await navigator.clipboard.writeText(url)
    state.copyNotice.value = "Pairing link copied."
  } catch {
    state.copyNotice.value = "Clipboard unavailable. Select the pairing link and copy it manually."
  }
}

export function clearPairingLocation(): void {
  if (typeof window === "undefined") return
  const url = new URL(window.location.href)
  if (url.pathname.replace(/\/$/, "") !== "/pair") return
  url.pathname = "/"
  url.hash = ""
  window.history.replaceState(window.history.state, "", url)
  window.dispatchEvent(new Event(pairingLocationClearedEvent))
}
