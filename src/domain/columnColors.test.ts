import { describe, expect, it } from "vitest"
import { columnColors } from "./columnColors"

describe("column colors", () => {
  it("Given unconfigured columns, when reordered, then defaults remain unique and stable", () => {
    const columns = Array.from({ length: 30 }, (_, index) => ({ id: `column-${index}` }))
    const colors = columnColors(columns)
    expect(new Set(colors.values()).size).toBe(30)
    expect(columnColors([...columns].reverse())).toEqual(colors)
  })
  it("Given explicit colors, when defaults allocate, then configured colors are reserved", () => {
    const colors = columnColors([{ id: "a", color: "#E8C547" }, { id: "b" }, { id: "c" }])
    expect(colors.get("a")).toBe("#E8C547")
    expect(new Set([...colors.values()].map(color => color.toLowerCase())).size).toBe(3)
  })
})
