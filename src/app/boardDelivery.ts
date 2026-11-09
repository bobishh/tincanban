import { watch, type WatchSource } from "vue"
import { subscribeChat, type ChatChange } from "../chat/service"

/** A board change or selection. No transport credentials and no freshness claim. */
export type BoardDeliveryIntent = { workspaceId: string; changed: boolean }

/** Each installed source receives the intent. One failure does not skip the others. */
export function deliverIndependent(actions: ReadonlyArray<() => void | Promise<void>>, report: (cause: unknown) => void) {
  for (const action of actions) {
    try {
      const result = action()
      if (isPromise(result)) void result.catch(report)
    } catch (cause) { report(cause) }
  }
}

function isPromise(value: void | Promise<void>): value is Promise<void> {
  return typeof (value as Promise<void> | undefined)?.then === "function"
}

/** The application owns local board events. Mesh and Rusty consume the resulting intent on their own. */
export function startSharedBoardDelivery(input: {
  subscribeLocalChanges: (listener: (workspaceId?: string) => void) => () => void
  activeWorkspaceId: WatchSource<string>
  deliver: (intent: BoardDeliveryIntent) => void
  deliverUnknown: () => void
}) {
  const stopWorkspace = input.subscribeLocalChanges(workspaceId => {
    if (workspaceId) input.deliver({ workspaceId, changed: true })
    else input.deliverUnknown()
  })
  const stopChat = subscribeChat((event: ChatChange) => {
    if (event.contentChanged === false) return
    if (event.workspaceId) input.deliver({ workspaceId: event.workspaceId, changed: true })
    else input.deliverUnknown()
  })
  const stopSelection = watch(input.activeWorkspaceId, workspaceId => {
    if (workspaceId) input.deliver({ workspaceId, changed: false })
  })
  return () => { stopWorkspace(); stopChat(); stopSelection() }
}
