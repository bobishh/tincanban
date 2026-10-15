export class HistoryCaptureSourceChangedError extends Error {
  constructor(readonly baselineId: string) {
    super("The board changed during history capture. Sync and retry to archive the new changes.")
    this.name = "HistoryCaptureSourceChangedError"
  }
}
