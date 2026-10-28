import { describe, expect, it } from "vitest"
import { publicBoardOrigin, withPublicBoardOrigin } from "./publicBoardLink"

describe("public board source links", () => {
  it("keeps original addresses readable through the configured publication server while rejecting an invalid explicit destination", () => {
    expect(publicBoardOrigin("", "https://rusty.example")).toBe("https://rusty.example")
    expect(publicBoardOrigin("?message=m", "https://rusty.example")).toBe("https://rusty.example")
    expect(publicBoardOrigin("?rusty=javascript:bad", "https://rusty.example")).toBe("")
    expect(publicBoardOrigin("", "http://untrusted.example")).toBe("")
  })
  it("Given a board on a connected Rusty, when sharing its link, then retain its exact server across reload and canonicalization", () => {
    const path = withPublicBoardOrigin("/boards/board/job-search?view=all#card", "https://rusty.example")
    const url = new URL(path, "https://app.example")
    expect(url.pathname).toBe("/boards/board/job-search")
    expect(url.searchParams.get("view")).toBe("all")
    expect(url.hash).toBe("#card")
    expect(publicBoardOrigin(url.search)).toBe("https://rusty.example")
    expect(withPublicBoardOrigin(path, "https://other.example")).not.toContain("rusty.example")
  })

  it.each(["https://rusty.example", "http://127.0.0.1:49152", "http://localhost:49152", "http://[::1]:49152"])(
    "accepts a secure service or isolated local service: %s", origin => {
      expect(publicBoardOrigin(`?rusty=${encodeURIComponent(origin)}`)).toBe(origin)
    },
  )

  it.each(["", "http://remote.example", "https://name:secret@rusty.example", "https://rusty.example/path", "https://rusty.example?token=secret", "javascript:alert(1)"])(
    "Given an absent or invalid service address, when opening a public link, then provide no request destination: %s", origin => {
      expect(publicBoardOrigin(`?rusty=${encodeURIComponent(origin)}`)).toBe("")
    },
  )
})
