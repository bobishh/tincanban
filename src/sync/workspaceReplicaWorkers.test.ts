import { readFile } from "node:fs/promises"
import * as Automerge from "@automerge/automerge/slim"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { initializeAutomerge } from "../crdt"
import type { WorkspaceDocumentV2 } from "../domain/model"
import type { LocalProfile } from "../domain/identity"
import type { BlindReplicaConfig } from "./blindReplication"
import { bootstrapIdentity, resetIdentityStorageForTest } from "../domain/identity"
import { createAutomationWorkspaceGrant, defaultProofStore } from "../domain/proofs"
import { createWorkspaceRevocation } from "./meshRecords"

const mocks = vi.hoisted(() => ({
  inspect: vi.fn(),
  assertSupported: vi.fn(),
  read: vi.fn(),
  refresh: vi.fn(),
  readAuthority: vi.fn(),
}))

vi.mock("../app/automationInstanceManagement", () => ({ inspectExistingAutomation: mocks.inspect }))
vi.mock("../app/automationInstanceClient", () => ({
  assertAutomationStorageRefreshSupported: mocks.assertSupported,
  readAutomationInstance: mocks.read,
  refreshAutomationStorageAccess: mocks.refresh,
}))
vi.mock("./changeAuthorization", () => ({ readWorkspaceSigningAuthority: mocks.readAuthority }))

import { discoverWorkspaceReplicaWorkers, refreshWorkspaceReplicaWorkers, type ReplicaWriterWorker } from "./workspaceReplicaWorkers"
import { AutomationWriterDependencyError } from "./replicaDependencyError"

const workspaceId = "workspace-1"
const rusty = { origin: "https://rusty.example.test", scopeId: "scope-current", keyEpoch: 2,
  servicePublicKey: "A".repeat(43), policyRevision: 1 }
const config = { ...rusty, workspaceId, contentKey: "private-content-key", readToken: "private-read-token",
  writeToken: "private-write-token", cursor: 0, lastUploaded: "" } as BlindReplicaConfig
const profile = { identity: { personId: "owner-person" } } as LocalProfile
const receipt = { signerKeyId: "A".repeat(43), signature: "signed-receipt",
  payload: { kind: "rusty-scope-policy-receipt", version: 1, serviceId: "A".repeat(43), scopeId: rusty.scopeId,
    personId: "owner-person", revision: 3, revoked: false, challengeId: "challenge-1",
    authorizationHash: "B".repeat(43), minimumWriterVersion: 2 } } as never

beforeEach(() => {
  mocks.readAuthority.mockReset().mockResolvedValue({ authority: null, invalid: false })
  mocks.inspect.mockReset().mockImplementation(async (_profile, input) => {
    const storage = descriptions[input.definitionId]?.storage
    return { identity: { ...input, integrationId: `route-${input.definitionId}`, personId: input.executorPersonId },
      description: { workspaceId, definitionId: input.definitionId, executorPersonId: input.executorPersonId,
        grantId: `grant-${input.definitionId}`, expiresAt: Date.now() + 60_000, state: "paused", adoptionRequired: false,
        ...(storage ? { storage } : {}) } }
  })
  mocks.assertSupported.mockReset().mockResolvedValue(undefined)
  mocks.read.mockReset()
  mocks.read.mockImplementation(async (_profile, input) => ({ identity: {
    origin: input.origin, workspaceId, definitionId: input.definitionId, integrationId: input.integrationId,
    executorPersonId: input.executorPersonId,
    description: { workspaceId, definitionId: input.definitionId, executorPersonId: input.executorPersonId,
      grantId: `grant-${input.definitionId}`, expiresAt: 42, state: "paused", adoptionRequired: false,
      storage: { ...rusty, policyRevision: 1 } },
  } }))
  mocks.refresh.mockReset().mockImplementation(async (_profile, input) => ({ identity: { origin: input.origin, workspaceId,
    definitionId: input.definitionId, integrationId: input.integrationId, executorPersonId: input.executorPersonId,
    description: { workspaceId, definitionId: input.definitionId, executorPersonId: input.executorPersonId,
      grantId: `grant-${input.definitionId}`, expiresAt: 42, state: "paused", adoptionRequired: false,
      storage: { ...input.storage, policyRevision: 3, minimumWriterVersion: 2 } },
  } }))
})

afterEach(() => vi.restoreAllMocks())

const descriptions: Record<string, { storage?: typeof rusty }> = {}

