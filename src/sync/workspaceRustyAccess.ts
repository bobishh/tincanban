import { canonicalizeJson, publicKeyId, sha256Base64Url, verifyEnvelope, type LocalProfile, type SignedEnvelope } from "../domain/identity"
import { parseBoardStorageAccess, type BoardStorageAccess, type BoardStorageAuthorization } from "../domain/boardStorageAccess"
import type { DeviceCertificate, WorkspaceGrant } from "../domain/model"
import { verifyWorkspaceGrant } from "../domain/proofs"
import { signWithContext } from "../domain/signingContext"
import { verifyDeviceChain } from "./meshRecords"
import { workspaceOwnerSigningContext, type ReadWorkspaceOwnerAuthority } from "./workspaceOwnerSigning"
import { parseReplicaConfig } from "./blindReplicaConfig"
import { getReplicaConfigurations, setReplicaPreference, privateReplicaBinding } from "./privateReplicaRepository"
import { identityDevicePreferencesChanged } from "./identityDevicePreferenceEvents"
import type { BlindReplicaConfig } from "./blindReplication"
import type { WorkspaceMeshCredential } from "./peerStore"
import { withPrivateReplicaOperation } from "./privateReplicaOperation"
import { meshRustRuntime } from "@meta-uber/mesh-replication/runtime"
import { decodeBlindBytes } from "@meta-uber/mesh-replication/rusty-replica"
import { blindHash } from "./blindClient"
import { ensureRustyWorkspaceScopeAuthority } from "./rustyIdentityTransport"
import { rustySignerCertificateChain } from "./rustySignerCertificates"
import { registerRustyResourcePrincipalGrant } from "@meta-uber/mesh-replication/rusty-principal-grant"
import { requireIdentityAuthorityView } from "./identityAuthorityStore"
import { fetchBlind } from "./rustyHttp"
import { authorizeIdentityDataDevice } from "@meta-uber/mesh-identity"

type Guard = () => Promise<void>
type Role = "owner" | "editor" | "visitor"
type BoardAuthority = Pick<WorkspaceMeshCredential, "ownerPersonId" | "ownerPublicKey"> & {
  catalog?: unknown; scopeAuthoritySnapshot?: unknown
}
const hash = (value: string) => sha256Base64Url(new TextEncoder().encode(value))

function readingConnection(config: BlindReplicaConfig) {
  const { boardAccess, writeToken, cursor, lastUploaded, preferenceRevision, ...connection } = parseReplicaConfig(JSON.stringify(config))
  void boardAccess; void writeToken; void cursor; void lastUploaded; void preferenceRevision
  return connection
}

