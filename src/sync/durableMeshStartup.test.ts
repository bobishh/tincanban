import { describe, expect, it, vi } from "vitest"
import { DurableMesh } from "./durableMesh"
import { defaultProofStore } from "../domain/proofs"
import { clearMeshTrace, meshTraceSnapshot } from "./meshTrace"
import type { LocalProfile } from "../domain/identity"
import type { WorkspaceMeshCredential } from "./peerStore"

describe("durable mesh transport demand", () => {
  it("Given a retained board credential, when its route is prepared, then trace stable comparable fingerprints without storing the transport secret in diagnostics", async () => {
    const certificates = vi.spyOn(defaultProofStore, "listCertificates").mockResolvedValue([])
    const profile = { identity: { personId: "owner" }, device: { deviceId: "phone-a" } } as LocalProfile
    const mesh = new DurableMesh({ transport: {} as never, workspace: {} as never, workspaceStore: {} as never,
      getProfile: async () => profile })
    const internal = mesh as unknown as {
      prepareCredentials(credentials: WorkspaceMeshCredential[], profile: LocalProfile, endpoint: string): Promise<void>
      refreshOwnerCertificates: (credential: WorkspaceMeshCredential) => Promise<WorkspaceMeshCredential>
      refreshOwnBundle: () => Promise<void>; pruneInvalidStoredPeers: () => Promise<void>
    }
    internal.refreshOwnerCertificates = async credential => credential
    internal.refreshOwnBundle = internal.pruneInvalidStoredPeers = async () => {}
    clearMeshTrace()
    try {
      let prepared = 0
      for (const transportSecret of ["never-export-this-secret", "never-export-this-secret", "a-different-private-secret"]) {
        await internal.prepareCredentials([{ workspaceId: "board-a", transportSecret } as WorkspaceMeshCredential], profile, "endpoint-a")
        prepared++
        await vi.waitFor(() => expect(meshTraceSnapshot().filter(event => event.event === "credential.prepared")).toHaveLength(prepared))
      }
      const events = meshTraceSnapshot().filter(event => event.event === "credential.prepared")
      expect(events).toHaveLength(3)
      expect(events[0]).toMatchObject({ workspaceId: "board-a", localDeviceId: "phone-a", localEndpointId: "endpoint-a",
        credentialId: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) })
      expect(events[0]?.credentialId).toBe(events[1]?.credentialId)
      expect(events[0]?.credentialId).not.toBe(events[2]?.credentialId)
      expect(JSON.stringify(events)).not.toMatch(/never-export-this-secret|a-different-private-secret/)
    } finally { certificates.mockRestore() }
  })

  it.each([
    { label: "local-only owner", peers: [], adopted: false, expected: false },
    { label: "own device route", peers: [{ workspaceId: "board", deviceId: "local" }], adopted: false, expected: false },
    { label: "known remote peer", peers: [{ workspaceId: "board", deviceId: "remote" }], adopted: false, expected: true },
    { label: "unrelated peer", peers: [{ workspaceId: "other", deviceId: "remote" }], adopted: false, expected: false },
    { label: "pairing handoff", peers: [], adopted: true, expected: true },
  ])("Given $label, when startup checks network demand, then transport demand is $expected", async ({ peers, adopted, expected }) => {
    const mesh = new DurableMesh({
      transport: {} as never, workspace: {} as never, workspaceStore: {} as never,
      getProfile: async () => ({ device: { deviceId: "local" } }) as never,
      store: { listWorkspaceCredentials: async () => [{ workspaceId: "board" }], listPeers: async () => peers } as never,
    })
    const internal = mesh as unknown as { adoptedNode?: unknown; canStartRuntime(): Promise<boolean> }
    if (adopted) internal.adoptedNode = {}
    expect(await internal.canStartRuntime()).toBe(expected)
  })
})
