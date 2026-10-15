/** Absence is recoverable; a storage or admission failure must retain its original cause. */
export class WorkspaceUnavailableError extends Error {
  readonly code = "workspace-unavailable"
  constructor() { super("The selected workspace is unavailable on this device.") }
}
