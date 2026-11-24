import type { LocalStatePlan } from "../localDb"
import type { MeshWorkspaceEnvelope } from "./durableMeshBase"
import type { IdentityDeviceComponent } from "./identityDeviceStateCodec"

export type WorkspaceRouteRecovery = { personId: string; envelopes: MeshWorkspaceEnvelope[] }
export type WorkspaceRouteManifest = { personId: string; components: Record<string, IdentityDeviceComponent> }
export type RouteIdentity = { personId: string; publicKey: string; deviceId: string }
type LocalContacts = { workspaceIds: string[]; profile: RouteIdentity }

export type RouteOperation =
  | { kind: "warm" }
  | { kind: "normalize" | "pack"; value: WorkspaceRouteRecovery }
  | { kind: "read"; personId: string }
  | { kind: "component" | "import"; manifest: WorkspaceRouteManifest }
  | { kind: "export"; personId: string; workspaceIds?: string[] }
  | ({ kind: "capture" | "revision" } & LocalContacts)
  | ({ kind: "envelopes"; options: { skipUnavailable?: boolean } } & LocalContacts)

export type RouteResults = {
  warm: null
  normalize: WorkspaceRouteRecovery
  pack: IdentityDeviceComponent
  read: WorkspaceRouteRecovery
  component: WorkspaceRouteRecovery
  import: LocalStatePlan
  export: Record<string, IdentityDeviceComponent>
  capture: WorkspaceRouteRecovery
  revision: string
  envelopes: MeshWorkspaceEnvelope[]
}
export type RouteResult = RouteResults[keyof RouteResults]
export type RouteWorkerRequest = { id: number; operation: RouteOperation; databaseName?: string }
export type RouteWorkerResponse = { id: number; result: RouteResult } | { id: number; error: string; fatal?: true }

export const workspaceRouteKey = (personId: string) => `tincanban.identity-workspace-routes.v1.${personId}`
export const workspaceRouteComponent = "workspaceRouteRecovery"
export const workspaceRouteSchema = "workspace-route-recovery@1"
export const packedWorkspaceRouteSchema = "workspace-route-recovery@2"

export function isIdentityWorkspaceRouteRecoveryComponent(name: string, component: IdentityDeviceComponent): boolean {
  return name === workspaceRouteComponent && [workspaceRouteSchema, packedWorkspaceRouteSchema].includes(component.schema) && !component.required
}