/** Owner management authority is used only locally; the attestation conveys board storage access. */
export async function createBoardStorageAccess(profile: LocalProfile, config: BlindReplicaConfig,
  grant: WorkspaceGrant, subjectPublicKey: string, readAuthority: ReadWorkspaceOwnerAuthority, guard: Guard): Promise<BoardStorageAccess> {
  await guard()
  assertOwnerConnectionCanBeAttested(config)
  const authorityView = await requireIdentityAuthorityView(profile.identity.personId)
  const authorityFingerprint = canonicalizeJson(authorityView)
  const ensureCurrent = async () => {
    await guard()
    const latest = await requireIdentityAuthorityView(profile.identity.personId)
    if (canonicalizeJson(latest) !== authorityFingerprint) {
      throw new Error("Identity authority changed while sharing Rusty storage; retry with current authority")
    }
  }
  const readCurrentAuthority = async () => {
    await ensureCurrent()
    const value = await readAuthority()
    await ensureCurrent()
    return value
  }
  const activeDeviceKey = await authorizeIdentityDataDevice(authorityView, profile.device.deviceId)
  if (activeDeviceKey !== profile.device.publicKey) throw new Error("Current Rusty owner device is not active in Identity authority")
  const { subjectPersonId, actions } = await validateParticipantGrant(config, grant, subjectPublicKey, authorityView)
  const storedAuthority = await readCurrentAuthority()
  const authoritySnapshot = (storedAuthority as { scopeAuthoritySnapshot?: unknown } | null)?.scopeAuthoritySnapshot
  if (!authoritySnapshot) throw new Error("Workspace scope authority is required before sharing Rusty storage")
  const acceptedAuthority = await ensureRustyWorkspaceScopeAuthority(profile,
    { ...config, workspaceId: config.workspaceId }, authoritySnapshot, ensureCurrent)
  await ensureCurrent()
  const context = await workspaceOwnerSigningContext(profile, config.workspaceId, "workspace-rusty-access", {}, readCurrentAuthority)
  const payload: BoardStorageAuthorization = { kind: "workspace-rusty-access", version: 2, workspaceId: config.workspaceId,
    ownerPersonId: profile.identity.personId, connection: readingConnection(config), readTokenHash: await hash(config.readToken),
    ...(actions.includes("write") ? { writeTokenHash: await hash(config.writeToken) } : {}), subjectPersonId,
    subjectPublicKey, grantId: grant.payload.grantId, policyEpoch: grant.payload.accessEpoch ?? 1,
    actions: [...actions], workspaceGrant: structuredClone(grant), scopeAuthority: structuredClone(acceptedAuthority.snapshot) }
  await guard()
  const authorization = await signWithContext(context, payload)
  const principalContext = await workspaceOwnerSigningContext(profile, config.workspaceId, "rusty-resource-principal-grant", {
    origin: config.origin, scopeId: config.scopeId, resourceId: config.scopeId, ownerPersonId: profile.identity.personId,
    subjectPersonId, grantId: grant.payload.grantId, policyEpoch: grant.payload.accessEpoch ?? 1,
  }, readCurrentAuthority)
  await ensureCurrent()
  const registered = await registerRustyResourcePrincipalGrant({
    origin: config.origin,
    servicePublicKey: config.servicePublicKey,
    storageScopeId: config.scopeId,
    workspaceId: config.workspaceId,
    expectedScopeAuthoritySnapshot: acceptedAuthority.snapshot,
    identity: profile.identity,
    authorityView,
    deviceId: profile.device.deviceId,
    devicePublicKey: profile.device.publicKey,
    subjectIdentity: { personId: subjectPersonId, publicKey: subjectPublicKey, displayName: "" },
    workspaceGrant: grant,
    readToken: config.readToken,
    ...(actions.includes("write") ? { writeToken: config.writeToken } : {}),
    fetcher: (url, init) => fetchBlind(String(url), init ?? {}),
    ensureCurrent,
    validateSnapshot: snapshot => {
      const validated = meshRustRuntime().state.validateScopeAuthority(snapshot, Date.now()) as {
        scopeId: string; controller: { personId: string; publicKey: string }; controlEpoch: number
      }
      return { workspaceId: validated.scopeId, controllerPersonId: validated.controller.personId,
        controllerPublicKey: validated.controller.publicKey, controlEpoch: validated.controlEpoch, snapshot }
    },
    signAuthorization: payload => signWithContext(principalContext, payload),
  })
  const principalGrant = registered.principalGrant
  const certificates = await rustySignerCertificateChain(profile)
  await ensureCurrent()
  return { mode: "write", authorization, certificates, principalGrant }
}

function assertOwnerConnectionCanBeAttested(config: BlindReplicaConfig): void {
  if (config.boardAccess || config.removalPending) throw new Error("Only an active owner connection can be attested")
  if (config.readToken === config.writeToken) throw new Error("Separate reading and writing tokens are required before sharing storage")
}

