import type { Ref } from "vue"

export const visibleReplicationPollMs = 2_000
export const hiddenReplicationPollMs = 15_000

/** A visible device polls quickly. A hidden one keeps a slow fallback until the browser freezes it. */
export function replicationPollDelay(hidden: boolean): number {
  return hidden ? hiddenReplicationPollMs : visibleReplicationPollMs
}

/** Coalesce requests during a pass and bound retries until the next external trigger. */
export function createReplicationFollowUp() {
  let requested = false, retries = 0
  return {
    request: () => { requested = true },
    next(catchingUp: boolean): boolean {
      const retry = requested || (catchingUp && retries < 2)
      retries = catchingUp && retry ? retries + 1 : 0
      requested = false
      return retry
    },
  }
}

/** Periodic discovery and resume stay independent of one board's local change. */
export function startPrivateReplicationTriggers(now: Ref<number>, sync: () => Promise<void>, onResume: () => void = () => {}) {
  const hidden = () => typeof document !== "undefined" && document.hidden
  const healthClock = setInterval(() => { now.value = Date.now() }, 1000)
  let timer = setInterval(() => { void sync() }, replicationPollDelay(hidden()))
  const resume = () => {
    now.value = Date.now()
    onResume()
    void sync()
  }
  const onPageShow = (event: PageTransitionEvent) => { if (event.persisted) resume() }
  const onVisibility = () => {
    clearInterval(timer)
    timer = setInterval(() => { void sync() }, replicationPollDelay(hidden()))
    if (hidden()) void sync()
    else resume()
  }
  if (typeof document !== "undefined" && typeof document.addEventListener === "function") document.addEventListener("visibilitychange", onVisibility)
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("pagehide", onVisibility)
    window.addEventListener("pageshow", onPageShow)
    window.addEventListener("online", resume)
  }
  return () => {
    clearInterval(timer)
    clearInterval(healthClock)
    if (typeof document !== "undefined" && typeof document.removeEventListener === "function") document.removeEventListener("visibilitychange", onVisibility)
    if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
      window.removeEventListener("pagehide", onVisibility)
      window.removeEventListener("pageshow", onPageShow)
      window.removeEventListener("online", resume)
    }
  }
}
