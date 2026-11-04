import { expect, test, vi } from "vitest"
import { ref } from "vue"
import { createReplicationFollowUp, hiddenReplicationPollMs, replicationPollDelay, startPrivateReplicationTriggers, visibleReplicationPollMs } from "./privateReplicationTriggers"

const chat = vi.hoisted(() => ({ stop: vi.fn() }))
vi.mock("../chat/service", () => ({ subscribeChat: () => chat.stop }))

test("Given a visible document, when the fallback poll is chosen, then it is shorter than the hidden fallback", () => {
  expect(replicationPollDelay(false)).toBe(visibleReplicationPollMs)
  expect(replicationPollDelay(true)).toBe(hiddenReplicationPollMs)
  expect(visibleReplicationPollMs).toBeLessThan(hiddenReplicationPollMs)
})

test("Given repeated catch-up passes, when no external edit arrives, then stop after two retries and renew the budget for the next poll", () => {
  const followUp = createReplicationFollowUp()
  expect([followUp.next(true), followUp.next(true), followUp.next(true)]).toEqual([true, true, false])
  expect(followUp.next(true)).toBe(true)
})

test("Given requests during a pass, when that pass finishes caught up, then coalesce them into one follow-up", () => {
  const followUp = createReplicationFollowUp()
  followUp.request()
  followUp.request()
  expect(followUp.next(false)).toBe(true)
  expect(followUp.next(false)).toBe(false)
})

test("Given live replication triggers, when visibility changes and the page hides, then sync immediately, change polling delay and remove listeners on stop", async () => {
  vi.useFakeTimers()
  const documentEvents = new EventTarget(), windowEvents = new EventTarget()
  const document = { hidden: false, addEventListener: documentEvents.addEventListener.bind(documentEvents),
    removeEventListener: documentEvents.removeEventListener.bind(documentEvents) }
  vi.stubGlobal("document", document)
  vi.stubGlobal("window", windowEvents)
  const sync = vi.fn(async () => {}), stopWorkspace = vi.fn()
  const now = ref(0)
  const stop = startPrivateReplicationTriggers({ subscribeLocalChanges: () => stopWorkspace }, now, sync)
  try {
    await vi.advanceTimersByTimeAsync(2_000)
    expect(sync).toHaveBeenCalledTimes(1)
    document.hidden = true
    documentEvents.dispatchEvent(new Event("visibilitychange"))
    expect(sync).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(14_999)
    expect(sync).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(sync).toHaveBeenCalledTimes(3)
    windowEvents.dispatchEvent(new Event("pagehide"))
    expect(sync).toHaveBeenCalledTimes(4)
    stop()
    documentEvents.dispatchEvent(new Event("visibilitychange"))
    windowEvents.dispatchEvent(new Event("pagehide"))
    await vi.advanceTimersByTimeAsync(30_000)
    expect(sync).toHaveBeenCalledTimes(4)
    expect(stopWorkspace).toHaveBeenCalledOnce()
    expect(chat.stop).toHaveBeenCalledOnce()
  } finally { stop(); vi.useRealTimers(); vi.unstubAllGlobals() }
})
