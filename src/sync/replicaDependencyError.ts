export type AutomationWriterStage = "inspection" | "confirmation"

/** A writer-policy barrier can fail at automation while Rusty itself remains reachable. */
export class AutomationWriterDependencyError extends Error {
  readonly dependency = "automation"

  constructor(readonly stage: AutomationWriterStage, readonly origin: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : "Request failed"
    super(`Automation storage ${stage} failed (${new URL(origin).host}): ${detail}`, { cause })
    this.name = "AutomationWriterDependencyError"
  }
}

export async function withAutomationWriterDependency<T>(stage: AutomationWriterStage, origin: string,
  operation: () => Promise<T>): Promise<T> {
  try { return await operation() }
  catch (cause) { throw new AutomationWriterDependencyError(stage, origin, cause) }
}
