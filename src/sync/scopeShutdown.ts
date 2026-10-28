import type { DuplexStream } from "./transport"

/** A denied send owns only its stream; cleanup never replaces the authorization failure. */
export function guardScopeStream(stream: DuplexStream, ensureCurrent: () => Promise<void>): DuplexStream {
  return {
    read: maximum => stream.read(maximum), closeSend: () => stream.closeSend(),
    send: async bytes => {
      try { await ensureCurrent(); await stream.send(bytes) }
      catch (error) {
        try { if (stream.reset) await stream.reset(); else await stream.closeSend() } catch { /* Preserve the original denial or transport failure. */ }
        throw error
      }
    },
    ...(stream.reset ? { reset: () => stream.reset!() } : {}),
    ...(stream.readRaw ? { readRaw: (maximum?: number) => stream.readRaw!(maximum) } : {}),
    ...(stream.readPairingOrRawPrefix ? { readPairingOrRawPrefix: (prefix: Uint8Array, maximum?: number) =>
      stream.readPairingOrRawPrefix!(prefix, maximum) } : {}),
  }
}

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
