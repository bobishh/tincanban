import type { Command } from "./domain/commands"
import { isItem } from "./domain/model"
import { commitAndPersist } from "./statePersistence"
import { stateRuntime } from "./stateContext"

type ItemInput = Omit<Extract<Command, { kind: "createItem" }>, "kind">
type ItemPatch = Omit<Extract<Command, { kind: "patchItem" }>, "kind" | "entityId">
export function createItemActions() {
  return {
    async createItemAsync(input: ItemInput) {
      const id = input.id ?? crypto.randomUUID()
      await commitAndPersist({ ...input, kind: "createItem", id })
      const item = stateRuntime.activeDoc?.entities[id]
      if (!isItem(item)) throw new Error("Saved item is unavailable")
      return item
    },
    updateItemAsync(entityId: string, patch: ItemPatch) {
      return commitAndPersist({ ...patch, kind: "patchItem", entityId })
    },
  }
}
