export type WorkspaceAccessInput = Record<string, unknown> & {
  snapshot: Record<string, unknown>
  controlGraph: Record<string, string[]>
}
export type AccessWorkerRequest = { id: number; diagnosticsEnabled?: boolean; input: WorkspaceAccessInput }
