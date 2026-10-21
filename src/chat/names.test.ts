import { describe, it, expect } from "vitest"
import {
  normalizeDisplayName,
  validateDisplayName,
  nameKey,
  isGeneratedDeviceName,
  resolveDisplayNames,
  resolveDisplayNamesWithIdentity,
} from "./names"

it("uses identity name when this workspace still stores an older chat announcement", () => {
  const names = resolveDisplayNamesWithIdentity([
    { personId: "self", name: "Swift Mimosa" },
    { personId: "peer", name: "Bo" },
  ], { personId: "self", name: "Bo" })
  expect(names.self).toMatch(/^Bo · /)
  expect(names.peer).toMatch(/^Bo · /)
  expect(names.self).not.toBe(names.peer)
})

describe("normalizeDisplayName", () => {
  it("trims leading and trailing whitespace", () => {
    expect(normalizeDisplayName("   Alice   ")).toBe("Alice")
    expect(normalizeDisplayName("\t  Bob  \n ")).toBe("Bob")
  })

  it("collapses multiple Unicode whitespace runs into single space", () => {
    expect(normalizeDisplayName("Alice   Bob")).toBe("Alice Bob")
    expect(normalizeDisplayName("Alice\u00A0Bob\u2003Charlie")).toBe("Alice Bob Charlie")
    expect(normalizeDisplayName("  \u3000  Hello   \u2002  World  \t  ")).toBe("Hello World")
  })

  it("applies NFKC Unicode normalization", () => {
    // Full-width characters
    expect(normalizeDisplayName("\uFF21\uFF4C\uFF49\uFF43\uFF45")).toBe("Alice")
    // Ligatures (ﬁ -> fi)
    expect(normalizeDisplayName("\uFB01le")).toBe("file")
  })

  it("handles empty or whitespace-only strings", () => {
    expect(normalizeDisplayName("")).toBe("")
    expect(normalizeDisplayName("    ")).toBe("")
    expect(normalizeDisplayName("\u2003\u00A0\t\n")).toBe("")
  })
})

describe("validateDisplayName", () => {
  it("accepts valid names within 1..48 Unicode codepoints", () => {
    expect(validateDisplayName("A")).toBeNull()
    expect(validateDisplayName("Alice")).toBeNull()
    expect(validateDisplayName("Тревожная мимоза")).toBeNull()
    expect(validateDisplayName("  Alice   Smith  ")).toBeNull()
    // Exactly 48 codepoints
    const name48 = "А".repeat(48)
    expect(validateDisplayName(name48)).toBeNull()
    // 48 emojis (surrogate pairs)
    const emoji48 = "🌸".repeat(48)
    expect(validateDisplayName(emoji48)).toBeNull()
  })

  it("rejects empty or whitespace-only names", () => {
    expect(validateDisplayName("")).toBeTypeOf("string")
    expect(validateDisplayName("   ")).toBeTypeOf("string")
    expect(validateDisplayName("\t  \n ")).toBeTypeOf("string")
  })

  it("rejects names exceeding 48 Unicode codepoints", () => {
    const name49 = "А".repeat(49)
    expect(validateDisplayName(name49)).toBeTypeOf("string")
    const emoji49 = "🌸".repeat(49)
    expect(validateDisplayName(emoji49)).toBeTypeOf("string")
  })

  it("rejects control characters (Unicode Category Cc)", () => {
    expect(validateDisplayName("Alice\u0000Bob")).toBeTypeOf("string")
    expect(validateDisplayName("Alice\u0007Bob")).toBeTypeOf("string")
    expect(validateDisplayName("Alice\u001FBob")).toBeTypeOf("string")
    expect(validateDisplayName("Alice\u007FBob")).toBeTypeOf("string")
    expect(validateDisplayName("Alice\u0080Bob")).toBeTypeOf("string")
    expect(validateDisplayName("Alice\u009FBob")).toBeTypeOf("string")
    expect(validateDisplayName("Alice\nBob")).toBeTypeOf("string")
  })

  it("rejects bidirectional control characters (Bidi_Control)", () => {
    expect(validateDisplayName("Alice\u202EBob")).toBeTypeOf("string") // Right-to-Left Override
    expect(validateDisplayName("Alice\u200EBob")).toBeTypeOf("string") // Left-to-Right Mark
    expect(validateDisplayName("Alice\u200FBob")).toBeTypeOf("string") // Right-to-Left Mark
    expect(validateDisplayName("Alice\u2066Bob")).toBeTypeOf("string") // Left-to-Right Isolate
    expect(validateDisplayName("Alice\u061CBob")).toBeTypeOf("string") // Arabic Letter Mark
  })
})

