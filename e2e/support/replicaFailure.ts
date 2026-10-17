import { createApp, h } from "vue"
import SyncDialog from "../../src/components/SyncDialog.vue"
import { createReplicationState } from "../../src/sync/privateReplicationState"
import { recordReplicaHealth } from "../../src/sync/replicaHealthRun"
import { rustyRequestFailure } from "../../src/sync/replicationErrors"
import type { BlindReplicationController } from "../../src/sync/useBlindReplication"

export async function mountReplicaFailure(mode: "local" | "network") {
  const state = createReplicationState()
  const config = { origin: "https://rusty.example", scopeId: "fixture-scope", workspaceId: "board", contentKey: "A".repeat(43),
    readToken: "B".repeat(43), writeToken: "C".repeat(43), servicePublicKey: "D".repeat(43),
    policyRevision: 1, keyEpoch: 1, cursor: 0, lastUploaded: "" }
  state.configs.value = [config]
  let failed = false
  const syncNow = async () => {
    state.busy.value = true
    try {
      await recordReplicaHealth(config, state.statuses, async () => {
        if (failed) return true
        failed = true
        if (mode === "network") throw rustyRequestFailure(new TypeError("raw-private-transport-detail"))
        throw new Error("Replica progress generation changed during persistence")
      }, () => true, state.deviceSyncIssues)
    } finally { state.busy.value = false }
  }
  await syncNow()
  const controller = { ...state, syncNow, remove: async () => {}, attach: async () => {} } as unknown as BlindReplicationController
  const root = document.createElement("div")
  document.body.appendChild(root)
  createApp({ render: () => h(SyncDialog, { step: "members", title: "Device sync", qrCode: "", inviteUrl: "", copyNotice: "", error: "",
    initialTab: "Rusty", hasMesh: true, currentRole: "owner", currentPersonId: "fixture-person", canManageMesh: true,
    activeWorkspaceId: "board", blindReplication: controller, meshMembers: [] }) }).mount(root)
}
