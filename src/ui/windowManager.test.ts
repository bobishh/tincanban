import { describe, expect, it } from "vitest"
import { clampWindowGeometry, windowLayoutKey } from "./windowManager"

describe("local window layouts", () => {
  it("keeps oversized and displaced windows reachable after viewport shrink", () => {
    expect(clampWindowGeometry({ x: 1800, y: -50, width: 1200, height: 900 }, { width: 390, height: 700 }))
      .toEqual({ x: 12, y: 12, width: 366, height: 676 })
  })
  it("keeps minimum-size windows inside the viewport", () => {
    expect(clampWindowGeometry({ x: 10, y: 800, width: 20, height: 20 }, { width: 1000, height: 700 }))
      .toEqual({ x: 12, y: 488, width: 480, height: 200 })
  })
  it("upgrades saved narrow geometry while allowing the available mobile width", () => {
    expect(clampWindowGeometry({ x: 4, y: 4, width: 280, height: 460 }, { width: 1000, height: 700 }).width).toBe(480)
    expect(clampWindowGeometry({ x: 4, y: 4, width: 280, height: 460 }, { width: 320, height: 700 }).width).toBe(296)
  })
  it("reduces margins when viewport height becomes tiny", () => {
    const geometry = clampWindowGeometry({ x: 50, y: 50, width: 400, height: 400 }, { width: 390, height: 10 })
    expect(geometry.y + geometry.height).toBeLessThanOrEqual(10)
    expect(geometry.x + geometry.width).toBeLessThanOrEqual(390)
  })
  it("separates workspace/content keys without delimiter collisions", () => {
    expect(windowLayoutKey("a:b", "c")).not.toBe(windowLayoutKey("a", "b:c"))
    expect(windowLayoutKey("a", "item:1")).not.toBe(windowLayoutKey("b", "item:1"))
  })
})

import { afterEach, beforeEach, vi } from "vitest"
import { cycleSpatialWindow, focusSpatialWindow, registerSpatialWindow, unregisterSpatialWindow } from "./windowManager"

describe("window focus ring", () => {
  const focusState: { current: ElementStub | null } = { current: null }
  class ElementStub {
    isConnected = true
    focus = vi.fn(() => { focusState.current = this })
    contains(value: unknown) { return value === this }
    closest() { return null }
  }
  const open: NonNullable<ReturnType<typeof registerSpatialWindow>>[] = []
  beforeEach(() => {
    const values = new Map<string, string>()
    vi.stubGlobal("HTMLElement", ElementStub)
    vi.stubGlobal("window", { innerWidth: 1000, innerHeight: 700 })
    vi.stubGlobal("document", { get activeElement() { return focusState.current } })
    vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) })
  })
  afterEach(() => { open.forEach(unregisterSpatialWindow); open.length = 0; focusState.current = null; vi.unstubAllGlobals() })
  function register(workspace: string, id: string) {
    const root = new ElementStub()
    const entry = registerSpatialWindow(workspace, id, root as unknown as HTMLElement, { x: 20, y: 20, width: 400, height: 400 })!
    open.push(entry)
    return { entry, root }
  }
  it("reopening identical content focuses existing window and adds no duplicate", () => {
    const first = register("a", "item:1")
    register("a", "chat")
    expect(registerSpatialWindow("a", "item:1", new ElementStub() as unknown as HTMLElement, first.entry.geometry)).toBeNull()
    expect(first.root.focus).toHaveBeenCalledOnce()
    expect(first.entry.z).toBe(2)
  })
  it("restores initiating control after closing focused window", () => {
    const trigger = new ElementStub()
    focusState.current = trigger
    const first = register("a", "item:1")
    focusState.current = first.root
    unregisterSpatialWindow(first.entry)
    expect(trigger.focus).toHaveBeenCalledOnce()
  })
  it("cycles only current workspace and keeps z bounded after repeated focus", () => {
    const first = register("a", "item:1")
    const second = register("a", "chat")
    const other = register("b", "chat")
    for (let index = 0; index < 100; index++) focusSpatialWindow("a", "chat")
    cycleSpatialWindow("a")
    expect(first.root.focus).toHaveBeenCalledOnce()
    expect(other.root.focus).not.toHaveBeenCalled()
    expect([first.entry.z, second.entry.z, other.entry.z].sort()).toEqual([1, 2, 3])
  })
})