async function validateParticipantGrant(config: BlindReplicaConfig, grant: WorkspaceGrant,
  subjectPublicKey: string, authorityView: Awaited<ReturnType<typeof requireIdentityAuthorityView>>): Promise<{ subjectPersonId: string; actions: ("read" | "write")[] }> {
  const role = grant?.payload?.role
  const subjectPersonId = grant?.payload?.personId
  const actions = role === "owner" || role === "editor" ? ["read", "write"] as ("read" | "write")[] :
    role === "visitor" ? ["read"] as ("read" | "write")[] : undefined
  const grantSignerPublicKey = typeof grant?.signerKeyId === "string"
    ? await authorizeIdentityDataDevice(authorityView, grant.signerKeyId) : undefined
  if (!actions || grant.payload.workspaceId !== config.workspaceId ||
      await publicKeyId(subjectPublicKey) !== subjectPersonId || !grantSignerPublicKey ||
      !await verifyWorkspaceGrant(grant, grantSignerPublicKey)) {
    throw new Error("A verified participant grant is required before sharing Rusty storage")
  }
  return { subjectPersonId, actions }
}

export function selectBoardStorageAccess(access: BoardStorageAccess, writeToken: string, role: Role): BlindReplicaConfig | undefined {
  if (access.authorization.payload.version !== 2 || access.authorization.payload.workspaceGrant?.payload.role !== role) return undefined
  if (role === "visitor" && writeToken === access.authorization.payload.connection.readToken) return undefined
  if (role !== "visitor" && (!writeToken || access.mode !== "write")) return undefined
  return { ...access.authorization.payload.connection, writeToken: role === "visitor" ? "" : writeToken,
    boardAccess: { ...structuredClone(access), mode: role === "visitor" ? "read" : "write" }, cursor: 0, lastUploaded: "" }
}

/** Verify the original owner even when a different authorized participant forwards the access. */
export async function verifyBoardStorageAccess(config: BlindReplicaConfig, workspaceId: string,
  authority: BoardAuthority, role: Role, subjectPersonId?: string, subjectPublicKey?: string): Promise<void> {
  const access = parseBoardStorageAccess(config.boardAccess)
  const record = access.authorization
  const payload = record.payload
  const principalGrant = access.principalGrant!
  assertCompleteBoardAuthorization(payload)
  const state = meshRustRuntime().state
  assertCurrentScopeAuthority(payload, workspaceId, authority, state)
  const grantIssuer = await findScopeControllerSigner(payload.workspaceGrant!, payload.scopeAuthority)
  await assertWorkspaceGrantBinding(config, workspaceId, role, payload, grantIssuer, subjectPersonId, subjectPublicKey)
  await assertPrincipalGrantBinding(config, workspaceId, record, principalGrant, payload)
  assertBoardAccessConnection(config, workspaceId, role, access.mode, record.payload)
  await verifyOwnerAttestations(record, principalGrant, payload, authority, state, access.certificates)
  await verifyStorageTokens(config, access.mode, record.payload)
}

function assertCompleteBoardAuthorization(payload: BoardStorageAuthorization): void {
  if (payload.version !== 2 || !payload.workspaceGrant || !payload.subjectPersonId || !payload.subjectPublicKey ||
      !payload.grantId || !Number.isSafeInteger(payload.policyEpoch) || !payload.actions || !payload.readTokenHash) {
    throw new Error("Refresh board access from its owner before connecting storage")
  }
}

function assertCurrentScopeAuthority(payload: BoardStorageAuthorization, workspaceId: string, authority: BoardAuthority,
  state: ReturnType<typeof meshRustRuntime>["state"]): void {
  const latestSnapshot = authority.scopeAuthoritySnapshot
  if (!latestSnapshot) throw new Error("Current workspace scope authority is unavailable")
  const scope = state.validateScopeAuthority(payload.scopeAuthority, Date.now()) as {
    scopeId: string; controller: { personId: string; publicKey: string }
  }
  const latest = state.validateScopeAuthority(latestSnapshot, Date.now()) as {
    scopeId: string; controller: { personId: string; publicKey: string }; controlEpoch: number
  }
  const merged = state.mergeScopeAuthoritySnapshots(payload.scopeAuthority, latestSnapshot, Date.now())
  const normalizedLatest = state.mergeScopeAuthoritySnapshots(latestSnapshot, latestSnapshot, Date.now())
  if (scope.scopeId !== workspaceId || latest.scopeId !== workspaceId ||
      latest.controller.personId !== authority.ownerPersonId || latest.controller.publicKey !== authority.ownerPublicKey ||
      canonicalizeJson(merged) !== canonicalizeJson(normalizedLatest)) {
    throw new Error("Rusty principal grant is not bound to the accepted workspace authority history")
  }
}

