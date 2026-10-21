import { effectScope, ref, watch } from "vue"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { defaultBoardFilters } from "../filters"
import { useBoardSearch } from "./useBoardSearch"

let scope = effectScope()
beforeEach(() => { vi.useFakeTimers(); scope = effectScope() })
afterEach(() => { scope.stop(); vi.useRealTimers() })

function fixture(initial = "") {
  const search = ref(initial), workspace = ref("board-one"), filters = ref(defaultBoardFilters())
  const query = scope.run(() => useBoardSearch(search, () => workspace.value, filters))!
  return { search, workspace, filters, query }
}

it("Given rapid search typing, when each key updates the textbox, then present only the latest normalized query after 60 quiet milliseconds", () => {
  const f = fixture(), presented: string[] = []
  scope.run(() => watch(f.query, value => presented.push(value), { flush: "sync" }))
  f.search.value = "P"
  expect(f.search.value).toBe("P")
  expect(f.query.value).toBe("")
  vi.advanceTimersByTime(25)
  f.search.value = "Pe"
  vi.advanceTimersByTime(25)
  f.search.value = " Performance Card "
  vi.advanceTimersByTime(59)
  expect(f.query.value).toBe("")
  vi.advanceTimersByTime(1)
  expect(f.query.value).toBe("performance card")
  expect(presented).toEqual(["performance card"])
})

it("Given a presented query and newer pending text, when search clears, then restore the unfiltered board immediately and never revive the pending query", () => {
  const f = fixture("old query")
  f.search.value = "pending query"
  vi.advanceTimersByTime(40)
  f.search.value = "  "
  expect(f.query.value).toBe("")
  vi.runAllTimers()
  expect(f.query.value).toBe("")
})

it("Given pending search text, when a nontext filter changes, then apply that current query immediately with the new filter", () => {
  const f = fixture()
  f.search.value = " Card "
  expect(f.query.value).toBe("")
  f.filters.value.fieldValues.priority = "high"
  expect(f.query.value).toBe("card")
  vi.runAllTimers()
  expect(f.query.value).toBe("card")
})

it("Given a pending search for one workspace, when another workspace opens, then discard the old presentation and pending work", () => {
  const f = fixture("old query")
  f.search.value = "old pending query"
  vi.advanceTimersByTime(50)
  f.workspace.value = "board-two"
  expect(f.query.value).toBe("")
  vi.runAllTimers()
  expect(f.query.value).toBe("")
  f.search.value = "new board query"
  vi.advanceTimersByTime(60)
  expect(f.query.value).toBe("new board query")
})

it("Given pending search text, when its owning view is disposed, then cancel delayed presentation", () => {
  const f = fixture("presented")
  f.search.value = "pending"
  scope.stop()
  vi.runAllTimers()
  expect(f.query.value).toBe("presented")
})
