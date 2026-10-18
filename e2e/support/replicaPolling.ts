import { createApp, h, ref } from "vue"
import BrandCan from "../../src/components/BrandCan.vue"
import { recordReplicaHealth } from "../../src/sync/replicaHealthRun"
import { replicaKey, replicaStatus, replicationPresence, type ReplicaHealth } from "../../src/sync/replicationHealth"
import { rustyRequestFailure } from "../../src/sync/replicationErrors"
import type { BlindReplicaConfig } from "../../src/sync/blindReplication"

export function mountReplicaPolling() {
  const config = { origin: "https://rusty.example", scopeId: "fixture-scope", workspaceId: "fixture-board" } as BlindReplicaConfig
  const statuses = ref<Record<string, ReplicaHealth>>({ [replicaKey(config)]: { phase: "synced", lastSyncedAt: Date.now() } })
  let rejectRequest: (error: Error) => void = () => {}
  const poll = () => recordReplicaHealth(config, statuses, () => new Promise<boolean>((_resolve, reject) => { rejectRequest = reject }), () => true)
  const root = document.createElement("div")
  document.body.appendChild(root)
  createApp({ render: () => h("section", { "aria-label": "Replica polling fixture" }, [
    h(BrandCan, { presence: replicationPresence("offline", [config], statuses.value, config.workspaceId, Date.now()), label: "Board connection" }),
    h("p", { role: "status" }, replicaStatus(config, statuses.value[replicaKey(config)], Date.now())),
    h("button", { onClick: poll }, "Poll board"),
    h("button", { onClick: () => rejectRequest(rustyRequestFailure(new TypeError("Network unavailable"))) }, "Fail request"),
  ]) }).mount(root)
}
