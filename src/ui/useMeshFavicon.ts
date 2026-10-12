import { onMounted, onScopeDispose, watch, type Ref } from "vue"

import type { WorkspaceRole } from "../domain/permissions"
import { canRoles } from "./canRole"

type Presence = "connected" | "reconnecting" | "offline" | "empty"
type Frames = Record<Presence | "dim", string>

/** Reuse the header's presence state; animate only while reconnecting. */
export function useMeshFavicon(presence: Readonly<Ref<Presence>>, accessRole: Readonly<Ref<WorkspaceRole | null>>) {
  let icon: HTMLLinkElement | null = null
  let original: string | null = null
  let source: string | undefined
  const cache = new Map<WorkspaceRole | null, Frames>()
  let timer: ReturnType<typeof setInterval> | undefined
  let motion: MediaQueryList | undefined
  const load = new AbortController()
  const stopBlink = () => { clearInterval(timer); timer = undefined }
  const paint = (href: string) => { if (icon && icon.getAttribute("href") !== href) icon.setAttribute("href", href) }
  const render = () => {
    stopBlink()
    if (!source) return
    let frames = cache.get(accessRole.value)
    try {
      if (!frames) { frames = presenceFrames(source, accessRole.value); cache.set(accessRole.value, frames) }
    } catch {
      // Optional decoration must not break later role or connection updates.
      source = undefined
      cache.clear()
      if (original) paint(original)
      return
    }
    paint(frames[presence.value])
    if (presence.value !== "reconnecting" || motion?.matches) return
    let dim = false
    timer = setInterval(() => { dim = !dim; paint(frames![dim ? "dim" : "reconnecting"]) }, 500)
  }
  watch([presence, accessRole], render)
  onMounted(async () => {
    icon = document.querySelector<HTMLLinkElement>('link[rel="icon"][type="image/svg+xml"]')
    original = icon?.getAttribute("href") ?? null
    if (!original) return
    motion = window.matchMedia("(prefers-reduced-motion: reduce)")
    motion.addEventListener("change", render)
    try {
      const response = await fetch(original, { signal: load.signal })
      if (!response.ok) return
      const loadedSource = await response.text()
      if (load.signal.aborted) return
      source = loadedSource
      render()
    } catch { /* Keep the static icon if the optional animation cannot load. */ }
  })
  onScopeDispose(() => {
    load.abort()
    stopBlink()
    motion?.removeEventListener("change", render)
    if (icon && original) icon.setAttribute("href", original)
  })
}

function presenceFrames(source: string, accessRole: WorkspaceRole | null): Frames {
  const svg = new DOMParser().parseFromString(source, "image/svg+xml")
  const interior = svg.querySelector("[data-connection-fill]")
  if (!interior || svg.querySelector("parsererror")) throw new Error("Invalid favicon")
  if (accessRole) stampRole(svg, accessRole)
  const styles = getComputedStyle(document.documentElement)
  const color = (name: string, fallback: string) => styles.getPropertyValue(`--${name}`).trim() || fallback
  const frame = (fill: string) => {
    interior.setAttribute("fill", fill)
    return `data:image/svg+xml,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`
  }
  const yellow = frame(color("presence-yellow", "#ffd43b"))
  return { connected: frame(color("presence-green", "#69db7c")), reconnecting: yellow, empty: yellow,
    offline: frame(color("presence-red", "#ff5a36")), dim: frame(color("paper", "#f3f0e8")) }
}

function stampRole(svg: Document, role: WorkspaceRole) {
  const appearance = canRoles[role]
  const body = svg.querySelector("[data-can-body]")
  if (!body?.parentElement) throw new Error("Invalid can body")
  body.setAttribute("fill", appearance.body)
  svg.querySelector("[data-can-highlight]")?.setAttribute("fill", appearance.highlight)
  svg.querySelector("[data-can-shade]")?.setAttribute("fill", appearance.shade)
  const stamp = svg.createElementNS("http://www.w3.org/2000/svg", "g")
  stamp.setAttribute("data-role-stamp", role)
  stamp.setAttribute("transform", "translate(31.6 40) scale(.7)")
  stamp.setAttribute("stroke", "none")
  const glyph = svg.createElementNS(stamp.namespaceURI, "path")
  glyph.setAttribute("d", appearance.stamp)
  glyph.setAttribute("fill", "#171717")
  glyph.setAttribute("fill-opacity", ".75")
  glyph.setAttribute("stroke", "#171717")
  glyph.setAttribute("stroke-width", "1.5")
  glyph.setAttribute("stroke-linejoin", "round")
  stamp.append(glyph)
  body.parentElement.append(stamp)
}
