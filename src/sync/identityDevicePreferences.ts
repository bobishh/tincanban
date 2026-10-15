import { verifyEnvelope, type LocalProfile, type SignedEnvelope } from "../domain/identity"
import type { DeviceCertificate } from "../domain/model"
import { signingEvidence, signWithContext } from "../domain/signingContext"
import { resolveLocalSigningContext } from "../domain/localSigningContext"
import { defaultProofStore } from "../domain/proofs"
import type { BlindReplicaConfig } from "./blindReplication"
import { verifyDeviceChain } from "./meshRecords"
import type { WorkspaceSetStore } from "./workspaceSet"
import { identityDevicePreferencesChanged as changed } from "./identityDevicePreferenceEvents"
import { controllerDelegation, installControllerDelegation, type ControllerDelegation } from "./deviceEnrollmentDelegation"
import { parsePrivateReplicaWire, type PrivateReplicaWire } from "./privateReplicaPreferences"
import { exportPrivateReplicaState, persistPrivateReplicaProgress, receivePrivateReplicaState, setReplicaPreference } from "./privateReplicaRepository"
import { createIdentityDeviceTransfer, readIdentityDeviceTransfer, applyIdentityDeviceTransfer } from "./identityDeviceTransfer"
import type { IdentityDeviceState } from "./identityDeviceStateCodec"
import { defaultStorage } from "../storage"

export function parseReplicaPreferences(raw: unknown): PrivateReplicaWire {
  if (Array.isArray(raw)) throw new Error("The other device needs an update before private connections can synchronize")
  return parsePrivateReplicaWire(raw)
}

export const readReplicaPreferences = exportPrivateReplicaState

export async function recordReplicaPreference(owner: string, config: BlindReplicaConfig, removed = false) {
  if (await setReplicaPreference(owner, config, removed)) changed(owner)
}

export async function receiveReplicaPreferences(owner: string, raw: unknown) {
  if (await receivePrivateReplicaState(owner, parseReplicaPreferences(raw))) changed(owner)
}

export const persistReplicaCursor = persistPrivateReplicaProgress

type PreferencePayload = { kind: "identity-device-preferences"; version: 3; personId: string; state: IdentityDeviceState;
  certificates: DeviceCertificate[]; delegation?: ControllerDelegation }
export function withIdentityDevicePreferences(store: WorkspaceSetStore, profile: LocalProfile, remotePersonId: string, remoteDeviceId: string,
  isCurrent: () => boolean = () => true): WorkspaceSetStore {
  if (remotePersonId !== profile.identity.personId) return store
  const ensureCurrent = () => { if (!isCurrent()) throw new Error("Device session is no longer authorized") }
  return { ...store,
    readMesh: async id => {
      const signer = { ...profile, identity: structuredClone(profile.identity), device: structuredClone(profile.device),
        certificate: structuredClone(profile.certificate), privateKeys: { ...profile.privateKeys } }
      ensureCurrent()
      const context = await resolveLocalSigningContext(signer, "identity-device-preferences",
        { personId: signer.identity.personId }, { ensureCurrent })
      const root = await defaultStorage.loadPersonalRoot()
      if (root?.identity.personId !== signer.identity.personId) throw new Error("Complete identity catalog is unavailable for device sync")
      const certificates = (await defaultProofStore.listCertificates()).filter(cert => cert.payload.personId === signer.identity.personId)
      const payload: PreferencePayload = { kind: "identity-device-preferences", version: 3, personId: signer.identity.personId,
        certificates: signingEvidence(context).certificates,
        state: await createIdentityDeviceTransfer(root, [signer.certificate, ...certificates]),
        ...await controllerDelegation(signer, remoteDeviceId).then(delegation => delegation ? { delegation } : {}) }
      const mesh = await store.readMesh?.(id)
      ensureCurrent()
      const record = await signWithContext(context, payload)
      ensureCurrent()
      return { ...mesh as object, identityDevicePreferences: record }
    },
    mergeMesh: async (id, raw) => {
      const { identityDevicePreferences, ...mesh } = structuredClone(raw) as Record<string, unknown>
      ensureCurrent()
      if (!identityDevicePreferences) { await store.mergeMesh?.(id, mesh); return }
      const record = identityDevicePreferences as SignedEnvelope<PreferencePayload>
      if (new TextEncoder().encode(JSON.stringify(record)).byteLength > 2 * 1024 * 1024 || record.signerKeyId !== remoteDeviceId || record.payload?.kind !== "identity-device-preferences" ||
        record.payload.version !== 3 || record.payload.personId !== profile.identity.personId) throw new Error("The other device needs an update before complete identity state can synchronize")
      const publicKey = await verifyDeviceChain({ personId: profile.identity.personId, publicKey: profile.identity.publicKey,
        deviceId: remoteDeviceId, certificates: record.payload.certificates })
      if (!await verifyEnvelope(record, publicKey)) throw new Error("Invalid identity device preferences signature")
      const transfer = await readIdentityDeviceTransfer(record.payload.state, profile.identity.personId)
      ensureCurrent()
      await store.mergeMesh?.(id, mesh)
      ensureCurrent()
      await installControllerDelegation(profile, remoteDeviceId, record.payload.delegation)
      await applyIdentityDeviceTransfer(transfer, ensureCurrent)
      changed(profile.identity.personId)
    },
  }
}
