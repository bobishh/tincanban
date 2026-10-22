import * as Automerge from "@automerge/automerge"
import type { PersonalIdentityDocument } from "@meta-uber/mesh-replication/identity-mesh"
import { canonicalizeJson } from "@meta-uber/mesh-identity"
import type { LocalProfile } from "../domain/identity"
import { certHashDefault, defaultProofStore } from "../domain/proofs"
import { identityProfileRevision } from "../domain/identityProfileRevision"
import { mergeIdentityProfileState, readIdentityProfileState } from "../domain/identityProfileState"
import { projectIdentityProfileRoot, rootIdentityProfileState } from "../domain/identityProfileRoot"
import { defaultStorage, type WorkspaceStorage } from "../storage"
import type { DeviceCertificate } from "../domain/model"
import { readLocal, updateLocal } from "../localDb"

const documentSnapshotPrefix = "tincanban.identity-mesh-document.v1."

/** Adapter keeps signed profile history authoritative in the existing personal root. */
export function createIdentityEnrollmentProfileStore(
  profile: LocalProfile,
  storage: Pick<WorkspaceStorage, "loadPersonalRoot" | "updatePersonalRootForIdentity"> = defaultStorage,
  proofStore: Pick<typeof defaultProofStore, "listCertificates" | "putCertificate"> = defaultProofStore,
) {
  const identity = structuredClone(profile.identity)

  async function certificates(): Promise<DeviceCertificate[]> {
    const values = [profile.certificate, ...await proofStore.listCertificates()]
      .filter(certificate => certificate.payload.personId === identity.personId)
    const byDevice = new Map<string, DeviceCertificate>()
    for (const certificate of values) {
      const previous = byDevice.get(certificate.payload.deviceId)
      if (previous && canonicalizeJson(previous) !== canonicalizeJson(certificate)) {
        throw new Error("Identity device certificate conflict")
      }
      byDevice.set(certificate.payload.deviceId, structuredClone(certificate))
    }
    return [...byDevice.values()].sort((left, right) => left.payload.deviceId.localeCompare(right.payload.deviceId))
  }

  const snapshotKey = `${documentSnapshotPrefix}${identity.personId}.${profile.device.deviceId}`

  function decodeSnapshot(raw: string): Automerge.Doc<PersonalIdentityDocument> {
    try {
      const bytes = Uint8Array.from(atob(raw), char => char.charCodeAt(0))
      const document = Automerge.load<PersonalIdentityDocument>(bytes)
      if (document.kind !== "mesh-personal-identity" || document.version !== 1 ||
          document.personId !== identity.personId || document.identityPublicKey !== identity.publicKey) {
        throw new Error("Saved Identity mesh document belongs to another person")
      }
      return document
    } catch (cause) {
      if (cause instanceof Error && cause.message === "Saved Identity mesh document belongs to another person") throw cause
      throw new Error("Saved Identity mesh document is invalid", { cause })
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
    const currentCertificates = await certificates()
    const raw = await readLocal(snapshotKey)
    if (!raw) {
      const initial = Automerge.from<PersonalIdentityDocument>({ kind: "mesh-personal-identity", version: 1,
        personId: identity.personId, identityPublicKey: identity.publicKey,
        certificates: currentCertificates, profileState: rootState })
      return persistSnapshot(initial)
    }

    const saved = decodeSnapshot(raw)
    const mergedCertificates = new Map<string, DeviceCertificate>()
    for (const certificate of [...saved.certificates, ...currentCertificates]) {
      const previous = mergedCertificates.get(certificate.payload.deviceId)
      if (previous && canonicalizeJson(previous) !== canonicalizeJson(certificate)) {
        throw new Error("Identity device certificate conflict")
      }
      mergedCertificates.set(certificate.payload.deviceId, structuredClone(certificate))
    }
    const certificatesValue = [...mergedCertificates.values()].sort((left, right) =>
      left.payload.deviceId.localeCompare(right.payload.deviceId))
    const profileState = await mergeIdentityProfileState(saved.profileState, rootState, identity)
    if (canonicalizeJson(saved.certificates) === canonicalizeJson(certificatesValue) &&
        canonicalizeJson(saved.profileState) === canonicalizeJson(profileState)) return saved
    const reconciled = Automerge.change(Automerge.clone(saved), "Reconcile signed Identity root", draft => {
      draft.certificates = certificatesValue
      draft.profileState = profileState
    })
    return persistSnapshot(reconciled)
  }

  return {
    async current(): Promise<Automerge.Doc<PersonalIdentityDocument>> {
      return currentDocument()
    },

    async commit(document: Automerge.Doc<PersonalIdentityDocument>, expectedProfileRevision: string): Promise<void> {
      const candidate = structuredClone(document as unknown as PersonalIdentityDocument)
      if (candidate.kind !== "mesh-personal-identity" || candidate.version !== 1 ||
          candidate.personId !== identity.personId || candidate.identityPublicKey !== identity.publicKey) {
        throw new Error("Identity sync document belongs to another person")
      }
      const incomingState = await readIdentityProfileState(candidate.profileState, identity)
      let committedCertificates: DeviceCertificate[] = []
      await storage.updatePersonalRootForIdentity(identity.personId, async current => {
        if (!current || current.identity.personId !== identity.personId || current.identity.publicKey !== identity.publicKey) {
          throw new Error("Personal Identity root is unavailable")
        }
        const currentState = await rootIdentityProfileState(current)
        if (await identityProfileRevision(currentState) !== expectedProfileRevision) {
          throw new Error("Identity profile changed while sync was in progress")
        }
        const merged = await mergeIdentityProfileState(currentState, incomingState, identity)
        committedCertificates = candidate.certificates.filter(certificate => certificate.payload.personId === identity.personId)
        return projectIdentityProfileRoot(current, merged)
      })
      for (const certificate of committedCertificates) {
        await proofStore.putCertificate(await certHashDefault(certificate), certificate)
      }
      await persistSnapshot(document)
    },
  }
}
