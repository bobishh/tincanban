import type { Ref } from "vue"
import type { OwnerReconnectInvitation } from "@meta-uber/mesh-pairing"
import type { BrowserOwnerReconnectHost } from "@meta-uber/mesh-runtime/ownerReconnect"
import type { OwnerReconnectAuthenticatedPeer, OwnerReconnectHistoryReader, OwnerReconnectSourceState,
  OwnerReconnectApprovalIntent, VerifiedOwnerReconnectWorkspace } from "@meta-uber/mesh-workspace"
import { canonicalizeJson, type LocalProfile } from "../domain/identity"
import { requireIdentityAuthorityView } from "./identityAuthorityStore"
import { userMessage, type DeviceSyncState } from "./deviceSyncState"
import type { WorkspaceSetStore } from "./workspaceSet"
import type { DurableMesh } from "./durableMesh"
import { clearPairingLocation, showInviteQr } from "./deviceSyncInviteView"

export type OwnerReconnectAdapter = {
  expectedOwner(input: { workspaceId: string; store: WorkspaceSetStore }): Promise<{ personId: string; publicKey: string }>
  readSource(input: { profile: LocalProfile; peer: OwnerReconnectAuthenticatedPeer; workspaceId: string; title: string; store: WorkspaceSetStore;
    mesh: Pick<OwnerReconnectMesh, "invitationPayload">; ensureCurrent(): void | Promise<void> }): Promise<OwnerReconnectSourceState>
  commit(input: { invitationId: string; profile: LocalProfile; store: WorkspaceSetStore; workspaceId: string;
    verified: VerifiedOwnerReconnectWorkspace; mesh: Pick<OwnerReconnectMesh, "validateInvitation" | "receiveInvitation">; history: OwnerReconnectHistoryReader; ensureCurrent(): void | Promise<void> }): Promise<void>
  title(workspace: unknown): string | Promise<string>
}

type OwnerReconnectMesh = Pick<DurableMesh, "invitationPayload" | "validateInvitation" | "receiveInvitation">

type Options = {
  state: DeviceSyncState
  origin(): string
  availableWorkspaces: Ref<{ id: string; title: string }[]>
  activeWorkspaceId?: () => string
  workspaceOwner?: (id: string) => Promise<string>
  store(): WorkspaceSetStore | undefined
  getProfile(): Promise<LocalProfile>
  ensureDurableMesh(): Promise<OwnerReconnectMesh | undefined>
  adapter?: OwnerReconnectAdapter
  nextRun(): number
  currentRun(): number
}

type Session = {
  host?: BrowserOwnerReconnectHost
  abort?: AbortController
  resolveConsent?: (approved: boolean) => void
}

export function createDeviceSyncOwnerReconnect(options: Options) {
  const session: Session = {}
  return {
    startHost: () => startOwnerReconnectHost(options, session),
    connect: (invitation: OwnerReconnectInvitation) => connectOwnerReconnect(options, session, invitation),
    approve: () => approveOwnerReconnect(session),
    cancel: () => cancelOwnerReconnect(session),
    close: () => closeOwnerReconnect(session),
  }
}

function ensureAuthority(options: Options, run: number, profile: LocalProfile,
  profileFingerprint: string, authorityFingerprint: string, signal?: AbortSignal) {
  return async () => {
    if (options.currentRun() !== run || signal?.aborted) throw new Error("Owner reconnect was cancelled")
    const current = await options.getProfile()
    const currentAuthority = await requireIdentityAuthorityView(profile.identity.personId)
    if (canonicalizeJson({ identity: current.identity, device: current.device }) !== profileFingerprint ||
        canonicalizeJson(currentAuthority) !== authorityFingerprint) {
      throw new Error("Identity authority changed during owner reconnect; retry with the current device")
    }
  }
}

async function startOwnerReconnectHost(options: Options, session: Session) {
  const workspaceId = options.activeWorkspaceId?.()
  const store = options.store()
  if (!workspaceId || !store || !options.adapter) throw new Error("Owner reconnect is unavailable")
  const run = options.nextRun()
  options.state.step.value = "owner-reconnect-preparing"
  options.state.error.value = ""
  options.state.copyNotice.value = ""
  options.state.inviteUrl.value = ""
  options.state.qrCode.value = ""
  try {
    const mesh = await options.ensureDurableMesh()
    if (!mesh) throw new Error("Board mesh connection is unavailable")
    const profile = await options.getProfile()
    const owner = await options.workspaceOwner?.(workspaceId)
    if (!owner || owner === profile.identity.personId) throw new Error("Only a participant copy can connect its owner device")
    const expectedOwner = await options.adapter.expectedOwner({ workspaceId, store })
    if (owner !== expectedOwner.personId) throw new Error("Saved board owner authority is unavailable")
    const authorityView = await requireIdentityAuthorityView(profile.identity.personId)
    const fingerprint = canonicalizeJson({ identity: profile.identity, device: profile.device })
    const authorityFingerprint = canonicalizeJson(authorityView)
    const ensureCurrent = ensureAuthority(options, run, profile, fingerprint, authorityFingerprint)
    const title = options.availableWorkspaces.value.find(workspace => workspace.id === workspaceId)?.title ?? "Board"
    const abort = session.abort = new AbortController()
    const { startBrowserOwnerReconnectHost } = await import("@meta-uber/mesh-runtime/ownerReconnect")
    const host = await startBrowserOwnerReconnectHost({ profile, authorityView, origin: options.origin(), workspaceId, expectedOwner,
      readSource: peer => {
        if (peer.workspaceId !== workspaceId) throw new Error("Owner reconnect changed board")
        return options.adapter!.readSource({ profile, peer, workspaceId, title, store, mesh, ensureCurrent })
      }, ensureCurrent, signal: abort.signal })
    if (options.currentRun() !== run) { await host.close(); return }
    session.host = host
    await showInviteQr(options.state, host.inviteUrl)
    options.state.step.value = "owner-reconnect-host"
    void host.done.then(() => finishHost(options, session, run, host)).catch(error => failHost(options, session, run, host, error))
  } catch (error) {
    if (options.currentRun() !== run) return
    options.state.step.value = "error"
    options.state.error.value = userMessage(error, "Couldn’t prepare an owner reconnect link.")
  }
}

