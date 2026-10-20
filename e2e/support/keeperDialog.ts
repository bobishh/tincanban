import { createApp, h, ref } from "vue"
import WorkspaceFileActions from "../../src/components/WorkspaceFileActions.vue"
import SyncDialog from "../../src/components/SyncDialog.vue"
import { replicationPresence, replicaKey } from "../../src/sync/replicationHealth"

export function mountWorkspaceFileActions(exportWorkspace: () => Promise<void>) {
  const root = document.createElement("div")
  document.body.appendChild(root)
  createApp(WorkspaceFileActions, { exportWorkspace }).mount(root)
}

export function mountMobileDeviceListDialog() {
  const root = document.createElement("div")
  document.body.appendChild(root)
  const app = createApp(SyncDialog, {
    step: "members", title: "Device sync", qrCode: "", inviteUrl: "", copyNotice: "", error: "", hasMesh: true,
    meshMembers: [{ personId: "mobile-fixture", name: "Mobile test participant", role: "editor", self: false,
      online: true, reconnecting: false, onlineDevices: 20, devices: 20,
      deviceList: Array.from({ length: 20 }, (_, index) => ({
        deviceId: `phone-${index}`, name: `Phone ${index + 1}`, userAgent: "Mozilla/5.0 Chrome/140.0 Linux",
        description: "Likely Chrome · Linux", online: true, reconnecting: false, tabs: 1, lastSeen: "2026-10-02T12:00:00Z",
      })),
    }],
    onClose: () => { app.unmount(); root.remove() },
  })
  app.mount(root)
}

export async function mountSyncLayoutDialog() {
  const profile = await (await import("../../src/domain/identity")).bootstrapIdentity()
  const root = document.createElement("div")
  document.body.appendChild(root)
  const live = ref(true)
  createApp({ render: () => h(SyncDialog, {
    step: "members", title: "Device sync", qrCode: "", inviteUrl: "", copyNotice: "", error: "",
    hasMesh: true, currentRole: "owner", currentPersonId: profile.identity.personId, canManageMesh: true,
    live: live.value, workspaceConnected: false, workspaceReconnecting: false, retryAt: Date.now() + 1_000,
    onStop: () => { live.value = false },
    meshMembers: [{ personId: profile.identity.personId, name: "Bo", role: "owner", self: true,
      online: true, reconnecting: false, onlineDevices: 1, devices: 2,
      deviceList: ["one", "two"].map(deviceId => ({ deviceId, name: "Browser", userAgent: "Mozilla/5.0 Chrome/140.0 Linux", description: "Chrome · Linux", online: false, reconnecting: false, tabs: 1, lastSeen: "2026-10-08T12:00:00Z" })),
    }],
  }) }).mount(root)
}

export async function mountRustyAvailableSyncDialog(options: { networkOnline?: boolean } = {}) {
  const profile = await (await import("../../src/domain/identity")).bootstrapIdentity()
  const root = document.createElement("div")
  document.body.appendChild(root)
  const now = Date.now()
  const config = { purpose: "workspace" as const, origin: "https://rusty.example", scopeId: "workspace-scope", workspaceId: "board",
    keyEpoch: 1, servicePublicKey: "A".repeat(43), contentKey: "B".repeat(43), readToken: "R".repeat(43), writeToken: "W".repeat(43),
    cursor: 0, lastUploaded: "", policyRevision: 1 }
  const meshPresence = replicationPresence("empty", [config], {
    [replicaKey(config)]: { phase: "synced", lastSyncedAt: now },
  }, "board", now)
  createApp(SyncDialog, {
    step: "members", title: "Device sync", qrCode: "", inviteUrl: "", copyNotice: "", error: "", hasMesh: true,
    live: true, networkOnline: options.networkOnline ?? true, workspaceConnected: false, workspaceReconnecting: false, meshPresence,
    meshDiagnostic: "Workspace board unavailable: remote browser is unavailable", retryAt: now + 1_000,
    localDeviceId: profile.device.deviceId,
    meshMembers: [
      { personId: profile.identity.personId, name: "You", role: "owner", self: true,
        online: true, reconnecting: false, onlineDevices: 1, devices: 1,
        deviceList: [{ deviceId: profile.device.deviceId, name: "This device", userAgent: "Mozilla/5.0 Chrome/140.0 Linux",
          description: "Likely Chrome · Linux", online: true, reconnecting: false, tabs: 1, lastSeen: new Date(now).toISOString() }],
      },
      { personId: "remote-person", name: "Remote browser", role: "editor", self: false,
        online: false, reconnecting: false, onlineDevices: 0, devices: 1,
        deviceList: [{ deviceId: "remote-device", name: "Remote browser", userAgent: "Mozilla/5.0 Firefox/140.0 Linux",
          description: "Likely Firefox · Linux", online: false, reconnecting: false, tabs: 1, lastSeen: new Date(now - 60_000).toISOString() }],
      },
    ],
  }).mount(root)
}