beforeAll(async () => {
  const wasm = await readFile("node_modules/@automerge/automerge/dist/automerge.wasm")
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(wasm, { headers: { "content-type": "application/wasm" } })))
  await initializeAutomerge()
})
afterAll(() => vi.unstubAllGlobals())

function automation(id: string, executorPersonId: string, state: "active" | "paused" | "deleted" = "paused") {
  const definitionId = id
  const grantId = `grant-${id}`
  const permissions = ["workspace.read", "board.lead.create", "board.application.advance", "board.application.source.append"]
  const definition = { kind: "automation-definition", version: 1, id: definitionId, name: id,
    type: "job-intake", typeVersion: 2, parameters: { sources: ["website", "email"] }, permissions,
    scope: { workspaceId, boardId: "board-1", grantId } }
  const approval = { definition: { signerKeyId: "owner-key", signature: "sig", payload: definition },
    grant: { signerKeyId: "owner-key", signature: "sig", payload: { kind: "workspace-grant", version: 1,
      grantId, workspaceId, personId: executorPersonId, role: "automation", accessEpoch: 1,
      automation: { version: 2, boardId: "board-1", columns: { lead: "lead", interview: "interview", rejected: "rejected" },
        fieldIds: ["company"], expiresAt: 1 } } } }
  const idControl = crypto.randomUUID()
  return { id: `automation:${id}`, kind: "automation", title: id,
    placement: { parentId: "board-1", rank: "0/1" }, archivedAt: null, createdAt: "2026-01-01", updatedAt: "2026-01-01",
    definition: JSON.stringify(definition), approval: JSON.stringify(approval),
    executor: { origin: "https://automation.example.test", personId: executorPersonId },
    controls: { [idControl]: JSON.stringify({ state, supersedes: [] }) } }
}

function document(...entities: ReturnType<typeof automation>[]): WorkspaceDocumentV2 {
  return { kind: "workspace", formatVersion: 3, id: workspaceId, title: "Workspace", archivedAt: null,
    ownerPersonId: "owner-person", migration: null, entities: Object.fromEntries(entities.map(entity => [entity.id, entity])) } as unknown as WorkspaceDocumentV2
}

function worker(id: string, integrationId = `route-${id}`): ReplicaWriterWorker {
  return { origin: "https://automation.example.test", workspaceId, definitionId: id,
    executorPersonId: `executor-${id}`, integrationId }
}

