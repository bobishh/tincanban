type AccessMaintenance = {
  prepare(): Promise<{ changed: boolean; failures: unknown[] }>
  publish(): Promise<void>
  failed(cause: unknown): void
}

/** Storage access follows an admitted peer session without gating its document delivery. */
export function createWorkspaceRustyAccessMaintenance(input: AccessMaintenance) {
  let started = false, stopped = false, unpublished = false, failures = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  async function run() {
    if (stopped) return
    let delay = 15_000
    try {
      const { changed, failures: pending } = await input.prepare()
      if (stopped) return
      unpublished ||= changed
      if (unpublished) {
        await input.publish()
        if (stopped) return
        unpublished = false
      }
      if (pending.length) throw new AggregateError(pending, "Storage access preparation remains pending")
      failures = 0
    } catch (cause) {
      if (stopped) return
      delay = Math.min(60_000, 1000 * 2 ** Math.min(failures++, 6))
      input.failed(cause)
    }
    if (!stopped) timer = setTimeout(() => { void run() }, delay)
  }
  return {
    start() {
      if (started || stopped) return
      started = true
      void run()
    },
    stop() {
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
    },
  }
}
