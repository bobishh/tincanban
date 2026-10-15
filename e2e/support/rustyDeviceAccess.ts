import { createApp, h, ref } from "vue"
import type { BlindReplicationController } from "../../src/sync/useBlindReplication"
import RustyPanel from "../../src/components/RustyPanel.vue"

const origin = "https://rusty.example"

type FixtureState = {
  calls: Array<{ origin: string; workspaceId: string }>
  revocations: Array<{ origin: string; deviceId: string }>
  resolvePending?: () => void
}
type PreferenceConflict = { origin: string; scopeId: string; workspaceIds: string[]; identityState: boolean }

declare global {
  interface Window { rustyDeviceAccessFixture?: FixtureState }
}

export function mountRustyDeviceAccess(mode: "success" | "failure" | "pending" = "success", owner = true,
  conflicts: PreferenceConflict[] = []) {
  const fixture: FixtureState = { calls: [], revocations: [] }
  window.rustyDeviceAccessFixture = fixture
  const profilePermissionUpdates = ref([origin])
  const controller = {
    configs: ref([{ origin, workspaceId: "board", scopeId: "board-scope", servicePublicKey: "service-key",
      readToken: "read-token", writeToken: "write-token", policyRevision: 1, keyEpoch: 1,
      contentKey: "content-key", cursor: 0, lastUploaded: "" }]),
    identityConfigs: ref([]), profileSetupErrors: ref({}), statuses: ref({}), now: ref(Date.now()),
    preferenceConflicts: ref(conflicts),
    registeredDevices: ref([{ deviceId: "local-device", displayName: "This device", addedAt: "2026-01-01T00:00:00.000Z" },
      { deviceId: "other-device", displayName: "Travel laptop", addedAt: "2026-02-01T00:00:00.000Z" }]),
    currentDeviceId: ref("local-device"), pendingDeviceRevocations: ref(mode === "pending" ? [`${origin}|other-device`] : []),
    revokedDeviceAccess: ref([]),
    busy: ref(false), error: ref(""), notice: ref(""), profilePermissionUpdates,
    updateDeviceAccess: async (requestedOrigin: string, workspaceId: string) => {
      fixture.calls.push({ origin: requestedOrigin, workspaceId })
      if (mode === "failure") throw new Error("Device access update failed")
      if (mode === "pending") await new Promise<void>(resolve => { fixture.resolvePending = resolve })
      profilePermissionUpdates.value = profilePermissionUpdates.value.filter(value => value !== requestedOrigin)
    },
    revokeIdentityDevice: async (requestedOrigin: string, deviceId: string) => {
      fixture.revocations.push({ origin: requestedOrigin, deviceId })
      if (mode === "failure") throw new Error("Device access removal pending")
      if (mode === "pending") await new Promise<void>(resolve => { fixture.resolvePending = resolve })
      controller.registeredDevices.value = controller.registeredDevices.value.filter(device => device.deviceId !== deviceId)
    },
    remove: async () => {}, attach: async () => {}, exportAutomationAccess: async () => "", syncNow: async () => {},
    fetchAttachment: async () => new Uint8Array(),
  } as unknown as BlindReplicationController
  const controllerValue = controller
  const root = document.createElement("div")
  document.body.appendChild(root)
  createApp({ render: () => h(RustyPanel, { controller, workspaceId: "board", owner }) }).mount(root)
}
