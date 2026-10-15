import { BrowserMeshStore, MemoryMeshStore } from "@meta-uber/mesh-browser-store"
import { tracksIdentityContent, identityContentChanged, advanceIdentityRevision, identityStateRevisionKey } from "./identityStateContent"

const store = typeof indexedDB === "undefined"
  ? new MemoryMeshStore()
  : new BrowserMeshStore("tincanban-local-state-v1", ["kv"])

export async function readLocal(key: string): Promise<string | null> {
  return await store.get<string>("kv", key) ?? null
}

export async function writeLocal(key: string, value: string): Promise<void> {
  await updateLocal(key, () => value)
}

/** Read and replace one complete record in the underlying store's transaction. */
export async function updateLocal(key: string, change: (current: string | null) => string): Promise<string> {
  const tracked = tracksIdentityContent(key)
  return store.updateRecords("kv", tracked ? [key, identityStateRevisionKey] : [key], values => {
    const current = (values[0] as string | undefined) ?? null
    const next = change(current)
    if (typeof next !== "string") throw new Error("Local state update did not produce a record")
    const writes = [{ key, value: next }]
    if (tracked && identityContentChanged(key, current, next)) writes.push({ key: identityStateRevisionKey,
      value: advanceIdentityRevision((values[1] as string | undefined) ?? null) })
    return { writes, result: next }
  })
}

export async function deleteLocal(key: string): Promise<void> {
  const tracked = tracksIdentityContent(key)
  await store.updateRecords("kv", tracked ? [key, identityStateRevisionKey] : [key], values => {
    const writes: { key: string; value: string | undefined }[] = [{ key, value: undefined }]
    if (tracked && identityContentChanged(key, (values[0] as string | undefined) ?? null, null)) {
      writes.push({ key: identityStateRevisionKey, value: advanceIdentityRevision((values[1] as string | undefined) ?? null) })
    }
    return { writes, result: undefined }
  })
}

export async function listLocalKeys(): Promise<string[]> {
  return (await store.list<string>("kv")).map(item => item.key)
}

type LocalStateCondition = { key: string; value: string | null }
type LocalStateWrite = { key: string; value: string | null }
export type LocalStatePlan = { conditions: LocalStateCondition[]; writes: LocalStateWrite[] }

/** Publish a verified bundle only if every captured input still matches. */
export async function compareAndSwapLocal(plan: LocalStatePlan, ensureCurrent: () => void = () => {}): Promise<boolean> {
  plan = structuredClone(plan)
  const tracked = plan.writes.some(write => tracksIdentityContent(write.key))
  const keys = [...new Set([...plan.conditions, ...plan.writes].map(record => record.key))]
  if (tracked && !keys.includes(identityStateRevisionKey)) keys.push(identityStateRevisionKey)
  return store.updateRecords("kv", keys, values => {
    const records = new Map(keys.map((key, index) => [key, (values[index] as string | undefined) ?? null]))
    if (plan.conditions.some(condition => records.get(condition.key) !== condition.value)) return { writes: [], result: false }
    const writes = plan.writes.map(write => ({ key: write.key, value: write.value ?? undefined }))
    if (tracked && plan.writes.some(write => identityContentChanged(write.key, records.get(write.key) ?? null, write.value))) {
      if (plan.writes.some(write => write.key === identityStateRevisionKey)) throw new Error("Identity revision is owned by local storage")
      writes.push({ key: identityStateRevisionKey, value: advanceIdentityRevision(records.get(identityStateRevisionKey) ?? null) })
    }
    ensureCurrent()
    return { writes, result: true }
  })
}
