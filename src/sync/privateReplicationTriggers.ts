import type { Ref } from "vue"
import type { useTincanban } from "../state"
import { subscribeChat } from "../chat/service"

/** Share one sync trigger policy; typing presence never starts a storage pass. */
export function startPrivateReplicationTriggers(app: Pick<ReturnType<typeof useTincanban>, "subscribeLocalChanges">,
  now: Ref<number>, sync: () => Promise<void>) {
  const healthClock = setInterval(() => { now.value = Date.now() }, 1000)
  const timer = setInterval(() => { void sync() }, 15000)
  const stopWorkspace = app.subscribeLocalChanges(() => { void sync() })
  const stopChat = subscribeChat(event => { if (event.contentChanged !== false) void sync() })
  return () => { clearInterval(timer); clearInterval(healthClock); stopWorkspace(); stopChat() }
}
