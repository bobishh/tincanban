import { shallowRef } from "vue"
import { currentReleaseCompatibility, observeReleaseCompatibility, resetReleaseCompatibilityForTest } from "./releaseCompatibility"
export { assertClientReleaseWritable } from "./releaseCompatibility"

export const releaseState = shallowRef(currentReleaseCompatibility())

export function applyReleaseObservation(value: unknown, runningCandidate: string): void {
  releaseState.value = observeReleaseCompatibility(value, runningCandidate)
}

/** A failed check cannot clear a previously observed upgrade barrier or erase local data. */
export function beginReleaseMonitor(): () => void {
  const candidate = typeof __TINCANBAN_RELEASE_CANDIDATE__ === "undefined" ? "dev" : __TINCANBAN_RELEASE_CANDIDATE__
  if (candidate === "dev") return () => {}
  let stopped = false
  let checking = false
  const check = async () => {
    if (stopped || checking || document.visibilityState === "hidden") return
    checking = true
    try {
      const response = await fetch("/release-cohort.json", { cache: "no-store", credentials: "same-origin", redirect: "error", signal: AbortSignal.timeout(10000) })
      if (!response.ok || stopped) return
      const bytes = await response.text()
      if (bytes.length > 2 * 1024 * 1024 || stopped) return
      applyReleaseObservation(JSON.parse(bytes), candidate)
    } catch { /* Offline tabs retain their last confirmed compatibility state. */ }
    finally { checking = false }
  }
  const visible = () => { void check() }
  document.addEventListener("visibilitychange", visible)
  const interval = setInterval(visible, 60000)
  void check()
  return () => { stopped = true; clearInterval(interval); document.removeEventListener("visibilitychange", visible) }
}

export function resetReleaseStateForTest() {
  releaseState.value = resetReleaseCompatibilityForTest()
}
