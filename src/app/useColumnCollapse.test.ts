import { afterEach, describe, expect, it, vi } from "vitest"
import { effectScope, nextTick, ref } from "vue"
import { useColumnCollapse } from "../ui/useColumnCollapse"

function storage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  return {
    data,
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { data.set(key, value) }),
  }
}

afterEach(() => vi.unstubAllGlobals())

describe("column collapse preferences", () => {
  it("keeps column choices independent, workspace-scoped, and reloadable", async () => {
    const prefs = storage({
      "tincanban:collapsed-columns:board-a": JSON.stringify({ lead: true, done: false }),
      "tincanban:collapsed-columns:board-b": JSON.stringify({ lead: false }),
    })
    vi.stubGlobal("localStorage", prefs)
    const workspace = ref("board-a")
    const scope = effectScope()
    const state = scope.run(() => useColumnCollapse(() => workspace.value, () => false))!
    const lead = { id: "lead", collapsible: true }
    const done = { id: "done", collapsible: true }
    expect(state.isCollapsed(lead)).toBe(true)
    expect(state.isCollapsed(done)).toBe(false)
    state.toggle(done)
    expect(state.isCollapsed(done)).toBe(true)
    expect(JSON.parse(prefs.data.get("tincanban:collapsed-columns:board-a")!)).toEqual({ lead: true, done: true })

    workspace.value = "board-b"
    await nextTick()
    expect(state.isCollapsed(lead)).toBe(false)
    workspace.value = "board-a"
    await nextTick()
    expect(state.isCollapsed(done)).toBe(true)
    scope.stop()
  })

  it("defaults open on malformed storage and tolerates unavailable storage", () => {
    const malformed = storage({ "tincanban:collapsed-columns:board": "{" })
    vi.stubGlobal("localStorage", malformed)
    const scope = effectScope()
    const state = scope.run(() => useColumnCollapse(() => "board", () => false))!
    const column = { id: "lead", collapsible: true }
    expect(state.isCollapsed(column)).toBe(false)
    scope.stop()

    const unavailable = { getItem: vi.fn(() => { throw new Error("denied") }), setItem: vi.fn(() => { throw new Error("denied") }) }
    vi.stubGlobal("localStorage", unavailable)
    const failingScope = effectScope()
    const failingState = failingScope.run(() => useColumnCollapse(() => "board", () => false))!
    expect(() => failingState.toggle(column)).not.toThrow()
    expect(failingState.isCollapsed(column)).toBe(true)
    failingScope.stop()
  })

  it("forces columns open while filters active without changing saved preference", () => {
    const prefs = storage({ "tincanban:collapsed-columns:board": JSON.stringify({ lead: true }) })
    vi.stubGlobal("localStorage", prefs)
    const filters = ref(false)
    const scope = effectScope()
    const state = scope.run(() => useColumnCollapse(() => "board", () => filters.value))!
    const column = { id: "lead", collapsible: true }
    expect(state.isCollapsed(column)).toBe(true)
    filters.value = true
    expect(state.isCollapsed(column)).toBe(false)
    expect(JSON.parse(prefs.data.get("tincanban:collapsed-columns:board")!)).toEqual({ lead: true })
    filters.value = false
    expect(state.isCollapsed(column)).toBe(true)
    scope.stop()
  })

  it("keeps non-collapsible columns open and leaves item lifecycle records untouched", () => {
    const prefs = storage()
    vi.stubGlobal("localStorage", prefs)
    const scope = effectScope()
    const state = scope.run(() => useColumnCollapse(() => "board", () => false))!
    const archive = { id: "archive", collapsible: false }
    const lifecycle = JSON.stringify({ state: "archived", changedAt: "2026-01-01T00:00:00.000Z" })
    const item = { id: "item", lifecycle }
    state.toggle(archive)
    expect(state.isCollapsed(archive)).toBe(false)
    expect(item.lifecycle).toBe(lifecycle)
    expect(prefs.setItem).not.toHaveBeenCalled()
    scope.stop()
  })
})
