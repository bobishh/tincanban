import {
  authorizeIdentityDataDevice,
  identityProfileRustyServicePins,
  verifyDeviceAuthorizationApproval,
  verifyRetainedDeviceAuthorizationApproval,
  type DeviceAuthorizationApproval,
  type DeviceAuthorizationRequest,
  type IdentityRustyServicePin,
} from "@meta-uber/mesh-identity"
import { compareAndSwapLocal, readLocal } from "../localDb"
import { defaultStorage } from "../storage"
import { rootIdentityProfileState } from "../domain/identityProfileRoot"
import { identityProfileRevision } from "../domain/identityProfileRevision"
import { mergeIdentityAuthorityView, requireIdentityAuthorityView } from "./identityAuthorityStore"

type CatalogEntry = { request: DeviceAuthorizationRequest; approval: DeviceAuthorizationApproval }
type CatalogState = CatalogEntry & { version: 1; personId: string }

const keyFor = (personId: string) => `tincanban.identity-rusty-service-catalog.v1.${personId}`

/** Retain only the latest full manager-signed catalog snapshot for reuse after reload. */
export async function saveIdentityRustyServiceCatalogApproval(
  request: DeviceAuthorizationRequest,
  approval: DeviceAuthorizationApproval,
): Promise<void> {
  const verified = await verifyDeviceAuthorizationApproval(approval, request)
  const requestedPins = "rustyServicePins" in request.payload ? request.payload.rustyServicePins : []
  if (!requestedPins.length || !verified.rustyServicePins) return
  const personId = verified.identity.personId
  if (request.payload.personId !== personId) throw new Error("Rusty service approval belongs to another Identity")
  if (!verified.authorityView) throw new Error("Rusty service approval is missing its signed authority view")
  await mergeIdentityAuthorityView(verified.authorityView)
  for (let attempt = 0; attempt < 8; attempt++) {
    const key = keyFor(personId)
    const previousRaw = await readLocal(key)
    for (const requested of requestedPins) {
      const approved = verified.rustyServicePins.find(pin => pin.origin === requested.origin &&
        pin.serviceId === requested.serviceId && pin.servicePublicKey === requested.servicePublicKey)
      if (!approved) throw new Error("Identity approval does not include the requested Rusty service key")
    }
    const next = JSON.stringify({ version: 1, personId, request: structuredClone(request), approval: structuredClone(approval) })
    if (next === previousRaw) return
    if (await compareAndSwapLocal({ conditions: [{ key, value: previousRaw }], writes: [{ key, value: next }] })) return
  }
  throw new Error("Identity Rusty service catalog changed repeatedly; retry required")
}

/** Resolve one exact service pin from signed Identity history or a verified saved approval. */
export async function readIdentityRustyServicePin(personId: string, origin: string): Promise<IdentityRustyServicePin | null> {
  const root = await defaultStorage.loadPersonalRoot()
  const { pin: profilePin, revision: rootProfileRevision, ownsIdentity } = await readRootPin(root, personId, origin)
  if (profilePin) return profilePin

  const raw = await readLocal(keyFor(personId))
  const catalog = raw === null ? null : parseCatalog(raw, personId)
  const signedRootIsCurrent = root?.profileState !== undefined && ownsIdentity &&
    rootProfileRevision === catalogProfileDigest(catalog)
  if (signedRootIsCurrent) return profilePin ?? null
  if (!catalog) return profilePin ?? null
  return verifySavedServicePin(catalog, personId, origin)
}

async function readRootPin(root: Awaited<ReturnType<typeof defaultStorage.loadPersonalRoot>>, personId: string, origin: string) {
  if (root?.identity.personId !== personId) return { pin: undefined, revision: null, ownsIdentity: false }
  const profileState = await rootIdentityProfileState(root)
  const revision = await identityProfileRevision(profileState)
  const pin = identityProfileRustyServicePins(profileState).find(candidate => candidate.origin === origin)
  return { pin, revision, ownsIdentity: true }
}

function catalogProfileDigest(catalog: CatalogState | null): string | null {
  return catalog?.approval.proof.payload.version === 3 ? catalog.approval.proof.payload.profileStateDigest : null
}

async function verifySavedServicePin(catalog: CatalogState, personId: string, origin: string): Promise<IdentityRustyServicePin | null> {
  const approval = await verifyRetainedDeviceAuthorizationApproval(catalog.approval, catalog.request)
  if (approval.identity.personId !== personId || catalog.request.payload.personId !== personId) {
    throw new Error("Saved Identity service approval belongs to another Identity")
  }
  const pin = approval.rustyServicePins?.find(candidate => candidate.origin === origin)
  if (!pin) return null
  const currentView = await requireIdentityAuthorityView(personId)
  if (currentView.identityPublicKey !== approval.identity.publicKey) {
    throw new Error("Saved Identity service approval does not match the current Identity key")
  }
  const activeDeviceKey = await authorizeIdentityDataDevice(currentView, catalog.request.payload.deviceId)
  if (activeDeviceKey !== catalog.request.payload.devicePublicKey) throw new Error("Saved Identity service approval device is no longer active")
  const managerCertificate = currentView.certificates.find(certificate => certificate.payload.deviceId === catalog.approval.issuerDeviceId)
  if (!managerCertificate?.payload.canEnrollDevices) throw new Error("Saved Identity service approval manager is no longer active")
  await authorizeIdentityDataDevice(currentView, catalog.approval.issuerDeviceId)
  return pin
}

function parseCatalog(raw: string, personId: string): CatalogState {
  if (raw.length > 2_000_000) throw new Error("Saved Identity service catalog exceeds its size limit")
  let value: unknown
  try { value = JSON.parse(raw) as unknown }
  catch { throw new Error("Saved Identity service catalog is malformed") }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Saved Identity service catalog is malformed")
  const state = value as Partial<CatalogState>
  if (state.version !== 1 || state.personId !== personId || !state.request || !state.approval) {
    throw new Error("Saved Identity service catalog does not match this Identity")
  }
  return state as CatalogState
}

