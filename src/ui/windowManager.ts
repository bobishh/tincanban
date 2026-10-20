import { markRaw, reactive } from "vue"

export type WindowGeometry = { x: number; y: number; width: number; height: number }
export type WindowDescriptor = {
  key: string
  workspaceId: string
  windowId: string
  geometry: WindowGeometry
  root: HTMLElement
  trigger: HTMLElement | null
  z: number
}
const windows: WindowDescriptor[] = reactive([])

export function clampWindowGeometry(value: WindowGeometry, viewport: { width: number; height: number }): WindowGeometry {
  const margin = Math.min(12, viewport.width / 20, viewport.height / 20)
  const width = Math.min(Math.max(480, value.width), Math.max(1, viewport.width - margin * 2))
  const height = Math.min(Math.max(200, value.height), Math.max(1, viewport.height - margin * 2))
  return {
    width, height,
    x: Math.max(margin, Math.min(value.x, viewport.width - width - margin)),
    y: Math.max(margin, Math.min(value.y, viewport.height - height - margin)),
  }
}
export function windowLayoutKey(workspaceId: string, windowId: string) {
  return `tincanban:window:v1:${JSON.stringify([workspaceId, windowId])}`
}
function viewport() { return { width: window.innerWidth, height: window.innerHeight } }
function reorder() { windows.forEach((entry, index) => { entry.z = index + 1 }) }

export function ensureWindowHost() {
  let host = document.getElementById("spatial-window-host")
  if (!host) {
    host = document.createElement("div")
    host.id = "spatial-window-host"
    Object.assign(host.style, { position: "fixed", inset: "0", zIndex: "27", pointerEvents: "none" })
    document.body.append(host)
  }
  return host
}
export function focusSpatialWindow(workspaceId: string, windowId: string) {
  const entry = windows.find(value => value.key === windowLayoutKey(workspaceId, windowId))
  if (!entry) return false
  raiseWindow(entry)
  entry.root.focus({ preventScroll: true })
  return true
}
export function raiseWindow(entry: WindowDescriptor) {
  const index = windows.findIndex(value => value.key === entry.key)
  if (index < 0 || index === windows.length - 1) return
  windows.splice(index, 1)
  windows.push(entry)
  reorder()
}
export function cycleSpatialWindow(workspaceId: string, reverse = false) {
  const available = windows.filter(entry => entry.workspaceId === workspaceId && !entry.root.closest("[inert]"))
  const next = reverse ? available.at(-2) : available[0]
  if (next) focusSpatialWindow(next.workspaceId, next.windowId)
}
export function saveWindowGeometry(entry: WindowDescriptor) {
  try { localStorage.setItem(entry.key, JSON.stringify(entry.geometry)) } catch { /* Layout persistence is optional. */ }
}
export function updateWindowGeometry(entry: WindowDescriptor, geometry: WindowGeometry) {
  Object.assign(entry.geometry, clampWindowGeometry(geometry, viewport()))
}
export function registerSpatialWindow(workspaceId: string, windowId: string, root: HTMLElement, initial: WindowGeometry) {
  if (focusSpatialWindow(workspaceId, windowId)) return null
  const key = windowLayoutKey(workspaceId, windowId)
  let geometry = initial
  try {
    const stored = JSON.parse(localStorage.getItem(key) ?? "null") as WindowGeometry | null
    if (stored && [stored.x, stored.y, stored.width, stored.height].every(value => typeof value === "number" && Number.isFinite(value))) geometry = stored
  } catch { /* Ignore corrupt or inaccessible local layouts. */ }
  const entry: WindowDescriptor = reactive({ key, workspaceId, windowId, geometry: clampWindowGeometry(geometry, viewport()), root: markRaw(root),
    trigger: document.activeElement instanceof HTMLElement ? markRaw(document.activeElement) : null, z: windows.length + 1 })
  windows.push(entry)
  return entry
}
export function unregisterSpatialWindow(entry: WindowDescriptor) {
  saveWindowGeometry(entry)
  const focused = entry.root.contains(document.activeElement)
  const index = windows.findIndex(value => value.key === entry.key)
  if (index >= 0) windows.splice(index, 1)
  reorder()
  if (!focused) return
  const next = windows.filter(value => value.workspaceId === entry.workspaceId).at(-1)
  if (entry.trigger?.isConnected && !entry.trigger.closest("[inert]")) entry.trigger.focus({ preventScroll: true })
  else next?.root.focus({ preventScroll: true })
}
