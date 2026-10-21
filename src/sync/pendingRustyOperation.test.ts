import { beforeEach, expect, it, vi } from "vitest"
import type { LocalProfile } from "../domain/identity"

const saved = vi.hoisted(() => ({ freeze: undefined as unknown, conflict: undefined as unknown, journal: undefined as unknown,
  recover: vi.fn(), revoke: vi.fn() }))
vi.mock("./replicaCredentialFreeze", () => ({ readReplicaCredentialFreeze: async () => saved.freeze }))
vi.mock("./replicaCredentialTransitionJournal", () => ({ readCredentialTransitionJournal: async () => saved.journal }))
vi.mock("./replicaCredentialConflictWorkflow", () => ({ readPendingRustyCredentialConflict: async () => saved.conflict,
  recoverRustyCredentialConflict: saved.recover }))
vi.mock("./rustyCredentialTransition", () => ({ revokeRustyIdentityDevice: saved.revoke }))
import { readPendingRustyOperation, resumePendingRustyOperation } from "./pendingRustyOperation"
const profile = { identity: { personId: "person" }, device: { deviceId: "signer" } } as LocalProfile
const origin = "https://rusty.example"
const app = { getCurrentProfile: () => profile } as Parameters<typeof resumePendingRustyOperation>[0]
beforeEach(() => { saved.freeze = undefined; saved.conflict = undefined; saved.journal = undefined; vi.clearAllMocks() })

it("Given a saved conflict on another board, when inspecting a frozen server, then expose its original recovery scope", async () => {
  saved.freeze = { kind: "rusty-credential-conflict-freeze", signerDeviceId: "signer", scopeId: "scope",
    proposal: { next: { workspaceId: "original-board" } } }
  expect(await readPendingRustyOperation(profile, origin)).toEqual({ origin, kind: "conflict", signerDeviceId: "signer",
    scopeId: "scope", workspaceId: "original-board" })
  await resumePendingRustyOperation(app, origin, () => {})
  expect(saved.recover).toHaveBeenCalledWith(app, origin, "scope", "original-board", expect.any(Function))
})
it("Given a device removal froze before its journal, when retrying, then resume the captured device without starting another removal", async () => {
  saved.freeze = { signerDeviceId: "signer", revokedDeviceId: "old-device", resources: [] }
  await resumePendingRustyOperation(app, origin, () => {})
  expect(saved.revoke).toHaveBeenCalledWith(app, origin, "old-device", expect.any(Function))
  expect(saved.recover).not.toHaveBeenCalled()
})
it("Given a transition belongs to another device, when retrying, then reject without changing credentials", async () => {
  saved.freeze = { signerDeviceId: "other-device", revokedDeviceId: "old-device", resources: [] }
  await expect(resumePendingRustyOperation(app, origin, () => {})).rejects.toThrow(/device that started/)
  expect(saved.revoke).not.toHaveBeenCalled()
})
it("Given activation removed the freeze but snapshot confirmation remains, when inspecting, then retain its retry action", async () => {
  saved.conflict = { signerDeviceId: "signer", scopeId: "scope", workspaceIds: ["board"], identityState: false }
  expect(await readPendingRustyOperation(profile, origin)).toMatchObject({ kind: "conflict", workspaceId: "board" })
})

it("Given a device-removal journal stopped during automation discovery, when inspecting it, then expose its next phase without leaking retained keys", async () => {
  saved.freeze = { signerDeviceId: "signer", revokedDeviceId: "old-device", resources: [
    { previous: { purpose: "workspace", scopeId: "one", contentKey: "private-key" } },
    { previous: { purpose: "workspace", scopeId: "two" } },
    { previous: { purpose: "identity", scopeId: "profile" } },
  ] }
  saved.journal = { freeze: saved.freeze, cohorts: ["one"], workers: [{ scopeId: "one" }], scopes: [] }
  const status = await readPendingRustyOperation(profile, origin)
  expect(status).toMatchObject({ kind: "device-revocation", progress: { phase: "checking-automations", scopeCount: 3,
    confirmedScopes: 0, workerCount: 1, frozenWorkers: 0, rotatedWorkers: 0, personConfirmed: false } })
  expect(JSON.stringify(status)).not.toContain("private-key")
})
it("Given already activated credentials awaiting snapshots, when inspecting the retained removal, then report snapshot confirmation instead of a new transition", async () => {
  saved.journal = { freeze: { signerDeviceId: "signer", revokedDeviceId: "old-device", resources: [] },
    cohorts: [], workers: [], scopes: [], person: {}, activated: [] }
  expect(await readPendingRustyOperation(profile, origin)).toMatchObject({ kind: "device-revocation", progress: { phase: "confirming-snapshots" } })
})
