import { canonicalizeJson, type LocalProfile, type SignedEnvelope } from "../domain/identity"
import { resolveLocalSigningContext } from "../domain/localSigningContext"
import { signWithContext, signingEvidence } from "../domain/signingContext"
import { serviceLoginPayload, type ServiceLoginRequest } from "./serviceLogin"

export type ServiceLoginWorkspace = { workspace: string; name: string; [key: string]: unknown }
export type ServiceLoginApproval = {
  identity: ReturnType<typeof signingEvidence>["identity"]
  deviceId: string
  certificates: ReturnType<typeof signingEvidence>["certificates"]
  proof: SignedEnvelope<ReturnType<typeof serviceLoginPayload> & { boards: Array<{ workspace: string; name: string }> }>
  workspaces: ServiceLoginWorkspace[]
}
export type ServiceLoginApprovalGuards = {
  currentAuthority?: () => Promise<string>
  ensureCurrent?: () => void | Promise<void>
}

/** Fail if the service challenge, its deadline, or the original opener changed while approval was prepared. */
export function assertServiceLoginSession(current: ServiceLoginRequest | undefined, expected: ServiceLoginRequest,
  currentOpener: Window | null, expectedOpener: Window, now = Math.floor(Date.now() / 1000)): void {
  if (currentOpener !== expectedOpener || current?.origin !== expected.origin || current.challenge !== expected.challenge ||
      current.expires_at !== expected.expires_at) throw new Error("TinSink approval changed")
  if (!Number.isSafeInteger(now) || expected.expires_at <= now) throw new Error("Sign-in expired. Retry from TinSink.")
}

/** Build the existing TinSink response under a live, request-scoped local device signer. */
export async function createServiceLoginApproval<T extends ServiceLoginWorkspace>(
  profileValue: LocalProfile,
  requestValue: ServiceLoginRequest,
  workspaceValues: readonly T[],
  guards: ServiceLoginApprovalGuards = {},
): Promise<ServiceLoginApproval> {
  const profile = { ...profileValue, identity: structuredClone(profileValue.identity), device: structuredClone(profileValue.device),
    certificate: structuredClone(profileValue.certificate), privateKeys: { ...profileValue.privateKeys } }
  const request = structuredClone(requestValue)
  const workspaces = structuredClone(Array.from(workspaceValues)) as ServiceLoginWorkspace[]
  // Reject non-JSON data before any authority lookup or signing work.
  canonicalizeJson(workspaces)
  const binding = { origin: request.origin, challenge: request.challenge }
  const currentAuthority = guards.currentAuthority
  const ensureCurrent = guards.ensureCurrent
  await ensureCurrent?.()
  const now = Math.floor(Date.now() / 1000)
  const context = await resolveLocalSigningContext(profile, "tinsink-login", binding, {
    domain: "TINSINK/1",
    expiresAt: request.expires_at * 1000,
    ...(currentAuthority ? { currentAuthority } : {}),
    ...(ensureCurrent ? { ensureCurrent } : {}),
  })
  const payload = { ...serviceLoginPayload(request, now), boards: workspaces.map(({ workspace, name }) => ({ workspace, name })) }
  const proof = await signWithContext(context, payload)
  await ensureCurrent?.()
  const evidence = signingEvidence(context)
  return { identity: evidence.identity, deviceId: context.deviceId, certificates: evidence.certificates,
    proof, workspaces }
}
