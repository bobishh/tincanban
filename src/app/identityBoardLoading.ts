import { compareAndSwapLocal, readLocal, writeLocal } from "../localDb"
import { isCurrentIdentityProfile, type LocalProfile } from "../domain/identity"
import type { useTincanban } from "../state"

type PendingBoardLoading = { version: 1; attempt: string; stage: "access" | "boards" }
const keyFor = (profile: LocalProfile) =>
  `tincanban.identity-board-loading.v1.${profile.identity.personId}.${profile.device.deviceId}`

/** Delivery intent only. The approved profile and installed catalog credentials remain authoritative. */
export async function beginIdentityBoardLoading(profile: LocalProfile): Promise<PendingBoardLoading> {
  assertCurrent(profile)
  const pending: PendingBoardLoading = { version: 1, attempt: crypto.randomUUID(), stage: "access" }
  await writeLocal(keyFor(profile), JSON.stringify(pending))
  return pending
}

export async function hasPendingIdentityBoardLoading(profile: LocalProfile): Promise<boolean> {
  return await readLocal(keyFor(profile)) !== null
}

export async function confirmIdentityCatalogInstalled(profile: LocalProfile, pending: PendingBoardLoading): Promise<void> {
  await compareAndSwapLocal({ conditions: [{ key: keyFor(profile), value: JSON.stringify(pending) }],
    writes: [{ key: keyFor(profile), value: JSON.stringify({ ...pending, stage: "boards" }) }] }, () => assertCurrent(profile))
}

export class IdentityCatalogApprovalRequired extends Error {
  constructor() {
    super("Your board catalog could not be received. Retry loading boards to request it from Identity.")
    this.name = "IdentityCatalogApprovalRequired"
  }
}

/** Resume installed access after reload; an unavailable manager grant requires a separate catalog approval. */
export async function resumeIdentityBoardLoading(app: ReturnType<typeof useTincanban>, returnPath = "/", recoverPeers?: (workspaceIds: string[]) => Promise<void>): Promise<void> {
  const profile = app.getCurrentProfile()
  if (!profile) return
  const raw = await readLocal(keyFor(profile))
  if (!raw) return
  const pending = JSON.parse(raw) as PendingBoardLoading
  if (pending.version !== 1 || !pending.attempt || !["access", "boards"].includes(pending.stage)) {
    throw new Error("Saved board loading request is invalid")
  }
  assertCurrent(profile)
  if (pending.stage === "access") throw new IdentityCatalogApprovalRequired()
  await (await import("./loadIdentityBoards")).loadIdentityBoards(app, returnPath, recoverPeers)
  await compareAndSwapLocal({ conditions: [{ key: keyFor(profile), value: raw }],
    writes: [{ key: keyFor(profile), value: null }] }, () => assertCurrent(profile))
}

function assertCurrent(profile: LocalProfile): void {
  if (!isCurrentIdentityProfile(profile)) throw new Error("Identity changed while loading boards")
}
