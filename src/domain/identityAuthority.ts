import { authorizeIdentityDataDevice, verifyIdentityAuthorityView, type VerifiedIdentityAuthorityView } from "@meta-uber/mesh-identity"
import { compareAndSwapLocal, readLocal } from "../localDb"

export function identityAuthorityViewKey(personId: string): string {
  return `tincanban.identity-authority-view.v1.${personId}`
}

/** Return only a stored, verified Identity view; missing state means this device has not learned one yet. */
export async function readLearnedIdentityAuthorityView(personId: string): Promise<VerifiedIdentityAuthorityView | null> {
  const raw = await readLocal(identityAuthorityViewKey(personId))
  if (raw === null) return null
  return parseLearnedIdentityAuthorityView(personId, raw)
}

async function parseLearnedIdentityAuthorityView(personId: string, raw: string): Promise<VerifiedIdentityAuthorityView> {
  let value: unknown
  try { value = JSON.parse(raw) as unknown }
  catch { throw new Error("Stored Identity authority view is malformed") }
  const view = await verifyIdentityAuthorityView(value)
  if (view.personId !== personId) throw new Error("Stored Identity authority view belongs to another person")
  return view
}

export class IdentityDeviceAccessDeniedError extends Error {
  constructor(readonly personId: string, readonly deviceId: string, cause: unknown) {
    super("Identity device access is revoked or unavailable", { cause })
  }
}

type LearnedDeviceAccess = { personId: string; devices: string[]; key: string; raw: string | null; viewDigest: string | null }

class IdentityAuthoritySnapshotChangedError extends Error {
  constructor() { super("Identity authority changed during access check") }
}

async function readLearnedDeviceAccess(personId: string, deviceIds: readonly string[]): Promise<LearnedDeviceAccess> {
  if (typeof personId !== "string" || !personId || personId.length > 128) throw new Error("Identity person binding is required")
  const devices = [...new Set(deviceIds)]
  if (!devices.length || devices.some(id => typeof id !== "string" || !id || id.length > 128)) throw new Error("Identity device IDs are required")
  const key = identityAuthorityViewKey(personId), raw = await readLocal(key)
  if (raw === null) return { personId, devices, key, raw, viewDigest: null }
  const view = await parseLearnedIdentityAuthorityView(personId, raw)
  for (const deviceId of devices) {
    try { await authorizeIdentityDataDevice(view, deviceId) }
    catch (cause) { throw new IdentityDeviceAccessDeniedError(personId, deviceId, cause) }
  }
  return { personId, devices, key, raw, viewDigest: view.viewDigest }
}

async function assertAccessCurrent(snapshots: readonly LearnedDeviceAccess[]): Promise<void> {
  if (await compareAndSwapLocal({ conditions: snapshots.map(({ key, raw }) => ({ key, value: raw })), writes: [] })) return
  // Reauthenticate after change. A revocation is a denial; another change requires a fresh operation.
  await Promise.all(snapshots.map(snapshot => readLearnedDeviceAccess(snapshot.personId, snapshot.devices)))
  throw new IdentityAuthoritySnapshotChangedError()
}

/** Initial capture can restart before any caller has bound an operation to its snapshot. */
async function captureLearnedDeviceAccess(groups: ReadonlyMap<string, readonly string[]>): Promise<LearnedDeviceAccess[]> {
  const known = new Set<string>()
  for (let attempt = 0; attempt < 8; attempt++) {
    const snapshots = await Promise.all([...groups].map(([personId, devices]) => readLearnedDeviceAccess(personId, devices)))
    for (const snapshot of snapshots) {
      if (snapshot.raw === null && known.has(snapshot.personId)) throw new Error("Learned Identity authority disappeared during access check")
      if (snapshot.raw !== null) known.add(snapshot.personId)
    }
    try { await assertAccessCurrent(snapshots); return snapshots }
    catch (error) { if (!(error instanceof IdentityAuthoritySnapshotChangedError)) throw error }
  }
  throw new IdentityAuthoritySnapshotChangedError()
}

/** Resolve once, then check cheaply after surrounding I/O and immediately before disclosure. */
export async function resolveLearnedIdentityAccess(bindings: readonly { personId: string; deviceId: string }[]): Promise<() => Promise<void>> {
  const groups = new Map<string, string[]>()
  for (const { personId, deviceId } of bindings) groups.set(personId, [...(groups.get(personId) ?? []), deviceId])
  if (!groups.size) throw new Error("Identity device bindings are required")
  const snapshots = await captureLearnedDeviceAccess(groups)
  return () => assertAccessCurrent(snapshots)
}

/** Every participant must remain active in one unchanged learned global authority view. */
async function assertLearnedIdentityDevicesActive(personId: string, deviceIds: readonly string[]): Promise<string | null> {
  const snapshots = await captureLearnedDeviceAccess(new Map([[personId, deviceIds]]))
  return snapshots[0]!.viewDigest
}

/** Apply the same global authority check at local signing boundaries. */
export async function assertLearnedIdentityDeviceActive(personId: string, deviceId: string): Promise<string | null> {
  return assertLearnedIdentityDevicesActive(personId, [deviceId])
}
