import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { bootstrapIdentity, resetIdentityStorageForTest, type LocalProfile } from "../domain/identity"
import { deleteLocal, writeLocal } from "../localDb"
import { publicationRecordKey } from "../domain/publicationState"
import { createIdentityRegistrationGate } from "./identityRegistrationGate"
import { createIdentityOwnerActions } from "./identityOwnerActions"

const origin = "https://rusty.example"
let profile: LocalProfile
let board = { boardId: "board-a", workspaceId: "workspace-a", sourceHeads: ["head-a"] }
const recordKey = () => publicationRecordKey(origin, board.workspaceId, board.boardId, profile)

beforeEach(async () => {
  resetIdentityStorageForTest()
  profile = await bootstrapIdentity("Owner")
  board = { boardId: "board-a", workspaceId: "workspace-a", sourceHeads: ["head-a"] }
  await deleteLocal(recordKey())
})
afterEach(async () => {
  await deleteLocal(recordKey())
  resetIdentityStorageForTest()
})

function setup(options: { registrationResult?: boolean; published?: boolean; revision?: number } = {}) {
  const registration = vi.fn(async () => options.registrationResult ?? false)
  const gate = createIdentityRegistrationGate({ configured: true, getProfile: () => profile,
    refreshIdentity: async () => {}, requestRegistration: registration })
  const setPublic = vi.fn(async () => {})
  const addMyDevice = vi.fn(async () => {})
  const owner = createIdentityOwnerActions({ gate, portalOrigin: "https://identity.example",
    publicAccess: { origin: { value: origin }, published: { value: options.published ?? false }, revision: { value: options.revision ?? 0 }, setPublic },
    getProfile: () => profile, getBoard: () => board, isOwner: () => true,
    addMyDevice, isSyncChooserOpen: () => true })
  return { owner, registration, setPublic, addMyDevice }
}

it("Given a first publication, when Identity registration is cancelled, then the board is not published", async () => {
  const { owner, registration, setPublic } = setup()

  await owner.setPublic(true)

  expect(registration).toHaveBeenCalledOnce()
  expect(setPublic).not.toHaveBeenCalled()
})

it("Given a board with prior owner publication intent, when its remote copy is missing, then recovery does not gate or republish it", async () => {
  await writeLocal(recordKey(), JSON.stringify({ version: 1, origin, workspaceId: board.workspaceId, boardId: board.boardId,
    ownerPersonId: profile.identity.personId, ownerIntent: "published", confirmedRevision: 4,
    confirmedHash: "known-hash", remoteAvailability: "missing" }))
  const { owner, registration, setPublic } = setup()

  await owner.setPublic(true)

  expect(registration).not.toHaveBeenCalled()
  expect(setPublic).toHaveBeenCalledWith(true)
})

it("Given an explicit withdrawal, when the owner withdraws, then do not start enrollment", async () => {
  const { owner, registration, setPublic } = setup()

  await owner.setPublic(false)

  expect(registration).not.toHaveBeenCalled()
  expect(setPublic).toHaveBeenCalledWith(false)
})

it("Given an unregistered owner, when Add my device enrollment is cancelled, then the sync action does not run", async () => {
  const { owner, registration, addMyDevice } = setup()

  await owner.addMyDevice()

  expect(registration).toHaveBeenCalledOnce()
  expect(addMyDevice).not.toHaveBeenCalled()
})
