import { describe, expect, it } from "vitest"
import { calculateRankBetween, compareRanks, isValidRank } from "./rank"

describe("Canonical rational ranks", () => {
  it("compares rational ranks exactly using BigInt arithmetic, not lexicographical string ordering", () => {
    expect(compareRanks("1/10", "1/2")).toBeLessThan(0)
    expect(compareRanks("1/2", "1/10")).toBeGreaterThan(0)
    expect(compareRanks("2/4", "1/2")).toBe(0) // same value
    expect(compareRanks("-1/2", "0/1")).toBeLessThan(0)
    expect(compareRanks("3/2", "4/3")).toBeGreaterThan(0) // 1.5 > 1.333...
  })

  it("calculates correct mediant ranks between distinct ranks, and handles bounds", () => {
    // Before first
    expect(calculateRankBetween(null, "0/1")).toBe("-1/1")
    expect(calculateRankBetween(null, "1/1")).toBe("0/1")

    // After last
    expect(calculateRankBetween("0/1", null)).toBe("1/1")
    expect(calculateRankBetween("2/1", null)).toBe("3/1")

    // Between distinct ranks: mediant of 0/1 and 1/1 is 1/2
    expect(calculateRankBetween("0/1", "1/1")).toBe("1/2")
    // Mediant of 1/2 and 1/1 is 2/3
    expect(calculateRankBetween("1/2", "1/1")).toBe("2/3")
  })

  it("Given ordered rational bounds, When repeatedly inserting ranks, Then every rank remains canonical and strictly between its neighbors", () => {
    const bounds = ["-9007199254740993/1", "-5/3", "-1/2", "0/1", "1/3", "1/2", "8/5", "9007199254740993/1"]
    for (let left = 0; left < bounds.length - 1; left++) {
      for (let right = left + 1; right < bounds.length; right++) {
        const lower = bounds[left]!
        let upper = bounds[right]!
        for (let insertion = 0; insertion < 32; insertion++) {
          const middle = calculateRankBetween(lower, upper)
          expect(isValidRank(middle)).toBe(true)
          expect(compareRanks(lower, middle)).toBeLessThan(0)
          expect(compareRanks(middle, upper)).toBeLessThan(0)
          upper = middle
        }
      }
    }
  })
})