describe("nameKey", () => {
  it("normalizes, collapses whitespace, and lowercases deterministically", () => {
    expect(nameKey("  Alice   Smith  ")).toBe("alice smith")
    expect(nameKey("ALICE")).toBe("alice")
    expect(nameKey("  Дерзкая   ПЕТУНИЯ  ")).toBe("дерзкая петуния")
    expect(nameKey("\uFF21\uFF4C\uFF49\uFF43\uFF45")).toBe("alice")
  })

  it("is not locale-specific", () => {
    expect(nameKey("TITLE")).toBe("title")
    expect(nameKey("ISTANBUL")).toBe("istanbul")
  })
})

describe("historical generated device labels", () => {
  it("matches the old exact dictionaries and SDK suffix only", () => {
    expect(isGeneratedDeviceName("Valiant Squirrel's device")).toBe(true)
    for (const value of ["Valiant Squirrel", "Valiant Robot's device", "Squirrel workstation", "Alice's device"]) {
      expect(isGeneratedDeviceName(value)).toBe(false)
    }
  })
})

describe("resolveDisplayNames", () => {
  it("returns empty record for empty people array", () => {
    expect(resolveDisplayNames([])).toEqual({})
  })

  it("displays unique names as normalized names without suffix", () => {
    const input = [
      { personId: "p1", name: "  Alice   Smith  " },
      { personId: "p2", name: "Bob Jones" },
    ]
    const result = resolveDisplayNames(input)
    expect(result).toEqual({
      p1: "Alice Smith",
      p2: "Bob Jones",
    })
  })

  it("assigns name · X suffix to all colliding distinct persons", () => {
    const input = [
      { personId: "u1", name: "Alice" },
      { personId: "u2", name: "Alice" },
    ]
    const result = resolveDisplayNames(input)
    expect(result.u1).toMatch(/^Alice · [A-Za-z0-9]+$/)
    expect(result.u2).toMatch(/^Alice · [A-Za-z0-9]+$/)
    expect(result.u1).not.toBe(result.u2)
  })

  it("preserves chosen normalized name when casing differs in collision group", () => {
    const input = [
      { personId: "id1", name: "Alice" },
      { personId: "id2", name: "ALICE" },
    ]
    const result = resolveDisplayNames(input)
    expect(result.id1).toMatch(/^Alice · [A-Za-z0-9]+$/)
    expect(result.id2).toMatch(/^ALICE · [A-Za-z0-9]+$/)
    expect(result.id1).not.toBe(result.id2)
  })

  it("ensures suffixes only use safe alphanumeric ASCII even with base64url characters", () => {
    const input = [
      { personId: "k-7X_9A", name: "Alice" },
      { personId: "k_7X-9B", name: "Alice" },
    ]
    const result = resolveDisplayNames(input)
    const suffix1 = result["k-7X_9A"].split(" · ")[1]
    const suffix2 = result["k_7X-9B"].split(" · ")[1]
    expect(suffix1).toMatch(/^[A-Za-z0-9]+$/)
    expect(suffix2).toMatch(/^[A-Za-z0-9]+$/)
    expect(suffix1).not.toContain("-")
    expect(suffix1).not.toContain("_")
    expect(suffix2).not.toContain("-")
    expect(suffix2).not.toContain("_")
    expect(suffix1).not.toBe(suffix2)
  })

  it("does not collapse distinct case-sensitive IDs or IDs differing by escaped chars", () => {
    const input = [
      { personId: "user-a", name: "Alice" },
      { personId: "user_a", name: "Alice" },
      { personId: "user0a", name: "Alice" },
      { personId: "usera", name: "Alice" },
      { personId: "userA", name: "Alice" },
    ]
    const result = resolveDisplayNames(input)
    const suffixes = Object.values(result).map((n) => n.split(" · ")[1])
    expect(new Set(suffixes).size).toBe(5)
  })

  it("does not collide same-person duplicates with self", () => {
    const input = [
      { personId: "p1", name: "Alice" },
      { personId: "p1", name: "Alice" },
      { personId: "p2", name: "Bob" },
    ]
    const result = resolveDisplayNames(input)
    expect(result).toEqual({
      p1: "Alice",
      p2: "Bob",
    })
  })

  it("correctly handles same-person duplicates when colliding with another person", () => {
    const input = [
      { personId: "p1", name: "Alice" },
      { personId: "p1", name: "Alice" },
      { personId: "p2", name: "Alice" },
    ]
    const result = resolveDisplayNames(input)
    expect(result.p1).toMatch(/^Alice · [A-Za-z0-9]+$/)
    expect(result.p2).toMatch(/^Alice · [A-Za-z0-9]+$/)
    expect(result.p1).not.toBe(result.p2)
  })

  it("is stable regardless of input order", () => {
    const order1 = [
      { personId: "idA", name: "Alice" },
      { personId: "idB", name: "Alice" },
      { personId: "idC", name: "Bob" },
    ]
    const order2 = [
      { personId: "idB", name: "Alice" },
      { personId: "idC", name: "Bob" },
      { personId: "idA", name: "Alice" },
    ]
    const order3 = [
      { personId: "idC", name: "Bob" },
      { personId: "idA", name: "Alice" },
      { personId: "idB", name: "Alice" },
    ]
    const res1 = resolveDisplayNames(order1)
    const res2 = resolveDisplayNames(order2)
    const res3 = resolveDisplayNames(order3)
    expect(res1).toEqual(res2)
    expect(res2).toEqual(res3)
  })

  it("extends suffixes for adversarial IDs sharing long prefixes until unique", () => {
    const sharedPrefix = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    const input = [
      { personId: sharedPrefix + "1", name: "Alice" },
      { personId: sharedPrefix + "2", name: "Alice" },
    ]
    const result = resolveDisplayNames(input)
    expect(result[sharedPrefix + "1"]).not.toBe(result[sharedPrefix + "2"])
    const suffix1 = result[sharedPrefix + "1"].split(" · ")[1]
    const suffix2 = result[sharedPrefix + "2"].split(" · ")[1]
    expect(suffix1).toMatch(/^[A-Za-z0-9]+$/)
    expect(suffix2).toMatch(/^[A-Za-z0-9]+$/)
    expect(suffix1).not.toBe(suffix2)
  })

  it("uses exactly one suffix symbol initially when IDs do not collide on the first character", () => {
    const input = [
      { personId: "alpha123", name: "Alice" },
      { personId: "beta456", name: "Alice" },
    ]
    const result = resolveDisplayNames(input)
    expect(result.alpha123).toBe("Alice · a")
    expect(result.beta456).toBe("Alice · b")
  })

  it("extends suffix beyond one symbol only when IDs collide on prefix", () => {
    const input = [
      { personId: "alpha1", name: "Alice" },
      { personId: "alpha2", name: "Alice" },
      { personId: "beta1", name: "Alice" },
    ]
    const result = resolveDisplayNames(input)
    expect(result.beta1).toBe("Alice · b")
    expect(result.alpha1).toBe("Alice · alpha1")
    expect(result.alpha2).toBe("Alice · alpha2")
  })

  it("handles IDs where one is a prefix of another", () => {
    const input = [
      { personId: "abcd", name: "Alice" },
      { personId: "abcdef", name: "Alice" },
    ]
    const result = resolveDisplayNames(input)
    expect(result.abcd).not.toBe(result.abcdef)
    expect(result.abcd).toMatch(/^Alice · [A-Za-z0-9]+$/)
    expect(result.abcdef).toMatch(/^Alice · [A-Za-z0-9]+$/)
  })
})
