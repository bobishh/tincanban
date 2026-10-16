export function createPublicDeliveryQueue(
  processWorkspace: (workspaceId: string) => Promise<void> | void,
  debounceMs = 350,
  onError: (workspaceId: string, error: unknown) => void = () => {},
) {
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const running = new Set<string>()
  const pending = new Set<string>()
  let stopped = false

  function enqueue(workspaceId: string) {
    if (stopped || !workspaceId) return
    pending.add(workspaceId)
    schedule(workspaceId)
  }

  function schedule(workspaceId: string) {
    if (stopped || running.has(workspaceId) || timers.has(workspaceId)) return
    timers.set(workspaceId, setTimeout(() => {
      timers.delete(workspaceId)
      void drain(workspaceId)
    }, debounceMs))
  }

  async function drain(workspaceId: string) {
    if (stopped || running.has(workspaceId) || !pending.delete(workspaceId)) return
    running.add(workspaceId)
    try {
      await processWorkspace(workspaceId)
    } catch (error) {
      onError(workspaceId, error)
    } finally {
      running.delete(workspaceId)
      if (pending.has(workspaceId)) schedule(workspaceId)
    }
  }

  function stop() {
    stopped = true
    for (const timer of timers.values()) clearTimeout(timer)
    timers.clear()
    pending.clear()
  }

  return { enqueue, stop }
}
