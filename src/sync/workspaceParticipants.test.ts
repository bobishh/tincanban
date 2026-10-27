import { beforeEach, expect, test, vi } from "vitest"
import { bootstrapIdentity, resetIdentityStorageForTest } from "../domain/identity"
import { createRecoverableIdentity } from "@meta-uber/mesh-identity"
import { createWorkspaceGrant, createWorkspaceRevocation, createWorkspaceDeparture } from "./meshRecords"
import { readWorkspaceParticipantGrant, readWorkspaceParticipants } from "./workspaceParticipants"
import type * as AuthorizationModule from "./changeAuthorization"
import type { WorkspaceAuthorityRecord } from "./peerStore"
import type { WorkspaceGrant } from "../domain/model"
const stored = vi.hoisted(() => ({ authority: null as WorkspaceAuthorityRecord | null,
  invalid: false, grants: [] as WorkspaceGrant[], history: [] as Array<{ grant: WorkspaceGrant }> }))
vi.mock("./changeAuthorization", async original => ({ ...await original<typeof AuthorizationModule>(), readWorkspaceSigningAuthority: async () => ({ authority: stored.authority, invalid: stored.invalid }) }))
vi.mock("../domain/proofs", async original => ({ ...await original<Record<string, unknown>>(),
  defaultProofStore: { listGrants: async () => stored.grants } }))
vi.mock("./workspaceChangeProofStore", () => ({ records: async () => stored.history }))
beforeEach(() => { resetIdentityStorageForTest(); stored.invalid = false; stored.grants = []; stored.history = []; stored.authority = null })
async function fixture() {
  const owner = await bootstrapIdentity("Owner")
  const editor = (await createRecoverableIdentity("better", "Editor")).profile
  const visitor = (await createRecoverableIdentity("better", "Visitor")).profile
  stored.authority = { version: 1, workspaceId: "board", ownerPersonId: owner.identity.personId,
    ownerPublicKey: owner.identity.publicKey, ownerCertificates: [owner.certificate], epoch: 1, updatedAt: new Date().toISOString() }
  stored.grants = [await createWorkspaceGrant(owner, "board", editor.identity.personId, "editor"),
    await createWorkspaceGrant(owner, "board", visitor.identity.personId, "visitor")]
  return { owner, editor, visitor }
}
test("Given stored signed access without transport peers, when reading participants, then retain owner, editor and visitor", async () => {
  const { owner, editor, visitor } = await fixture()
  expect(await readWorkspaceParticipants("board")).toEqual(expect.arrayContaining([
    { personId: owner.identity.personId, role: "owner" }, { personId: editor.identity.personId, role: "editor" },
    { personId: visitor.identity.personId, role: "visitor" },
  ]))
})
test("Given a removed member and a foreign or forged grant, when reading participants, then reject their obsolete or unverified access", async () => {
  const { owner, editor, visitor } = await fixture()
  stored.authority!.catalog = { revocations: [await createWorkspaceRevocation(owner, "board", editor.identity.personId, 2, ["history-head"])] }
  const foreign = await createWorkspaceGrant(owner, "another-board", "foreign", "editor")
  stored.grants.push(foreign, { ...stored.grants[1]!, payload: { ...stored.grants[1]!.payload, personId: "forged" } })
  expect(await readWorkspaceParticipants("board")).toEqual(expect.arrayContaining([{ personId: visitor.identity.personId, role: "visitor" }]))
  expect((await readWorkspaceParticipants("board")).map(person => person.personId)).not.toContain(editor.identity.personId)
  expect((await readWorkspaceParticipants("board")).map(person => person.personId)).not.toContain("foreign")
  expect((await readWorkspaceParticipants("board")).map(person => person.personId)).not.toContain("forged")
})
test("Given invalid durable authority, when participants load, then do not invent membership from retained profile names", async () => {
  await fixture(); stored.invalid = true
  expect(await readWorkspaceParticipants("board")).toEqual([])
})

test("Given a restored history carries a member grant without local proof-store or peer records, when reading participants, then recover that verified member", async () => {
  const { editor } = await fixture()
  stored.history = [{ grant: stored.grants[0]! }]; stored.grants = []
  expect(await readWorkspaceParticipants("board")).toContainEqual({ personId: editor.identity.personId, role: "editor" })
})
test("Given a member left and later received a newer access generation, when reading participants, then reject old access and retain only the renewed grant", async () => {
  const { owner, editor } = await fixture()
  stored.authority!.catalog = { departures: [await createWorkspaceDeparture(editor, "board", 1, ["history-head"], [editor.certificate])] }
  expect((await readWorkspaceParticipants("board")).map(person => person.personId)).not.toContain(editor.identity.personId)
  stored.grants.push(await createWorkspaceGrant(owner, "board", editor.identity.personId, "visitor", 2))
  expect(await readWorkspaceParticipants("board")).toContainEqual({ personId: editor.identity.personId, role: "visitor" })
})

test("Given an admitted peer carries a grant missing from local proof storage, when resolving access, then verify and use it as candidate evidence", async () => {
  const { owner, editor } = await fixture()
  const candidate = await createWorkspaceGrant(owner, "board", editor.identity.personId, "visitor", 2)
  expect(await readWorkspaceParticipantGrant("board", editor.identity.personId, candidate)).toEqual(candidate)
})

test("Given a peer grant is older than the latest saved grant, when resolving access, then use the latest verified epoch", async () => {
  const { owner, editor } = await fixture()
  const latest = await createWorkspaceGrant(owner, "board", editor.identity.personId, "visitor", 2)
  stored.grants.push(latest)
  expect(await readWorkspaceParticipantGrant("board", editor.identity.personId, stored.grants[0])).toEqual(latest)
})

test("Given the candidate membership grant is revoked, when resolving access, then return no active grant", async () => {
  const { owner, editor } = await fixture()
  const candidate = stored.grants.find(grant => grant.payload.personId === editor.identity.personId)!
  stored.authority!.catalog = { revocations: [await createWorkspaceRevocation(owner, "board", editor.identity.personId, 2, ["history-head"])] }
  expect(await readWorkspaceParticipantGrant("board", editor.identity.personId, candidate)).toBeUndefined()
})