async function assertWorkspaceGrantBinding(config: BlindReplicaConfig, workspaceId: string, role: Role,
  payload: BoardStorageAuthorization, grantIssuer: ScopeControllerSigner,
  subjectPersonId?: string, subjectPublicKey?: string): Promise<void> {
  const grant = payload.workspaceGrant!
  const grantRole = grant.payload.role
  const expectedActions = grantRole === "owner" || grantRole === "editor" ? ["read", "write"] :
    grantRole === "visitor" ? ["read"] : []
  assertWorkspaceGrantIdentity(grant, payload, workspaceId, role, grantRole, expectedActions, subjectPersonId, subjectPublicKey)
  if (await publicKeyId(payload.subjectPublicKey!) !== payload.subjectPersonId) {
    throw new Error("Rusty principal grant does not match the signed participant or storage policy")
  }
  if (!await verifyWorkspaceGrant(grant, grantIssuer.signingPublicKey)) {
    throw new Error("Rusty principal grant does not match the signed participant or storage policy")
  }
  const readTokenHash = await hash(config.readToken)
  const writeTokenHash = expectedActions.includes("write") ? await hash(config.writeToken) : null
  if (readTokenHash !== payload.readTokenHash ||
      (writeTokenHash !== null ? !payload.writeTokenHash || writeTokenHash !== payload.writeTokenHash :
        payload.writeTokenHash !== undefined || config.writeToken !== "")) {
    throw new Error("Rusty principal grant does not match the signed participant or storage policy")
  }
}

function assertWorkspaceGrantIdentity(grant: WorkspaceGrant, payload: BoardStorageAuthorization, workspaceId: string, role: Role,
  grantRole: string, expectedActions: string[], subjectPersonId?: string, subjectPublicKey?: string): void {
  if (grantRole !== role || grant.payload.workspaceId !== workspaceId || grant.payload.personId !== payload.subjectPersonId ||
      payload.grantId !== grant.payload.grantId || payload.policyEpoch !== (grant.payload.accessEpoch ?? 1) ||
      canonicalizeJson(payload.actions) !== canonicalizeJson(expectedActions) ||
      (subjectPersonId !== undefined && subjectPersonId !== payload.subjectPersonId) ||
      (subjectPublicKey !== undefined && subjectPublicKey !== payload.subjectPublicKey)) {
    throw new Error("Rusty principal grant does not match the signed participant or storage policy")
  }
}

async function assertPrincipalGrantBinding(config: BlindReplicaConfig, workspaceId: string,
  record: BoardStorageAccess["authorization"], principalGrant: NonNullable<BoardStorageAccess["principalGrant"]>,
  payload: BoardStorageAuthorization): Promise<void> {
  const grant = principalGrant.payload
  const expectedServiceId = await blindHash(decodeBlindBytes(config.servicePublicKey))
  assertPrincipalGrantMatchesOwnerAndService(principalGrant, record, expectedServiceId, config, workspaceId, payload)
  if (grant.subjectPersonId !== payload.subjectPersonId || grant.subjectPublicKey !== payload.subjectPublicKey ||
      grant.grantId !== payload.grantId || grant.policyEpoch !== payload.policyEpoch ||
      grant.readTokenHash !== payload.readTokenHash || grant.writeTokenHash !== payload.writeTokenHash ||
      canonicalizeJson(grant.actions) !== canonicalizeJson(payload.actions) ||
      canonicalizeJson(grant.workspaceGrant) !== canonicalizeJson(payload.workspaceGrant) ||
      canonicalizeJson(grant.scopeAuthority) !== canonicalizeJson(payload.scopeAuthority)) {
    throw new Error("Rusty principal grant does not match the signed participant or storage policy")
  }
}