describe("workspace Rusty writer refresh cohort helper", () => {
  it("Given paused and deleted typed workers, When discovering one Rusty scope, Then include each matching route and skip other scopes", async () => {
    descriptions["matching-paused"] = { storage: { ...rusty } }
    descriptions["matching-deleted"] = { storage: { ...rusty } }
    descriptions["other-scope"] = { storage: { ...rusty, scopeId: "scope-other" } }
    const targets = await discoverWorkspaceReplicaWorkers({ readWorkspaceDoc: () => document(
      automation("matching-paused", "executor-matching-paused", "paused"),
      automation("matching-deleted", "executor-matching-deleted", "deleted"),
      automation("other-scope", "executor-other-scope", "active")), getCurrentProfile: () => profile }, config, async () => {})
    expect(targets).toEqual([worker("matching-paused"), worker("matching-deleted")])
    expect(mocks.assertSupported).toHaveBeenCalledWith("https://automation.example.test")
  })

  it("Given a real Automerge document proxy, When discovering its typed Worker routes, Then read route metadata without cloning the proxy", async () => {
    descriptions["automerge-worker"] = { storage: { ...rusty } }
    const base = Automerge.from(document(automation("automerge-worker", "executor-automerge-worker")))
    const automergeDocument = Automerge.view(base, Automerge.getHeads(base))
    await expect(discoverWorkspaceReplicaWorkers({ readWorkspaceDoc: () => automergeDocument,
      getCurrentProfile: () => profile }, config, async () => {})).resolves.toEqual([worker("automerge-worker")])
  })

  it("Given a same Rusty scope with a different epoch or service pin, When discovering, Then reject rather than skip it", async () => {
    descriptions["changed-pin"] = { storage: { ...rusty, keyEpoch: 3 } }
    await expect(discoverWorkspaceReplicaWorkers({ readWorkspaceDoc: () => document(automation("changed-pin", "executor-changed-pin")),
      getCurrentProfile: () => profile }, config, async () => {})).rejects.toThrow(/epoch 3.*expects 2/i)
    descriptions["changed-pin"] = { storage: { ...rusty, servicePublicKey: "B".repeat(43) } }
    await expect(discoverWorkspaceReplicaWorkers({ readWorkspaceDoc: () => document(automation("changed-pin", "executor-changed-pin")),
      getCurrentProfile: () => profile }, config, async () => {})).rejects.toThrow(/different Rusty service identity/i)
  })

  it("Given unsupported instance refresh, When discovering targets, Then fail before refreshing any worker", async () => {
    descriptions["unsupported"] = { storage: { ...rusty } }
    mocks.assertSupported.mockRejectedValueOnce(new Error("unsupported management capability"))
    await expect(discoverWorkspaceReplicaWorkers({ readWorkspaceDoc: () => document(automation("unsupported", "executor-unsupported")),
      getCurrentProfile: () => profile }, config, async () => {})).rejects.toThrow(/unsupported/)
    expect(mocks.refresh).not.toHaveBeenCalled()
  })

  it("Given an unexpired local automation grant with no typed route, When discovering, Then fail closed before capability preflight", async () => {
    const known = vi.spyOn(defaultProofStore, "listGrants").mockResolvedValue([{
      payload: { grantId: "unknown-live-grant", personId: "executor-without-route", role: "automation",
        automation: { expiresAt: Date.now() + 60_000 } },
    } as never])
    await expect(discoverWorkspaceReplicaWorkers({ readWorkspaceDoc: async () => document(), getCurrentProfile: () => profile }, config,
      async () => {})).rejects.toThrow(/no typed Worker route/i)
    expect(known).toHaveBeenCalledWith(workspaceId)
    expect(mocks.assertSupported).not.toHaveBeenCalled()
  })

  it("Given an older live grant for a known typed executor, When discovering after renewal, Then retain the route", async () => {
    descriptions["renewed-known"] = { storage: { ...rusty } }
    vi.spyOn(defaultProofStore, "listGrants").mockResolvedValue([{
      payload: { grantId: "previous-grant", personId: "executor-renewed-known", role: "automation",
        automation: { expiresAt: Date.now() + 60_000 } },
    } as never])
    await expect(discoverWorkspaceReplicaWorkers({ readWorkspaceDoc: async () => document(
      automation("renewed-known", "executor-renewed-known")), getCurrentProfile: () => profile }, config, async () => {}))
      .resolves.toEqual([worker("renewed-known")])
  })

  it("Given an unexpired grant and a current-owner signed revocation, When checking unrouted grants, Then ignore only the verified revoked grant", async () => {
    resetIdentityStorageForTest()
    try {
      const owner = await bootstrapIdentity("Workspace owner")
      const executorPersonId = "executor-revoked"
      const grant = await createAutomationWorkspaceGrant(owner, workspaceId, executorPersonId, {
        version: 2, boardId: "board-1", columns: { lead: "lead", interview: "interview", rejected: "rejected" },
        fieldIds: ["company"], expiresAt: Date.now() + 60_000,
      }, 1)
      const revocation = await createWorkspaceRevocation(owner, workspaceId, executorPersonId, 2, ["workspace-head"])
      mocks.readAuthority.mockResolvedValue({ authority: { version: 1, workspaceId, ownerPersonId: owner.identity.personId,
        ownerPublicKey: owner.identity.publicKey, ownerCertificates: [owner.certificate], epoch: 2,
        updatedAt: new Date().toISOString(), catalog: { revocations: [revocation] } }, invalid: false })
      vi.spyOn(defaultProofStore, "listGrants").mockResolvedValue([grant])

      await expect(discoverWorkspaceReplicaWorkers({ readWorkspaceDoc: async () => document(), getCurrentProfile: () => owner },
        config, async () => {})).resolves.toEqual([])
      expect(mocks.readAuthority).toHaveBeenCalledWith(workspaceId)
    } finally { resetIdentityStorageForTest() }
  })

  it("Given a forged or unavailable revocation record, When checking an unknown live grant, Then fail closed", async () => {
    const grant = { payload: { grantId: "unknown-live-grant", workspaceId, personId: "executor-without-route",
      role: "automation", accessEpoch: 1, automation: { expiresAt: Date.now() + 60_000 } } } as never
    vi.spyOn(defaultProofStore, "listGrants").mockResolvedValue([grant])
    mocks.readAuthority.mockResolvedValue({ authority: { ownerPersonId: "owner-person", ownerPublicKey: "unused",
      ownerCertificates: [], catalog: { revocations: [{ payload: { personId: "executor-without-route", epoch: 9 } }] } }, invalid: false })
    await expect(discoverWorkspaceReplicaWorkers({ readWorkspaceDoc: async () => document(), getCurrentProfile: () => profile },
      config, async () => {})).rejects.toThrow()
    expect(mocks.assertSupported).not.toHaveBeenCalled()

    mocks.readAuthority.mockResolvedValue({ authority: null, invalid: true })
    await expect(discoverWorkspaceReplicaWorkers({ readWorkspaceDoc: async () => document(), getCurrentProfile: () => profile },
      config, async () => {})).rejects.toThrow(/authority/i)
  })

  it("Given a typed automation route, When its inspection fails, Then identify the automation dependency and retain the original exception", async () => {
    descriptions["inspection-failure"] = { storage: { ...rusty } }
    const original = new Error("Module terminated")
    mocks.inspect.mockRejectedValueOnce(original)
    const failure = await discoverWorkspaceReplicaWorkers({ readWorkspaceDoc: async () => document(
      automation("inspection-failure", "executor-inspection-failure")), getCurrentProfile: () => profile }, config, async () => {})
      .catch(error => error)
    expect(failure).toBeInstanceOf(AutomationWriterDependencyError)
    expect(failure).toMatchObject({ stage: "inspection", cause: original })
    expect(mocks.refresh).not.toHaveBeenCalled()
  })

  it("Given a pending policy refresh, When automation confirmation fails, Then identify its stage and stop before the next participant", async () => {
    const original = new Error("Module terminated")
    mocks.refresh.mockRejectedValueOnce(original)
    const failure = await refreshWorkspaceReplicaWorkers(profile, config, receipt,
      [worker("first"), worker("second")], async () => {}).catch(error => error)
    expect(failure).toBeInstanceOf(AutomationWriterDependencyError)
    expect(failure).toMatchObject({ stage: "confirmation", cause: original })
    expect(mocks.refresh).toHaveBeenCalledOnce()
  })

  it("Given confirmed policy and captured routes, When refreshing, Then retain grant state and bind the receipt to exact storage", async () => {
    const targets = [worker("first"), worker("second")]
    await refreshWorkspaceReplicaWorkers(profile, config, receipt, targets, async () => {})
    expect(mocks.read).toHaveBeenCalledTimes(2)
    expect(mocks.refresh).toHaveBeenCalledTimes(2)
    expect(mocks.refresh.mock.calls[0]?.[1]).toMatchObject({ ...targets[0], storage: {
      origin: rusty.origin, scopeId: rusty.scopeId, keyEpoch: rusty.keyEpoch, servicePublicKey: rusty.servicePublicKey,
    }, receipt })
  })

  it("Given changed grant state or a stale guard, When refresh completes, Then reject without continuing the cohort", async () => {
    const targets = [worker("first"), worker("second")]
    mocks.refresh.mockResolvedValueOnce({ identity: { origin: targets[0]!.origin, workspaceId, definitionId: "first",
      integrationId: targets[0]!.integrationId, executorPersonId: targets[0]!.executorPersonId, description: {
        grantId: "changed-grant", expiresAt: 42, state: "paused", storage: { ...rusty, policyRevision: 3, minimumWriterVersion: 2 } } } })
    await expect(refreshWorkspaceReplicaWorkers(profile, config, receipt, targets, async () => {})).rejects.toThrow(/grant|unchanged|state/i)
    expect(mocks.refresh).toHaveBeenCalledTimes(1)

    mocks.refresh.mockReset().mockImplementation(async (_profile, input) => ({ identity: { origin: input.origin,
      workspaceId, definitionId: input.definitionId, integrationId: input.integrationId,
      executorPersonId: input.executorPersonId, description: { grantId: `grant-${input.definitionId}`, expiresAt: 42,
        state: "paused", storage: { ...input.storage, policyRevision: 3, minimumWriterVersion: 2 } } } }))
    let checks = 0
    await expect(refreshWorkspaceReplicaWorkers(profile, config, receipt, targets, () => {
      checks++
      if (checks > 3) throw new Error("workspace changed")
    })).rejects.toThrow("workspace changed")
    expect(mocks.refresh.mock.calls.length).toBeLessThan(2)
  })
})
