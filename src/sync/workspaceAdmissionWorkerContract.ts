import type { WorkspaceAdmissionInput, WorkspaceAdmissionResult } from "../product-replica/workspaceAdmission"
import type { AccessWorkerRequest } from "./workspaceAccessInput"
import type { WorkspaceRole } from "../domain/permissions"

export type WorkspaceAdmissionRequest = { id: number; kind?: "admission"; input: WorkspaceAdmissionInput }
  | (AccessWorkerRequest & { kind: "access" })
export type WorkspaceAdmissionResponse =
  | { type: "ready" }
  | { type: "initialization-error"; error: string }
  | { id: number; result: WorkspaceAdmissionResult }
  | { id: number; role: WorkspaceRole }
  | { id: number; error: string; fatal?: boolean }
