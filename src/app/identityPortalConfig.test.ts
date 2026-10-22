import { describe, expect, it } from "vitest"
import { configuredIdentityPortalOrigin } from "./identityPortalConfig"

describe("optional Identity portal configuration", () => {
  it("keeps local guest use available when no portal origin is configured", () => {
    expect(configuredIdentityPortalOrigin(undefined)).toBeNull()
    expect(configuredIdentityPortalOrigin("  ")).toBeNull()
  })

  it("accepts exact secure origins and local development origins", () => {
    expect(configuredIdentityPortalOrigin("https://identity.example")).toBe("https://identity.example")
    expect(configuredIdentityPortalOrigin("http://127.0.0.1:4175")).toBe("http://127.0.0.1:4175")
  })

  it("rejects insecure or path-bound portal URLs", () => {
    expect(configuredIdentityPortalOrigin("http://identity.example")).toBeNull()
    expect(configuredIdentityPortalOrigin("https://identity.example/path")).toBeNull()
    expect(configuredIdentityPortalOrigin("https://user:password@identity.example")).toBeNull()
  })
})
