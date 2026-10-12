import { createApp, h, ref } from "vue"
import SyncDialog from "../../src/components/SyncDialog.vue"

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

export async function mountSyncLayoutDialog(options: { exportWorkspace?: () => Promise<void> } = {}) {
  const profile = await (await import("../../src/domain/identity")).bootstrapIdentity()
  const root = document.createElement("div")
  document.body.appendChild(root)
  const live = ref(true)
  createApp({ render: () => h(SyncDialog, {
    step: "members", title: "Device sync", qrCode: "", inviteUrl: "", copyNotice: "", error: "",
    exportWorkspace: options.exportWorkspace,
    hasMesh: true, currentRole: "owner", currentPersonId: profile.identity.personId, canManageMesh: true,
    live: live.value, workspaceConnected: false, workspaceReconnecting: false, retryAt: Date.now() + 1_000,
    onStop: () => { live.value = false }, onStart: () => { live.value = true },
    meshMembers: [{ personId: profile.identity.personId, name: "Bo", role: "owner", self: true,
      online: true, reconnecting: false, onlineDevices: 1, devices: 2,
      deviceList: ["one", "two"].map(deviceId => ({ deviceId, name: "Browser", userAgent: "Mozilla/5.0 Chrome/140.0 Linux", description: "Chrome · Linux", online: false, reconnecting: false, tabs: 1, lastSeen: "2026-10-08T12:00:00Z" })),
    }],
  }) }).mount(root)
}
