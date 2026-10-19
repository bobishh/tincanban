/** Optional read observation; storage remains independent of telemetry. */
export type StorageReadTrace = <T>(stage: string, read: () => T | Promise<T>, detail?: Record<string, unknown>) => T | Promise<T>

export function traceStorageRead<T>(trace: StorageReadTrace | undefined, stage: string,
  read: () => T | Promise<T>, detail?: Record<string, unknown>): T | Promise<T> {
  return trace ? trace(stage, read, detail) : read()
}