function assertPrincipalGrantMatchesOwnerAndService(principalGrant: NonNullable<BoardStorageAccess["principalGrant"]>,
  record: BoardStorageAccess["authorization"], expectedServiceId: string, config: BlindReplicaConfig, workspaceId: string,
  payload: BoardStorageAuthorization): void {
  const grant = principalGrant.payload
  if (principalGrant.signerKeyId !== record.signerKeyId || grant.serviceId !== expectedServiceId ||
      grant.origin !== config.origin || grant.workspaceId !== workspaceId || grant.resourceKind !== "scope" ||
      grant.resourceId !== config.scopeId || grant.scopeId !== config.scopeId ||
      grant.ownerPersonId !== payload.ownerPersonId) {
    throw new Error("Rusty principal grant does not match the signed participant or storage policy")
  }
}

function assertBoardAccessConnection(config: BlindReplicaConfig, workspaceId: string, role: Role, mode: BoardStorageAccess["mode"],
  record: BoardStorageAccess["authorization"]["payload"]): void {
  if (config.workspaceId !== workspaceId || record.workspaceId !== workspaceId ||
      canonicalizeJson(readingConnection(config)) !== canonicalizeJson(record.connection) ||
      (role === "visitor" && mode !== "read") || (mode === "read" && config.writeToken !== "")) {
    throw new Error("Board storage access does not match current workspace or role")
  }
}

async function verifyOwnerAttestations(record: BoardStorageAccess["authorization"], principalGrant: NonNullable<BoardStorageAccess["principalGrant"]>,
  payload: BoardStorageAuthorization, authority: BoardAuthority, state: ReturnType<typeof meshRustRuntime>["state"],
  signerCertificates: DeviceCertificate[]): Promise<void> {
  const grantPayload = principalGrant.payload
  const ownerKey = await findScopeControllerSigner(record, payload.scopeAuthority, signerCertificates)
  if (ownerKey.personId !== payload.ownerPersonId || ownerKey.personId !== grantPayload.ownerPersonId ||
      !await verifyEnvelope(principalGrant, ownerKey.signingPublicKey) || !await verifyEnvelope(record, ownerKey.signingPublicKey)) {
    throw new Error("Invalid historical workspace storage signer")
  }
  if (state.isDeviceRevoked(authority, payload.ownerPersonId, record.signerKeyId)) {
    throw new Error("Owner storage attestation device was revoked")
  }
}

async function verifyStorageTokens(config: BlindReplicaConfig, mode: BoardStorageAccess["mode"],
  record: BoardStorageAccess["authorization"]["payload"]): Promise<void> {
  if (mode === "read" && await hash(config.readToken) === record.writeTokenHash) {
    throw new Error("Separate reading and writing tokens are required for visitor storage")
  }
  if (mode === "write" && await hash(config.writeToken) !== record.writeTokenHash) {
    throw new Error("Invalid owner board storage authorization")
  }
}

type ScopeController = { personId: string; publicKey: string; certificates: DeviceCertificate[] }
type ScopeControllerSigner = ScopeController & { signingPublicKey: string }

