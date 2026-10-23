import { describe, expect, it } from "vitest"
import { createRecoverableIdentity, createDeviceAuthorizationApproval } from "@meta-uber/mesh-identity"
import { createIdentityBrowserSignIn, readPendingIdentityBrowserSignIn,
  verifyIdentityBrowserSignInReturn, writePendingIdentityBrowserSignIn } from "./identityBrowserSignIn"

describe("Identity browser sign-in", () => {
  it("Given a guest app device and portal approval, when returning with the bound state, then verify the app key and preserve the local return path", async () => {
    const app = (await createRecoverableIdentity("better", "App device")).profile
    const owner = (await createRecoverableIdentity("better", "Portal owner")).profile
    const now = Date.now()
    const { pending, portalUrl } = await createIdentityBrowserSignIn({ profile: app,
      portalOrigin: "https://identity.example", applicationOrigin: "https://boards.example",
      returnPath: "/workspace/123", now, challenge: "a".repeat(64) })
    expect(new URL(portalUrl).pathname).toBe("/authorize")
    expect(new URLSearchParams(new URL(portalUrl).hash.slice(1)).has("device-request")).toBe(true)
    expect(portalUrl).not.toContain("privateKey")
    expect(pending.request.payload.devicePublicKey).toBe(app.device.publicKey)
    const storage = new Map<string, string>()
    writePendingIdentityBrowserSignIn({ setItem: (key, value) => storage.set(key, value) }, pending)
    const read = readPendingIdentityBrowserSignIn({ getItem: key => storage.get(key) ?? null, removeItem: key => storage.delete(key) })
    expect(read?.returnPath).toBe("/workspace/123")
    expect(readPendingIdentityBrowserSignIn({ getItem: key => storage.get(key) ?? null, removeItem: key => storage.delete(key) })).toBeNull()
    const approval = await createDeviceAuthorizationApproval(owner, pending.request, {
      applicationOrigin: "https://boards.example", challenge: pending.request.payload.challenge,
    })
    const encoded = btoa(JSON.stringify(approval)).replace(/=/gu, "").replace(/\+/gu, "-").replace(/\//gu, "_")
    const result = await verifyIdentityBrowserSignInReturn({ hash: `#state=${"a".repeat(64)}&approval=${encoded}`,
      pending, currentProfile: app, applicationOrigin: "https://boards.example" })
    expect(result).toMatchObject({ kind: "approved", returnPath: "/workspace/123", replacesIdentity: true })
    await expect(verifyIdentityBrowserSignInReturn({ hash: `#state=${"a".repeat(64)}&approval=${encoded}`,
      pending, currentProfile: app, applicationOrigin: "https://substituted.example" })).rejects.toThrow(/origin/u)
    await expect(verifyIdentityBrowserSignInReturn({ hash: `#state=${"a".repeat(64)}&approval=${encoded}`,
      pending, currentProfile: app, applicationOrigin: "https://boards.example", now: now + 120_001 })).rejects.toThrow(/approval|request/u)
    const substitutedApproval = { ...approval, proof: { ...approval.proof, payload: { ...approval.proof.payload,
      request: { ...approval.proof.payload.request, payload: { ...approval.proof.payload.request.payload, challenge: "f".repeat(64) } } } } }
    const substituted = btoa(JSON.stringify(substitutedApproval)).replace(/=/gu, "").replace(/\+/gu, "-").replace(/\//gu, "_")
    await expect(verifyIdentityBrowserSignInReturn({ hash: `#state=${"a".repeat(64)}&approval=${substituted}`,
      pending, currentProfile: app, applicationOrigin: "https://boards.example" })).rejects.toThrow(/approval|request/u)
  })

  it("Given a cancelled or substituted browser return, when callback handling runs, then leave identity approval unavailable", async () => {
    const app = (await createRecoverableIdentity("better", "App device")).profile
    const { pending } = await createIdentityBrowserSignIn({ profile: app,
      portalOrigin: "https://identity.example", applicationOrigin: "https://boards.example",
      returnPath: "/", now: Date.now(), challenge: "b".repeat(64) })
    await expect(verifyIdentityBrowserSignInReturn({ hash: "#state=wrong&approval=bad", pending,
      currentProfile: app, applicationOrigin: "https://boards.example" })).rejects.toThrow(/state/u)
    await expect(verifyIdentityBrowserSignInReturn({ hash: `#state=${"b".repeat(64)}&cancelled=1`, pending,
      currentProfile: app, applicationOrigin: "https://boards.example" })).resolves.toMatchObject({ kind: "cancelled" })
    const changed = { ...app, device: { ...app.device, publicKey: "substituted" } }
    await expect(verifyIdentityBrowserSignInReturn({ hash: `#state=${"b".repeat(64)}&approval=bad`, pending,
      currentProfile: changed, applicationOrigin: "https://boards.example" })).rejects.toThrow(/changed/u)
  })
})