function finishHost(options: Options, session: Session, run: number,
  host: BrowserOwnerReconnectHost) {
  if (options.currentRun() !== run || session.host !== host) return
  options.state.copyNotice.value = "Your existing board is synced."
  options.state.step.value = "owner-reconnect-done"
}

function failHost(options: Options, session: Session, run: number,
  host: BrowserOwnerReconnectHost, error: unknown) {
  if (options.currentRun() !== run || session.host !== host) return
  options.state.step.value = "error"
  options.state.error.value = userMessage(error, "Couldn’t reconnect the owner device.")
}

async function connectOwnerReconnect(options: Options, session: Session, invitation: OwnerReconnectInvitation) {
  const store = options.store()
  if (!store || !options.adapter) throw new Error("Owner reconnect is unavailable")
  const run = options.nextRun()
  const abort = session.abort = new AbortController()
  options.state.step.value = "owner-reconnect-connecting"
  options.state.error.value = ""
  options.state.ownerReconnectReview.value = null
  try {
    await options.ensureDurableMesh()
    const profile = await options.getProfile()
    const authorityView = await requireIdentityAuthorityView(profile.identity.personId)
    const fingerprint = canonicalizeJson({ identity: profile.identity, device: profile.device })
    const authorityFingerprint = canonicalizeJson(authorityView)
    const ensureCurrent = ensureAuthority(options, run, profile, fingerprint, authorityFingerprint, abort.signal)
    const { connectBrowserOwnerReconnect } = await import("@meta-uber/mesh-runtime/ownerReconnect")
    await connectBrowserOwnerReconnect({ invitation, profile, authorityView, ensureCurrent, signal: abort.signal,
      approve: request => requestOwnerConsent(options, session, request, invitation.workspaceId, ensureCurrent),
      commit: (verified, history) => commitOwnerReconnect(options, invitation, profile, store, verified, history, ensureCurrent),
    })
    await ensureCurrent()
    clearPairingLocation()
    options.state.inviteUrl.value = ""
    options.state.qrCode.value = ""
    options.state.copyNotice.value = "Your existing board is ready on this device."
    options.state.step.value = "owner-reconnect-done"
  } catch (error) {
    if (options.currentRun() !== run) return
    options.state.ownerReconnectReview.value = null
    options.state.step.value = "error"
    options.state.error.value = userMessage(error, "Couldn’t sync this existing board.")
  } finally {
    if (session.abort === abort) session.abort = undefined
  }
}

async function requestOwnerConsent(options: Options, session: Session, request: OwnerReconnectApprovalIntent,
  expectedWorkspaceId: string, ensureCurrent: () => Promise<void>): Promise<boolean> {
  await ensureCurrent()
  if (request.workspaceId !== expectedWorkspaceId) throw new Error("Owner reconnect requested another board")
  options.state.ownerReconnectReview.value = { workspaceId: request.workspaceId,
    title: `Board ${request.workspaceId.slice(0, 8)}`, sourcePersonId: request.sourcePersonId, sourceRole: request.sourceRole }
  options.state.step.value = "owner-reconnect-authorize"
  return new Promise<boolean>(resolve => { session.resolveConsent = resolve })
}

async function commitOwnerReconnect(options: Options, invitation: OwnerReconnectInvitation, profile: LocalProfile,
  store: WorkspaceSetStore, verified: VerifiedOwnerReconnectWorkspace, history: OwnerReconnectHistoryReader,
  ensureCurrent: () => Promise<void>): Promise<void> {
  await ensureCurrent()
  if (verified.workspaceId !== invitation.workspaceId) throw new Error("Owner reconnect returned another board")
  options.state.ownerReconnectReview.value = { workspaceId: verified.workspaceId,
    title: await options.adapter!.title(verified.workspace), sourcePersonId: verified.sourcePersonId, sourceRole: verified.sourceRole }
  options.state.step.value = "owner-reconnect-committing"
  const mesh = await options.ensureDurableMesh()
  if (!mesh) throw new Error("Board mesh connection is unavailable")
  await options.adapter!.commit({ mesh, invitationId: invitation.invitationId, profile, store,
    workspaceId: invitation.workspaceId, verified, history, ensureCurrent })
}

function approveOwnerReconnect(session: Session) {
  const resolve = session.resolveConsent
  session.resolveConsent = undefined
  resolve?.(true)
}

async function cancelOwnerReconnect(session: Session) {
  const resolve = session.resolveConsent
  session.resolveConsent = undefined
  resolve?.(false)
  await closeOwnerReconnect(session)
  clearPairingLocation()
}

async function closeOwnerReconnect(session: Session) {
  const resolve = session.resolveConsent
  session.resolveConsent = undefined
  resolve?.(false)
  session.abort?.abort()
  session.abort = undefined
  const host = session.host
  session.host = undefined
  await host?.close().catch(() => {})
}
