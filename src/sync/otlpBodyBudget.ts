import { ExportResultCode, type ExportResult } from "@opentelemetry/core"

const maxBodyBytes = 65_536
type Batch<T> = { records: T[]; error?: Error }
type ExportOptions<T> = {
  serialize(records: T[]): Uint8Array | undefined
  exporter: { export(records: T[], callback: (result: ExportResult) => void): void }
  active(): boolean
  started(count: number): void
  finished(count: number, result: ExportResult): void
}

/** Respect TinSink's wire-body limit while keeping the official OTLP transport. */
export function exportOtlpBatches<T>(records: T[], options: ExportOptions<T>, callback: (result: ExportResult) => void): void {
  if (!records.length) { callback({ code: ExportResultCode.SUCCESS }); return }
  const batches: Batch<T>[] = []
  function partition(group: T[]) {
    try {
      const body = options.serialize(group)
      if (body && body.byteLength <= maxBodyBytes) { batches.push({ records: group }); return }
      if (group.length > 1) {
        const middle = Math.ceil(group.length / 2)
        partition(group.slice(0, middle))
        partition(group.slice(middle))
      } else batches.push({ records: group, error: new Error("Diagnostic record exceeds the OTLP body limit") })
    } catch (cause) {
      batches.push({ records: group, error: cause instanceof Error ? cause : new Error("Diagnostic serialization failed") })
    }
  }
  partition(records)
  let cursor = 0
  let remaining = batches.length
  let outcome: ExportResult = { code: ExportResultCode.SUCCESS }
  let transportFailure: ExportResult | undefined
  function next() {
    const batch = batches[cursor++]
    if (!batch) return
    // Shutdown already accounts for queued records; never start them after opt-out.
    if (!options.active()) {
      if (--remaining === 0) setTimeout(() => callback(outcome), 0)
      else setTimeout(next, 0)
      return
    }
    options.started(batch.records.length)
    let settled = false
    const complete = (result: ExportResult) => {
      if (settled) return
      settled = true
      options.finished(batch.records.length, result)
      if (result.code !== ExportResultCode.SUCCESS) outcome = result
      // The official exporter releases its concurrency slot after this callback.
      if (--remaining === 0) setTimeout(() => callback(outcome), 0)
      else setTimeout(next, 0)
    }
    if (batch.error) complete({ code: ExportResultCode.FAILED, error: batch.error })
    else if (transportFailure) complete(transportFailure)
    else {
      const exported = (result: ExportResult) => {
        if (result.code !== ExportResultCode.SUCCESS) transportFailure = result
        complete(result)
      }
      try { options.exporter.export(batch.records, exported) }
      catch (cause) { exported({ code: ExportResultCode.FAILED, error: cause instanceof Error ? cause : new Error("Diagnostic export failed") }) }
    }
  }
  // Stop the unsent tail after a transport failure; later SDK batches can retry.
  // At most two requests from this batch; the official exporter also caps its signal.
  next()
  next()
}
