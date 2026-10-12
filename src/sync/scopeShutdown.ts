/** Disconnect without waiting for a receive callback; supervise drain separately. */
export function createScopeShutdown(
  scope: { close: () => Promise<void> },
  connection: { close: () => Promise<void> | void },
  stop: () => void,
  freeLiveness: () => void,
  report: (error: unknown) => void,
) {
  let disconnecting: Promise<void> | undefined
  let draining: Promise<void> | undefined
  const close = (): Promise<void> => {
    if (disconnecting) return disconnecting
    stop()
    // Eviction may run inside this scope's queue or hold its mutation lock.
    draining = scope.close()
    void draining.catch(error => { try { report(error) } catch { /* diagnostics are optional */ } })
    disconnecting = Promise.resolve().then(() => connection.close()).finally(freeLiveness)
    return disconnecting
  }
  return { close, async drain() { await close(); await draining } }
}
