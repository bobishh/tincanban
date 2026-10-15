const authorityRaceMessage = "Workspace authority changed during access validation. Retry."

export async function withWorkspaceAuthorityRaceRetry<T>(operation: () => Promise<T>, ensureCurrent: () => void): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (!(error instanceof Error) || error.message !== authorityRaceMessage) throw error
    ensureCurrent()
    return operation()
  }
}
