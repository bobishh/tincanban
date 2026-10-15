/** A host-side join failure that must not be treated as a transient peer disconnect. */
export class WorkspaceAdmissionFailure extends Error {
  constructor(error: unknown) {
    super(error instanceof Error ? error.message : String(error), { cause: error })
    this.name = "WorkspaceAdmissionFailure"
  }
}
