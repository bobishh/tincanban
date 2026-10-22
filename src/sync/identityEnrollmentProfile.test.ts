import * as Automerge from "@automerge/automerge"
import { beforeEach, expect, it } from "vitest"
import { bootstrapIdentity, resetIdentityStorageForTest } from "../domain/identity"
import { createPersonalRoot } from "../domain/personalRoot"
import { editIdentityProfileRoot, rootIdentityProfileState } from "../domain/identityProfileRoot"
import { identityProfileRevision } from "../domain/identityProfileRevision"
import { identityProfileValue } from "../domain/identityProfileState"
import { defaultStorage } from "../storage"
import { createIdentityEnrollmentProfileStore } from "./identityEnrollmentProfile"

beforeEach(resetIdentityStorageForTest)

it("Given an unchanged signed profile, when the sync adapter reloads it, then reuse the same Automerge history", async () => {
  const profile = await bootstrapIdentity("Original")
  await defaultStorage.savePersonalRoot(createPersonalRoot(profile, "certificate"))
  const store = createIdentityEnrollmentProfileStore(profile)

  const first = await store.current()
  const reloadedStore = createIdentityEnrollmentProfileStore(profile)
  const second = await reloadedStore.current()

  expect(Automerge.getHeads(second)).toEqual(Automerge.getHeads(first))

  const expectedRevision = await identityProfileRevision(second.profileState)
  await reloadedStore.commit(second, expectedRevision)
  const afterNoOp = await createIdentityEnrollmentProfileStore(profile).current()
  expect(Automerge.getHeads(afterNoOp)).toEqual(Automerge.getHeads(first))

  const root = await defaultStorage.loadPersonalRoot()
  const updatedRoot = await editIdentityProfileRoot(root!, profile, "name", "Synced name")
  await defaultStorage.savePersonalRoot(updatedRoot)
  const afterSignedChange = await createIdentityEnrollmentProfileStore(profile).current()
  expect(afterSignedChange.profileState.operations).toHaveLength(1)
  expect(Automerge.getHeads(afterSignedChange)).not.toEqual(Automerge.getHeads(afterNoOp))
  const afterReload = await createIdentityEnrollmentProfileStore(profile).current()
  expect(Automerge.getHeads(afterReload)).toEqual(Automerge.getHeads(afterSignedChange))
})

it("Given a locally changed signed profile, when a paired replica commits its next operation, then merge through the existing root history", async () => {
  const profile = await bootstrapIdentity("Original")
  const initialRoot = createPersonalRoot(profile, "certificate")
  await defaultStorage.savePersonalRoot(initialRoot)
  const store = createIdentityEnrollmentProfileStore(profile)
  const baseDocument = await store.current()
  const root = await editIdentityProfileRoot(initialRoot, profile, "name", "Updated")
  const incomingRoot = await editIdentityProfileRoot(root, profile, "photo", {
    avatarData: null,
    changedAt: "2026-01-01T00:00:00.000Z",
  })
  await defaultStorage.savePersonalRoot(root)
  const currentState = await rootIdentityProfileState(root)
  const document = Automerge.change(baseDocument, draft => {
    draft.profileState = incomingRoot.profileState!
  })

  await store.commit(document, await identityProfileRevision(currentState))

  const saved = await defaultStorage.loadPersonalRoot()
  const savedState = await rootIdentityProfileState(saved!)
  expect(savedState.operations).toHaveLength(2)
  expect(identityProfileValue(savedState, "name")).toEqual({ status: "value", values: ["Updated"] })
  expect(identityProfileValue(savedState, "photo")).toMatchObject({ status: "value", values: [{ avatarData: null }] })
  const syncedDocument = await createIdentityEnrollmentProfileStore(profile).current()
  expect(syncedDocument.profileState.operations).toHaveLength(2)
  const syncedHeads = Automerge.getHeads(syncedDocument)
  const reloadedDocument = await createIdentityEnrollmentProfileStore(profile).current()
  expect(Automerge.getHeads(reloadedDocument)).toEqual(syncedHeads)
})

it("Given the personal root changed after sync began, when a stale candidate commits, then preserve the newer root unchanged", async () => {
  const profile = await bootstrapIdentity("Original")
  let root = await editIdentityProfileRoot(createPersonalRoot(profile, "certificate"), profile, "name", "Updated")
  await defaultStorage.savePersonalRoot(root)
  const expected = await identityProfileRevision(await rootIdentityProfileState(root))
  const candidate = await editIdentityProfileRoot(root, profile, "photo", {
    avatarData: null,
    changedAt: "2026-01-01T00:00:00.000Z",
  })
  await defaultStorage.updatePersonalRootForIdentity(profile.identity.personId, async current => {
    if (!current) throw new Error("Root disappeared")
    return await editIdentityProfileRoot(current, profile, "name", "Newest")
  })
  const before = await defaultStorage.loadPersonalRoot()
  const store = createIdentityEnrollmentProfileStore(profile)
  const document = Automerge.from({
    kind: "mesh-personal-identity" as const,
    version: 1 as const,
    personId: profile.identity.personId,
    identityPublicKey: profile.identity.publicKey,
    certificates: [profile.certificate],
    profileState: candidate.profileState!,
  })

  await expect(store.commit(document, expected)).rejects.toThrow(/profile changed/i)

  expect(await defaultStorage.loadPersonalRoot()).toEqual(before)
  root = before!
  expect(identityProfileValue(await rootIdentityProfileState(root), "name")).toEqual({ status: "value", values: ["Newest"] })
})
