import { createApp, h, ref } from "vue"
import SyncDialog from "../../src/components/SyncDialog.vue"
import { useMyDeviceRemoval } from "../../src/app/useMyDeviceRemoval"
import type { BlindReplicationController } from "../../src/sync/useBlindReplication"

declare global { interface Window { syncRemovalCalls?: string[] } }
export function mountSyncDeviceRemoval(offline = true) {
  const calls: string[] = []
  window.syncRemovalCalls = calls
  const registeredDevices = ref([{ deviceId: "current-device", displayName: "Current label", addedAt: "2026-01-01" }, { deviceId: "old-device", displayName: "Valiant Squirrel's device", addedAt: "2026-02-01" }])
  const replication = {
    configs: ref([{ origin: "https://online.example", workspaceId: "board", scopeId: "scope" }, { origin: "https://offline.example", workspaceId: "board", scopeId: "scope2" }]),
    identityConfigs: ref([]), preferenceConflicts: ref([]), profileSetupErrors: ref({}), profilePermissionUpdates: ref([]), statuses: ref({}), now: ref(Date.now()),
    registeredDevices, currentDeviceId: ref("current-device"), pendingDeviceRevocations: ref([]), revokedDeviceAccess: ref([]),
    busy: ref(false), error: ref(""), notice: ref(""), deviceSyncIssues: ref({}),
    revokeIdentityDevice: async (origin: string, id: string) => { calls.push(`${origin}|${id}`); if (offline && origin.includes("offline")) throw new Error("Server offline; retry when reachable") },
    remove: async () => {}, attach: async () => {}, syncNow: async () => {},
  } as unknown as BlindReplicationController
  const profile = { identity: { personId: "removal-fixture-person" }, device: { deviceId: "current-device" }, certificate: { signature: "fixture" } }
  const root = document.createElement("div")
  document.body.appendChild(root)
  createApp({ setup() {
    const controller = useMyDeviceRemoval({ tincanban: { getCurrentProfile: () => profile, ready: ref(true) }, blindReplication: replication,
      sync: { removableDeviceWorkspaces: async () => [{ id: "board", title: "Synthetic board" }], removeDevice: async (_person: string, id: string, ids: string[]) => { calls.push(`${ids.join(",")}|${id}`) } } } as never)
    return () => h(SyncDialog, { workspaceId: "board", activeWorkspaceId: "board", localDeviceId: "current-device", currentPersonId: profile.identity.personId,
      myDeviceRemoval: controller, blindReplication: replication, step: "members", title: "Sync", qrCode: "", inviteUrl: "", copyNotice: "", error: "",
      meshMembers: [{ personId: profile.identity.personId, name: "Synthetic owner", role: "owner", online: true, reconnecting: false, onlineDevices: 1, devices: 1, self: true,
        deviceList: [{ deviceId: "current-device", name: "Current label", description: "Likely Chrome · macOS", online: true, reconnecting: false, lastSeen: "2026-10-20", tabs: 1 }] }], currentRole: "owner", canManageMesh: true })
  } }).mount(root)
}