async function findScopeControllerSigner<T extends { kind: string }>(envelope: SignedEnvelope<T>, snapshot: unknown,
  additionalCertificates?: DeviceCertificate[]): Promise<ScopeControllerSigner> {
  const raw = snapshot as { genesis?: { payload?: { creator?: unknown } }; controlTransfers?: Array<{ payload?: { toController?: unknown } }>;
    successionTransfers?: Array<{ claim?: { payload?: unknown } }> }
  const candidates: ScopeController[] = []
  const add = (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return
    const candidate = value as Record<string, unknown>
    if (typeof candidate.personId !== "string" || typeof candidate.publicKey !== "string" || !Array.isArray(candidate.certificates)) return
    if (!candidates.some(item => item.personId === candidate.personId && item.publicKey === candidate.publicKey)) {
      candidates.push({ personId: candidate.personId, publicKey: candidate.publicKey, certificates: candidate.certificates as DeviceCertificate[] })
    }
  }
  add(raw.genesis?.payload?.creator)
  for (const transfer of raw.controlTransfers ?? []) add(transfer.payload?.toController)
  for (const transfer of raw.successionTransfers ?? []) {
    const claim = transfer.claim?.payload as Record<string, unknown> | undefined
    if (claim) add({ personId: claim.toOwnerPersonId, publicKey: claim.toOwnerPublicKey, certificates: claim.toOwnerCertificates })
  }
  const matches: ScopeControllerSigner[] = []
  for (const candidate of candidates) {
    const certificateChains = [candidate.certificates, additionalCertificates]
      .filter((chain): chain is DeviceCertificate[] => chain !== undefined)
    for (const certificates of certificateChains) {
      try {
        const key = await verifyDeviceChain({ personId: candidate.personId, publicKey: candidate.publicKey,
          deviceId: envelope.signerKeyId, certificates })
        if (await verifyEnvelope(envelope, key)) matches.push({ ...candidate, signingPublicKey: key })
      } catch { /* Nonmatching controller identity is expected while checking validated history. */ }
    }
  }
  const distinct = new Map(matches.map(candidate => [`${candidate.personId}\u0000${candidate.publicKey}`, candidate]))
  if (distinct.size !== 1) throw new Error("Workspace grant signer is not uniquely present in the signed controller history")
  return [...distinct.values()][0]!
}

function sameAccess(left: BlindReplicaConfig, right: BlindReplicaConfig): boolean {
  return canonicalizeJson([readingConnection(left), left.writeToken, left.boardAccess]) ===
    canonicalizeJson([readingConnection(right), right.writeToken, right.boardAccess])
}

function shouldReplace(previous: BlindReplicaConfig | undefined, config: BlindReplicaConfig, role: Role): boolean {
  if (!previous) return true
  if (!previous.boardAccess || previous.removalPending || previous.policyRevision > config.policyRevision || sameAccess(previous, config)) return false
  if (previous.policyRevision !== config.policyRevision) return true
  if (canonicalizeJson(readingConnection(previous)) !== canonicalizeJson(readingConnection(config))) {
    throw new Error("Board storage credentials changed without a new policy revision")
  }
  return !(role !== "visitor" && previous.boardAccess.mode === "write" && config.boardAccess?.mode === "read")
}

export async function receiveBoardStorageAccess(personId: string, workspaceId: string,
  authority: BoardAuthority, role: Role, raw: unknown, guard: Guard, subjectPublicKey: string): Promise<void> {
  await guard()
  if (!Array.isArray(raw) || raw.length > 32 || JSON.stringify(raw).length > 512 * 1024) throw new Error("Board storage transfer exceeds limit")
  const connections = raw.map(value => parseReplicaConfig(JSON.stringify(value)))
  for (const config of connections) { await verifyBoardStorageAccess(config, workspaceId, authority, role, personId, subjectPublicKey); await guard() }
  if (personId === authority.ownerPersonId) return
  for (const config of connections) {
    await withPrivateReplicaOperation(personId, config, async () => {
      await guard()
      const previous = (await getReplicaConfigurations(personId)).find(saved => saved.origin === config.origin && saved.scopeId === config.scopeId)
      await guard()
      if (!shouldReplace(previous, config, role)) return
      const expected = previous ? privateReplicaBinding(personId, previous) : null
      if (await setReplicaPreference(personId, { ...config, cursor: 0, lastUploaded: "" }, false, expected)) identityDevicePreferencesChanged(personId)
      await guard()
    })
  }
}
