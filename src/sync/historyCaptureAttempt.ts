import { canonicalizeJson, sha256Base64Url } from "../domain/identity"
import { readLocal, compareAndSwapLocal } from "../localDb"
type Attempt = { transitionId: string; attemptId: string; abandoned: string[] }
async function keyFor(workspaceId: string, transitionId: string) {
  return `tincanban.history-capture-attempt.v1.${await sha256Base64Url(new TextEncoder().encode(canonicalizeJson([workspaceId, transitionId])))}`
}
function parse(raw: string, transitionId: string): Attempt {
  const value = JSON.parse(raw) as Attempt
  const valid = (id: unknown) => typeof id === "string" && /^[0-9a-f-]{36}$/.test(id)
  if (!value || value.transitionId !== transitionId || !valid(value.attemptId) || !Array.isArray(value.abandoned) || value.abandoned.length > 128 ||
      !value.abandoned.every(valid) || new Set(value.abandoned).size !== value.abandoned.length || value.abandoned.includes(value.attemptId) ||
      Object.keys(value).some(key => !["transitionId", "attemptId", "abandoned"].includes(key))) throw new Error("Invalid retained history capture attempts")
  return value
}
export async function currentHistoryCaptureAttempt(workspaceId: string, transitionId: string, guard: () => void): Promise<string> {
  const key = await keyFor(workspaceId, transitionId)
  for (let retry = 0; retry < 8; retry++) {
    const raw = await readLocal(key)
    guard()
    if (raw !== null) return parse(raw, transitionId).attemptId
    const value = { transitionId, attemptId: transitionId, abandoned: [] }
    if (await compareAndSwapLocal({ conditions: [{ key, value: null }], writes: [{ key, value: canonicalizeJson(value) }] }, guard)) return value.attemptId
  }
  throw new Error("History capture attempt changed repeatedly; retry required")
}
/** Only a confirmed exact-sequence refusal permits a fresh capture. Lost replies retain their original attempt. */
export async function restartConflictedHistoryCapture(workspaceId: string, transitionId: string, attemptId: string, guard: () => void): Promise<void> {
  const key = await keyFor(workspaceId, transitionId), raw = await readLocal(key)
  guard()
  if (raw === null) throw new Error("Original history capture attempt is unavailable")
  const previous = parse(raw, transitionId)
  if (previous.abandoned.includes(attemptId)) return
  if (previous.attemptId !== attemptId || previous.abandoned.length >= 128) throw new Error("History capture attempt changed or exceeded its recovery bound")
  const next = { transitionId, attemptId: crypto.randomUUID(), abandoned: [...previous.abandoned, attemptId] }
  if (!await compareAndSwapLocal({ conditions: [{ key, value: raw }], writes: [{ key, value: canonicalizeJson(next) }] }, guard)) {
    throw new Error("History capture changed during conflict recovery")
  }
}
