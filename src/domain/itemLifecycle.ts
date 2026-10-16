import type { Item } from "./entitySchemas"

export type ItemLifecycle = { state: "active" | "archived"; changedAt: string }
export type ItemWorkflow = { columnId: string; changedAt: string }

function transitionRecord<T>(value: T | string | undefined): T | undefined {
  if (typeof value !== "string") return value
  try { return JSON.parse(value) as T } catch { return undefined }
}

export function itemLifecycle(item: Pick<Item, "archivedAt" | "lifecycle">): ItemLifecycle | undefined {
  return transitionRecord<ItemLifecycle>(item.lifecycle)
}

export function itemWorkflow(item: Pick<Item, "workflow">): ItemWorkflow | undefined {
  return transitionRecord<ItemWorkflow>(item.workflow)
}

export function isItemArchived(item: Pick<Item, "archivedAt" | "lifecycle">): boolean {
  return itemLifecycle(item)?.state === "archived" || (!itemLifecycle(item) && Boolean(item.archivedAt))
}

export function setItemLifecycle(item: Item, archived: boolean, changedAt: string): void {
  item.lifecycle = JSON.stringify({ state: archived ? "archived" : "active", changedAt } satisfies ItemLifecycle)
  delete item.archivedAt
}

export function setItemWorkflow(item: Item, columnId: string, changedAt: string): void {
  item.workflow = JSON.stringify({ columnId, changedAt } satisfies ItemWorkflow)
}
