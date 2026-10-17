import type { ComputedRef, Ref } from "vue"
import type { Board, Item, WorkspaceEntity } from "../domain/model"
import type { NarrativeFoldSources } from "../domain/commandTypes"
import { snapshotNarrativeSources } from "../domain/narrative"

export function createNarrativeEditHandler(
  snapshot: Ref<NarrativeFoldSources | undefined>,
  board: ComputedRef<Board | null>,
  entities: () => Record<string, WorkspaceEntity>,
  open: (item: Item) => void,
) {
  return (item: Item) => {
    const notesId = board.value?.cardPresentation?.narrativeFieldId
    const all = entities()
    const isText = notesId && all[notesId]?.kind === "field" && all[notesId].valueType === "text"
    const docs = Object.values(all).filter((entity): entity is Extract<WorkspaceEntity, { kind: "document" }> => entity.kind === "document")
    snapshot.value = snapshotNarrativeSources(item, isText ? notesId : undefined, docs)
    open(item)
  }
}
