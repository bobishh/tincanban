import * as Automerge from "@automerge/automerge"
import { normalizePersonalIdentityDocument, type PersonalIdentityDocument } from "@meta-uber/mesh-replication/identity-mesh"
import { canonicalizeJson, createIdentityAuthorityView,
  readIdentityProfileStateWithRevocations } from "@meta-uber/mesh-identity"
import type { LocalProfile } from "../domain/identity"
import { certHashDefault, defaultProofStore } from "../domain/proofs"
import { identityProfileRevision } from "../domain/identityProfileRevision"
import { mergeIdentityProfileState } from "../domain/identityProfileState"
import { projectIdentityProfileRoot, rootIdentityProfileState } from "../domain/identityProfileRoot"
import { defaultStorage, type WorkspaceStorage } from "../storage"
import type { DeviceCertificate } from "../domain/model"
import { readLocal, updateLocal } from "../localDb"
import { mergeIdentityAuthorityView, requireIdentityAuthorityView } from "./identityAuthorityStore"

const documentSnapshotPrefix = "tincanban.identity-mesh-document.v1."

/** Adapter keeps signed profile history authoritative in the existing personal root. */
export function createIdentityEnrollmentProfileStore(
  profile: LocalProfile,
  storage: Pick<WorkspaceStorage, "loadPersonalRoot" | "updatePersonalRootForIdentity"> = defaultStorage,
  proofStore: Pick<typeof defaultProofStore, "listCertificates" | "putCertificate"> = defaultProofStore,
) {
  const identity = structuredClone(profile.identity)

  const snapshotKey = `${documentSnapshotPrefix}${identity.personId}.${profile.device.deviceId}`

  function decodeSnapshot(raw: string): Automerge.Doc<PersonalIdentityDocument> {
    try {
      const bytes = Uint8Array.from(atob(raw), char => char.charCodeAt(0))
      const document = Automerge.load<PersonalIdentityDocument>(bytes)
      if (document.kind !== "mesh-personal-identity" || ![1, 2].includes((document as unknown as { version: number }).version) ||
          document.personId !== identity.personId || document.identityPublicKey !== identity.publicKey) {
        throw new Error("Saved Identity mesh document belongs to another person")
      }
      return document
    } catch (cause) {
      if (cause instanceof Error && cause.message === "Saved Identity mesh document belongs to another person") throw cause
      throw new Error("Saved Identity mesh document is invalid", { cause })
    }
  }

  async function persistSnapshot(candidate: Automerge.Doc<PersonalIdentityDocument>): Promise<Automerge.Doc<PersonalIdentityDocument>> {
    const raw = await updateLocal(snapshotKey, currentRaw => {
      if (!currentRaw) return encodeSnapshot(candidate)
      const currentDocument = decodeSnapshot(currentRaw)
      const merged = Automerge.merge(Automerge.clone(currentDocument), candidate)
      if (canonicalizeJson(Automerge.getHeads(merged)) === canonicalizeJson(Automerge.getHeads(currentDocument))) return currentRaw
      return encodeSnapshot(merged)
    })
    return decodeSnapshot(raw)
  }

  async function currentDocument(): Promise<Automerge.Doc<PersonalIdentityDocument>> {
    const root = await storage.loadPersonalRoot()
    if (!root || root.identity.personId !== identity.personId || root.identity.publicKey !== identity.publicKey) {
      throw new Error("Personal Identity root is unavailable")
    }
    const rootState = await rootIdentityProfileState(root)
    const currentView = await requireIdentityAuthorityView(identity.personId)
    const currentCertificates = currentView.certificates
    const raw = await readLocal(snapshotKey)
    if (!raw) {
      const initial = Automerge.from<PersonalIdentityDocument>({ kind: "mesh-personal-identity", version: 2,
        personId: identity.personId, identityPublicKey: identity.publicKey,
        certificates: currentCertificates, revocations: currentView.revocations, profileState: rootState })
      return persistSnapshot(initial)
    }

    const saved = await normalizePersonalIdentityDocument(decodeSnapshot(raw), identity)
    const savedView = await createIdentityAuthorityView(identity,
      { certificates: saved.certificates, revocations: saved.revocations }, saved.profileState)
    const storedView = await mergeIdentityAuthorityView(savedView)
    const profileState = await readIdentityProfileStateWithRevocations(
      await mergeIdentityProfileState(saved.profileState, rootState, identity), identity,
      storedView.certificates, storedView.revocations)
    if (canonicalizeJson(saved.certificates) === canonicalizeJson(storedView.certificates) &&
        canonicalizeJson(saved.revocations) === canonicalizeJson(storedView.revocations) &&
        canonicalizeJson(saved.profileState) === canonicalizeJson(profileState) && saved.version === 2) return saved
    const reconciled = Automerge.change(Automerge.clone(saved), "Reconcile signed Identity root", draft => {
      draft.certificates = structuredClone(storedView.certificates)
      draft.revocations = structuredClone(storedView.revocations)
      draft.profileState = profileState
    })
    return persistSnapshot(reconciled)
  }

  return {
    async current(): Promise<Automerge.Doc<PersonalIdentityDocument>> {
      return currentDocument()
    },

    async commit(document: Automerge.Doc<PersonalIdentityDocument>, expectedProfileRevision: string): Promise<void> {
      let candidate = structuredClone(document as unknown as PersonalIdentityDocument)
      if (candidate.kind !== "mesh-personal-identity" || candidate.version !== 2 ||
          candidate.personId !== identity.personId || candidate.identityPublicKey !== identity.publicKey) {
        throw new Error("Identity sync document belongs to another person")
      }
      const incomingView = await createIdentityAuthorityView(identity,
        { certificates: candidate.certificates, revocations: candidate.revocations ?? [] }, candidate.profileState)
      const storedView = await mergeIdentityAuthorityView(incomingView)
      const incomingState = await readIdentityProfileStateWithRevocations(candidate.profileState, identity,
        storedView.certificates, storedView.revocations)
      candidate = { ...candidate, version: 2, certificates: structuredClone(storedView.certificates),
        revocations: structuredClone(storedView.revocations), profileState: incomingState }
      let committedCertificates: DeviceCertificate[] = []
      let committedProfileState = incomingState
      await storage.updatePersonalRootForIdentity(identity.personId, async current => {
        if (!current || current.identity.personId !== identity.personId || current.identity.publicKey !== identity.publicKey) {
          throw new Error("Personal Identity root is unavailable")
        }
        const currentState = await rootIdentityProfileState(current)
        if (await identityProfileRevision(currentState) !== expectedProfileRevision) {
          throw new Error("Identity profile changed while sync was in progress")
        }
        const merged = await readIdentityProfileStateWithRevocations(
          await mergeIdentityProfileState(currentState, incomingState, identity), identity,
          storedView.certificates, storedView.revocations)
        committedProfileState = merged
        committedCertificates = candidate.certificates.filter(certificate => certificate.payload.personId === identity.personId)
        return projectIdentityProfileRoot(current, merged)
      })
      for (const certificate of committedCertificates) {
        await proofStore.putCertificate(await certHashDefault(certificate), certificate)
      }
      const documentIsCurrent = document.version === 2 &&
        canonicalizeJson(document.certificates) === canonicalizeJson(storedView.certificates) &&
        canonicalizeJson(document.revocations) === canonicalizeJson(storedView.revocations) &&
        canonicalizeJson(document.profileState) === canonicalizeJson(committedProfileState)
      if (documentIsCurrent) {
        await persistSnapshot(document)
      } else {
        const committed = Automerge.change(Automerge.clone(document), "Persist merged Identity authority", draft => {
          draft.certificates = structuredClone(storedView.certificates)
          draft.revocations = structuredClone(storedView.revocations)
          draft.profileState = structuredClone(committedProfileState)
        })
        await persistSnapshot(committed)
      }
    },
  }
}

function encodeSnapshot(document: Automerge.Doc<PersonalIdentityDocument>): string {
  const bytes = Automerge.save(document)
  let binary = ""
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}
