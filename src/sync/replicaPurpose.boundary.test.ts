import { expect, it, vi } from "vitest"
import type { LocalProfile } from "../domain/identity"
import type { AutomationWorkerIdentity } from "../app/automation"
import type { WorkspaceDocumentV2 } from "../domain/model"
import type { BlindReplicaConfig } from "./blindReplication"
import { exportApprovedAutomation } from "../app/automationActivation"
import { prepareAutomationActivation } from "../app/automation"
import { createBlindReplica } from "./blindReplicaStore"

function forgedIdentityConfig() {
  return {
    purpose: "identity",
    personId: "private-person-secret",
    workspaceId: "workspace-a",
    scopeId: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    keyEpoch: 1,
    origin: "https://rusty.example",
    servicePublicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    readToken: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    writeToken: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    contentKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    policyRevision: 1,
    cursor: 0,
    lastUploaded: "",
  }
}

it("rejects identity config before automation export reads workspace data and preserves input", async () => {
  const config = forgedIdentityConfig()
  const readWorkspaceDoc = vi.fn(async () => ({ id: "workspace-a" }))
  const readWorkspaceBytes = vi.fn(async () => new Uint8Array([1]))
  const tincanban = { getCurrentProfile: vi.fn(() => ({ identity: { personId: "owner" } })), readWorkspaceDoc, readWorkspaceBytes }

  await expect(exportApprovedAutomation(tincanban as never, config as unknown as BlindReplicaConfig, "{}"))
    .rejects.toThrow(/identity.*replica|workspace.*replica/i)

  expect(readWorkspaceDoc).not.toHaveBeenCalled()
  expect(readWorkspaceBytes).not.toHaveBeenCalled()
  expect(config).toMatchObject({ purpose: "identity", personId: "private-person-secret" })
})

it("rejects mixed identity config before activation reads profile or assembles a packet", async () => {
  const config = forgedIdentityConfig()
  const profile = new Proxy({}, { get: () => { throw new Error("profile read before purpose validation") } }) as LocalProfile
  const input = {
    profile,
    doc: {} as WorkspaceDocumentV2,
    bytes: new Uint8Array([1]),
    authorization: { version: 1 as const, records: [], authority: { currentOwner: { personId: "owner" }, currentEpoch: 1 } },
    blind: config,
    worker: {} as AutomationWorkerIdentity,
    expiresAt: Date.now() + 60_000,
  }

  await expect(prepareAutomationActivation(input)).rejects.toThrow(/identity.*replica|workspace.*replica/i)
  expect(config).toMatchObject({ purpose: "identity", personId: "private-person-secret" })
})

it("rejects identity config before creating a workspace blind replica", () => {
  const config = forgedIdentityConfig()
  const ensureIdentity = vi.fn()
  const getCurrentProfile = vi.fn(() => ({ identity: { personId: "private-person-secret" } }))
  const persist = vi.fn(async () => {})

  expect(() => createBlindReplica(config as unknown as BlindReplicaConfig,
    { getCurrentProfile } as never, ensureIdentity, persist)).toThrow(/identity.*replica|workspace.*replica/i)

  expect(ensureIdentity).not.toHaveBeenCalled()
  expect(getCurrentProfile).not.toHaveBeenCalled()
  expect(persist).not.toHaveBeenCalled()
  expect(config).toMatchObject({ purpose: "identity", personId: "private-person-secret" })
})

it("rejects workspace-labeled mixed config that still carries person identity", async () => {
  const config = { ...forgedIdentityConfig(), purpose: "workspace" }
  const readWorkspaceDoc = vi.fn(async () => ({ id: "workspace-a" }))
  const readWorkspaceBytes = vi.fn(async () => new Uint8Array([1]))
  const tincanban = { getCurrentProfile: vi.fn(() => ({ identity: { personId: "owner" } })), readWorkspaceDoc, readWorkspaceBytes }

  await expect(exportApprovedAutomation(tincanban as never, config as unknown as BlindReplicaConfig, "{}"))
    .rejects.toThrow(/identity.*replica|workspace.*replica/i)

  expect(readWorkspaceDoc).not.toHaveBeenCalled()
  expect(readWorkspaceBytes).not.toHaveBeenCalled()
  expect(config).toMatchObject({ purpose: "workspace", personId: "private-person-secret" })
})
