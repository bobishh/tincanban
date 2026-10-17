import { useTincanban as useState } from "../state"
import { createWorkspaceDoc } from "./boardFixture"
import { projectBoardSchema } from "../domain/schema"
export { hydrate, reconcile, resetStateForTest } from "../state"
export function useTincanban() {
  const app = useState()
  const create = app.createWorkspaceAsync
  app.createWorkspaceAsync = (title, template, storage, config) => {
    if (template !== "job-search") return create(title, template, storage, config)
    const doc = createWorkspaceDoc("fixture", title, "fixture-owner", template)
    const board = Object.values(doc.entities).find(entity => entity.kind === "board")!
    return create(title, template, storage, config ?? { ...projectBoardSchema(doc, board.id), presetBindings: { ...board.preset?.bindings } })
  }
  return app
}
