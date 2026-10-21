export type MyDeviceRemoval = { version: 1; personId: string; signerDeviceId: string; deviceId: string; name: string;
  workspaces: Record<string, "pending" | "removed">; workspaceTitles?: Record<string, string>; workspaceErrors?: Record<string, string>;
  origins: Record<string, { status: "pending" | "removed"; error?: string }>; abandonedOrigins?: string[] }
export const myDeviceRemovalsKey = (personId: string) => `tincanban.my-device-removals.v1.${personId}`

export function myDeviceRemovalComplete(job: MyDeviceRemoval): boolean {
  return !Object.keys(job.workspaceErrors ?? {}).length && Object.values(job.workspaces).every(state => state === "removed") &&
    Object.values(job.origins).every(state => state.status === "removed")
}
