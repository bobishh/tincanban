import { bootstrapIdentity } from "./domain/identity"
import type { PersonalRootDocumentV1 } from "./domain/model"
import { compareAndSwapLocal, readLocal, type LocalStatePlan } from "./localDb"
import { withLocalStateWriteLock } from "./localStateLock"

const mapKey = "tincanban.v1.personal_roots"
function cloneRoot(root: PersonalRootDocumentV1): PersonalRootDocumentV1 {
  return JSON.parse(JSON.stringify(root)) as PersonalRootDocumentV1
}

function parseMap(raw: string | null): Record<string, PersonalRootDocumentV1> {
  if (!raw) return {}
  const parsed: unknown = JSON.parse(raw)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Personal root map is invalid.")
  return parsed as Record<string, PersonalRootDocumentV1>
}

function validateMutation(personId: string, current: PersonalRootDocumentV1 | null,
  next: PersonalRootDocumentV1 | null, map: Record<string, PersonalRootDocumentV1>) {
  if (next && next.identity.personId !== personId) throw new Error("Personal root identity changed during update.")
  if (next && current && next.rootId !== current.rootId) throw new Error("Personal root ID changed during update.")
  if (next && !current && map[next.rootId]) throw new Error("Personal root ID is already registered.")
}

async function mapForUpdate(raw: string | null, personId: string,
  update: (current: PersonalRootDocumentV1 | null) => PersonalRootDocumentV1 | null | Promise<PersonalRootDocumentV1 | null>) {
  const map = parseMap(raw)
  const current = Object.values(map).find(root => root.identity.personId === personId) ?? null
  const before = current ? cloneRoot(current) : null
  const proposed = await update(before ? cloneRoot(before) : null)
  const next = proposed ? cloneRoot(proposed) : null
  validateMutation(personId, current, next, map)
  if (current && next === null) delete map[current.rootId]
  else if (next) map[next.rootId] = cloneRoot(next)
  return { map, before, next }
}

/** Build an exact compare-and-swap plan without publishing cache state or writing storage. */
export async function planPersonalRootUpdate(
  personId: string,
  update: (current: PersonalRootDocumentV1 | null) => PersonalRootDocumentV1 | null | Promise<PersonalRootDocumentV1 | null>,
): Promise<LocalStatePlan> {
  const raw = await readLocal(mapKey)
  const { map, before, next } = await mapForUpdate(raw, personId, update)
  if (!changed(before, next)) return { conditions: [{ key: mapKey, value: raw }], writes: [] }
  return { conditions: [{ key: mapKey, value: raw }], writes: [{ key: mapKey, value: JSON.stringify(map) }] }
}

const maxCasAttempts = 32

export class PersonalRootMapStore {
  constructor(
    private readonly cache: Map<string, PersonalRootDocumentV1>,
    private readonly beforeWrite: () => void,
  ) {}

  private replaceCache(map: Record<string, PersonalRootDocumentV1>) {
    this.cache.clear()
    for (const [id, root] of Object.entries(map)) this.cache.set(id, cloneRoot(root))
  }

  async planUpdate(personId: string,
    update: (current: PersonalRootDocumentV1 | null) => PersonalRootDocumentV1 | null | Promise<PersonalRootDocumentV1 | null>): Promise<LocalStatePlan> {
    return planPersonalRootUpdate(personId, update)
  }

  private async read() { return parseMap(await readLocal(mapKey)) }

  async save(root: PersonalRootDocumentV1): Promise<void> {
    const submitted = cloneRoot(root)
    await withLocalStateWriteLock(mapKey, async () => {
      for (let attempt = 0; attempt < maxCasAttempts; attempt += 1) {
        const raw = await readLocal(mapKey)
        const map = parseMap(raw)
        const existing = map[submitted.rootId]
        if (existing && existing.identity.personId !== submitted.identity.personId) {
          throw new Error("Personal root ID is already registered to another identity.")
        }
        map[submitted.rootId] = cloneRoot(submitted)
        const next = JSON.stringify(map)
        if (await compareAndSwapLocal({ conditions: [{ key: mapKey, value: raw }], writes: [{ key: mapKey, value: next }] }, this.beforeWrite)) {
          this.replaceCache(map)
          return
        }
      }
      throw new Error("Personal root changed too often to save safely.")
    })
  }

  async update(personId: string,
    update: (current: PersonalRootDocumentV1 | null) => PersonalRootDocumentV1 | null | Promise<PersonalRootDocumentV1 | null>,
  ): Promise<PersonalRootDocumentV1 | null> {
    return withLocalStateWriteLock(mapKey, async () => {
      for (let attempt = 0; attempt < maxCasAttempts; attempt += 1) {
        const raw = await readLocal(mapKey)
        const map = parseMap(raw)
        const current = Object.values(map).find(root => root.identity.personId === personId) ?? null
        const before = current ? cloneRoot(current) : null
        const next = await update(before ? cloneRoot(before) : null)
        validateMutation(personId, current, next, map)
        if (current && next === null) delete map[current.rootId]
        else if (next) map[next.rootId] = cloneRoot(next)
        if (!changed(before, next)) return next ? cloneRoot(next) : null
        const plan: LocalStatePlan = { conditions: [{ key: mapKey, value: raw }], writes: [{ key: mapKey, value: JSON.stringify(map) }] }
        if (await compareAndSwapLocal(plan, this.beforeWrite)) {
          this.replaceCache(map)
          return next ? cloneRoot(next) : null
        }
      }
      throw new Error("Personal root changed too often to update safely.")
    })
  }

  async load(rootId?: string): Promise<PersonalRootDocumentV1 | null> {
    let map: Record<string, PersonalRootDocumentV1>
    try { map = await this.read() }
    catch { map = Object.fromEntries(this.cache) }
    this.replaceCache(map)
    if (rootId) return copyRoot(this.cache.get(rootId))
    const personId = (await bootstrapIdentity()).identity.personId
    return copyRoot([...this.cache.values()].find(root => root.identity.personId === personId))
  }
}

function changed(before: PersonalRootDocumentV1 | null, next: PersonalRootDocumentV1 | null) {
  return before === null ? next !== null : next === null || JSON.stringify(before) !== JSON.stringify(next)
}

function copyRoot(root: PersonalRootDocumentV1 | undefined): PersonalRootDocumentV1 | null {
  return root ? cloneRoot(root) : null
}
