import { expect, it } from "vitest"
import { packWorkspaceRoutes, unpackWorkspaceRoutes } from "./identityWorkspaceRoutePacking"

const maximum = 900 * 1024

it("Given generated Unicode records and repeated proof-shaped data, when packing and unpacking, then preserve every JSON value exactly", () => {
  const alphabet = ["a", "é", "Ж", "🚲", "\u0000", "\n", "\"", "\\"]
  for (let seed = 0; seed < 64; seed++) {
    const text = Array.from({ length: seed * 19 }, (_, index) => alphabet[(index * 13 + seed) % alphabet.length]).join("")
    const value = { personId: "owner", text, proof: { signature: text, epoch: seed }, values: [null, false, seed, text] }
    expect(unpackWorkspaceRoutes("owner", packWorkspaceRoutes(value, maximum), maximum)).toEqual(value)
  }
})

it("Given a false inflated size or another Identity, when unpacking, then reject within the fixed allocation budget", () => {
  const packed = packWorkspaceRoutes({ personId: "owner", text: "x".repeat(100_000) }, maximum)
  for (const uncompressedBytes of [-1, 0, 1, 100, (packed.uncompressedBytes as number) - 1,
    (packed.uncompressedBytes as number) + 1, maximum + 1, Number.NaN]) {
    expect(() => unpackWorkspaceRoutes("owner", { ...packed, uncompressedBytes }, maximum)).toThrow()
  }
  expect(() => unpackWorkspaceRoutes("stranger", packed, maximum)).toThrow()
  expect(() => unpackWorkspaceRoutes("owner", { ...packed, packed: "broken" }, maximum)).toThrow()
  expect(() => packWorkspaceRoutes({ personId: "owner", text: "x".repeat(maximum) }, maximum)).toThrow(/size limit/)
})
