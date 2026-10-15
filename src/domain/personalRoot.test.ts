import { describe, expect, it, beforeEach } from "vitest"
import {
  createPersonalRoot,
  registerDeviceInRoot,
  registerWorkspaceInRoot,
  forgetWorkspaceInRoot,
  reconcilePersonalRootWorkspaces,
} from "./personalRoot"
import { bootstrapIdentity, resetIdentityStorageForTest, sha256Base64Url } from "./identity"

describe("Personal Root Document and Catalog (Requirement 2.1)", () => {
  beforeEach(() => {
    resetIdentityStorageForTest()
  })

  it("creates a personal root document initialized with local identity and device", async () => {
    const profile = await bootstrapIdentity("Alice")
    const certBytes = new TextEncoder().encode(JSON.stringify(profile.certificate))
    const certHash = await sha256Base64Url(certBytes)

    const root = createPersonalRoot(profile, certHash)
    expect(root.kind).toBe("personal-root")
    expect(root.formatVersion).toBe(1)
    expect(root.identity.personId).toBe(profile.identity.personId)
    expect(root.devices[profile.device.deviceId]).toBeDefined()
    expect(root.devices[profile.device.deviceId].publicKey).toBe(profile.device.publicKey)
    expect(root.devices[profile.device.deviceId].certificateHash).toBe(certHash)
    expect(Object.keys(root.workspaces).length).toBe(0)
  })

  it("registers workspace references idempotently without duplicates", async () => {
    const profile = await bootstrapIdentity("Alice")
    const root = createPersonalRoot(profile, "cert_hash_1")

    registerWorkspaceInRoot(root, "ws_1", "doc_1", "grant_hash_1")
    expect(root.workspaces["ws_1"]).toBeDefined()
    expect(root.workspaces["ws_1"].documentId).toBe("doc_1")
    expect(root.workspaces["ws_1"].grantHash).toBe("grant_hash_1")
    expect(root.workspaces["ws_1"].forgotten).toBe(false)

    // Re-registering with same or updated grant updates reference idempotently
    registerWorkspaceInRoot(root, "ws_1", "doc_1", "grant_hash_updated")
    expect(Object.keys(root.workspaces).length).toBe(1)
    expect(root.workspaces["ws_1"].grantHash).toBe("grant_hash_updated")
  })

  it("supports forgetting a workspace in personal catalog scope", async () => {
    const profile = await bootstrapIdentity("Alice")
    const root = createPersonalRoot(profile, "cert_hash_1")

    registerWorkspaceInRoot(root, "ws_1", "doc_1", "grant_hash_1")
    expect(root.workspaces["ws_1"].forgotten).toBe(false)

    forgetWorkspaceInRoot(root, "ws_1")
    expect(root.workspaces["ws_1"].forgotten).toBe(true)
  })

  it("registers new devices into the registry", async () => {
    const profile = await bootstrapIdentity("Alice")
    const root = createPersonalRoot(profile, "cert_hash_1")

    registerDeviceInRoot(root, {
      deviceId: "dev_laptop",
      publicKey: "pub_laptop",
      displayName: "Alice's Laptop",
      certificateHash: "cert_hash_laptop",
      addedAt: new Date().toISOString(),
    })

    expect(root.devices["dev_laptop"]).toBeDefined()
    expect(root.devices["dev_laptop"].displayName).toBe("Alice's Laptop")
  })

  it("Given a verified enrollment request, when registering its device, then exclude request-only fields from the personal catalog", async () => {
    const profile = await bootstrapIdentity("Alice")
    const root = createPersonalRoot(profile, "initial-certificate")
    const request = { kind: "device-enrollment-request", version: 2, invitationId: "invitation",
      deviceId: "new-device", publicKey: "new-public-key", displayName: "Phone",
      certificateHash: "new-certificate", addedAt: "2026-10-15T15:00:00.000Z" }
    registerDeviceInRoot(root, request)
    expect(root.devices[request.deviceId]).toEqual({ deviceId: request.deviceId, publicKey: request.publicKey,
      displayName: request.displayName, certificateHash: request.certificateHash, addedAt: request.addedAt })
    expect(request.invitationId).toBe("invitation")
  })

  it("reconciles uncatalogued stored workspaces idempotently after interruption", async () => {
    const profile = await bootstrapIdentity("Alice")
    const root = createPersonalRoot(profile, "cert_hash_1")

    // Simulated stored workspace metadata that wasn't registered in root due to an interruption
    const stored = [
      { id: "ws_saved", title: "Interrupted Workspace", grantHash: "grant_saved" },
    ]

    const added = reconcilePersonalRootWorkspaces(root, stored)
    expect(added).toContain("ws_saved")
    expect(root.workspaces["ws_saved"]).toBeDefined()
    expect(root.workspaces["ws_saved"].documentId).toBe("ws_saved")

    // Re-reconciling does not duplicate or re-add
    const addedAgain = reconcilePersonalRootWorkspaces(root, stored)
    expect(addedAgain.length).toBe(0)
  })
})
