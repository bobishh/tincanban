import {
  type WorkspaceEntity,
  type ProjectionIssue,
  entityKind,
  validatePlacementParent,
} from "./model"
import { compareRanks } from "./rank"
export { compareRanks } from "./rank"

function gcdBigInt(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a
  let y = b < 0n ? -b : b
  while (y !== 0n) {
    const t = y
    y = x % y
    x = t
  }
  return x
}

function parseRank(rank: string): [bigint, bigint] {
  const parts = rank.split("/")
  if (parts.length !== 2) throw new Error(`Invalid rank: ${rank}`)
  const num = BigInt(parts[0])
  const den = BigInt(parts[1])
  if (den <= 0n) throw new Error(`Invalid denominator in rank: ${rank}`)
  return [num, den]
}

function reduceRational(num: bigint, den: bigint): string {
  if (den < 0n) {
    num = -num
    den = -den
  }
  if (num === 0n) return "0/1"
  const g = gcdBigInt(num, den)
  return `${num / g}/${den / g}`
}

export function calculateRankBetween(prevRank: string | null, nextRank: string | null): string {
  if (prevRank === null && nextRank === null) {
    return "0/1"
  }
  if (prevRank === null) {
    const [n, d] = parseRank(nextRank!)
    return reduceRational(n - d, d)
  }
  if (nextRank === null) {
    const [n, d] = parseRank(prevRank!)
    return reduceRational(n + d, d)
  }

  const [n1, d1] = parseRank(prevRank)
  const [n2, d2] = parseRank(nextRank)

  // Mediant of n1/d1 and n2/d2 is (n1 + n2) / (d1 + d2)
  const num = n1 + n2
  const den = d1 + d2
  return reduceRational(num, den)
}

export function sortEntitiesByRank<T extends { id: string; placement: { rank: string } }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const cmp = compareRanks(a.placement.rank, b.placement.rank)
    if (cmp !== 0) return cmp
    // Tie-break by ASCII ID comparison
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}

export function renumberSiblings<T extends { id: string; placement: { rank: string; parentId: string | null } }>(
  items: T[]
): T[] {
  const sorted = sortEntitiesByRank(items)
  return sorted.map((item, index) => ({
    ...item,
    placement: {
      ...item.placement,
      rank: `${index}/1`,
    },
  }))
}

export function getChildren(
  entities: Record<string, WorkspaceEntity>,
  parentId: string | null
): WorkspaceEntity[] {
  const children: WorkspaceEntity[] = []
  for (const entity of Object.values(entities)) {
    if (entity.placement.parentId === parentId) children.push(entity)
  }
  return sortEntitiesByRank(children)
}

export type ChildrenIndex = ReadonlyMap<string | null, readonly WorkspaceEntity[]>

export function childrenIndex(entities: Record<string, WorkspaceEntity>): ChildrenIndex {
  const index = new Map<string | null, WorkspaceEntity[]>()
  for (const entity of Object.values(entities)) {
    const siblings = index.get(entity.placement.parentId) ?? []
    siblings.push(entity)
    index.set(entity.placement.parentId, siblings)
  }
  for (const [parentId, siblings] of index) index.set(parentId, sortEntitiesByRank(siblings))
  return index
}

export function indexedChildren(index: ChildrenIndex, parentId: string | null): readonly WorkspaceEntity[] {
  return index.get(parentId) ?? []
}

export function getAncestryPath(
  entities: Record<string, WorkspaceEntity>,
  entityId: string
): { path: string[]; issue?: ProjectionIssue } {
  const path: string[] = []
  const visited = new Set<string>()
  let currentId: string | null = entityId

  while (currentId !== null) {
    if (visited.has(currentId)) {
      // Cycle detected
      return {
        path,
        issue: {
          type: "cycle",
          entityId,
          cycleIds: Array.from(visited),
        },
      }
    }

    visited.add(currentId)
    const entity: WorkspaceEntity | undefined = entities[currentId]
    if (!entity) {
      return {
        path,
        issue: {
          type: "missing-parent",
          entityId,
          parentId: currentId,
        },
      }
    }

    path.push(currentId)
    const parentId: string | null = entity.placement.parentId
    if (parentId !== null) {
      const parent = entities[parentId]
      if (!parent) {
        return {
          path,
          issue: {
            type: "missing-parent",
            entityId,
            parentId,
          },
        }
      }
      const validParent = validatePlacementParent(entityKind(entity), entityKind(parent))
      if (!validParent.ok) {
        return {
          path,
          issue: {
            type: "invalid-parent-kind",
            entityId,
            parentId,
          },
        }
      }
    } else {
      const validRoot = validatePlacementParent(entityKind(entity), null)
      if (!validRoot.ok) {
        return {
          path,
          issue: {
            type: "invalid-parent-kind",
            entityId,
            parentId: null,
          },
        }
      }
    }

    currentId = parentId
  }

  return { path }
}

export function derivePlacementIssues(entities: Record<string, WorkspaceEntity>): ProjectionIssue[] {
  const issues: ProjectionIssue[] = []
  for (const entity of Object.values(entities)) {
    const { issue } = getAncestryPath(entities, entity.id)
    if (issue) {
      issues.push(issue)
    }
  }
  return issues
}

export function isEntityVisible(
  entities: Record<string, WorkspaceEntity>,
  entityId: string,
  workspaceArchived = false
): boolean {
  if (workspaceArchived) return false
  const entity = entities[entityId]
  if (!entity || entityLifecycleArchived(entity)) return false

  const { issue } = getAncestryPath(entities, entityId)
  if (issue) return false

  // Verify no ancestor is archived
  let curr: WorkspaceEntity | undefined = entity
  while (curr && curr.placement.parentId !== null) {
    curr = entities[curr.placement.parentId]
    if (!curr || entityLifecycleArchived(curr)) return false
  }

  return true
}

function entityLifecycleArchived(entity: WorkspaceEntity): boolean {
  if ("lifecycle" in entity && entity.lifecycle) {
    try {
      const lifecycle = typeof entity.lifecycle === "string"
        ? JSON.parse(entity.lifecycle) as { state?: string }
        : entity.lifecycle as { state?: string }
      return lifecycle.state === "archived"
    } catch { return Boolean(entity.archivedAt) }
  }
  return Boolean(entity.archivedAt)
}

export function getVisibleChildren(
  entities: Record<string, WorkspaceEntity>,
  parentId: string | null,
  workspaceArchived = false
): WorkspaceEntity[] {
  return visibleChildrenFrom(entities, getChildren(entities, parentId), workspaceArchived)
}

export function visibleIndexedChildren(
  index: ChildrenIndex,
  entities: Record<string, WorkspaceEntity>,
  parentId: string | null,
  workspaceArchived = false,
): WorkspaceEntity[] {
  return visibleChildrenFrom(entities, indexedChildren(index, parentId), workspaceArchived)
}

function visibleChildrenFrom(
  entities: Record<string, WorkspaceEntity>,
  children: readonly WorkspaceEntity[],
  workspaceArchived: boolean,
): WorkspaceEntity[] {
  return children.filter(child => isEntityVisible(entities, child.id, workspaceArchived))
}
