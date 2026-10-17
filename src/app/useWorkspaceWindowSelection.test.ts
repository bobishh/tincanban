import { effectScope, ref } from "vue"
import { describe, expect, it } from "vitest"
import { useWorkspaceWindowSelection } from "./useWorkspaceWindowSelection"

function setup() {
  const scope = effectScope()
  const workspaceId = ref("a")
  const selectedItemId = ref<string | null>(null)
  scope.run(() => useWorkspaceWindowSelection(() => workspaceId.value, { selectedItemId }))
  return { scope, workspaceId, selectedItemId }
}

describe("workspace window selection", () => {
  it("isolates generic and lead selections and restores each workspace synchronously", () => {
    const state = setup()
    state.selectedItemId.value = "item-a"
    state.workspaceId.value = "b"
    expect(state.selectedItemId.value).toBeNull()
    state.selectedItemId.value = "item-b"
    state.workspaceId.value = "a"
    expect(state.selectedItemId.value).toBe("item-a")
    state.workspaceId.value = "b"
    expect(state.selectedItemId.value).toBe("item-b")
    state.scope.stop()
  })
  it("keeps explicitly closed item windows closed when returning", () => {
    const state = setup()
    state.selectedItemId.value = "item-a"
    state.workspaceId.value = "b"
    state.workspaceId.value = "a"
    state.selectedItemId.value = null
    state.workspaceId.value = "b"
    state.workspaceId.value = "a"
    expect(state.selectedItemId.value).toBeNull()
    state.scope.stop()
  })
})
