import { ReplicaEngine } from "@meta-uber/mesh-replication/replica-engine"
import { uploadBlindObject, verifyBlindReceipt, type BlindReceipt } from "./blindClient"
import type { PrivateReplicaConfig } from "./blindReplication"
import type { BlindObject } from "@meta-uber/mesh-replication/rusty-replica"
import { getPrivateReplicaProgress, persistPrivateReplicaState, privateReplicaBinding } from "./privateReplicaRepository"
import { assertReplicaCredentialFreezeCurrent, type ReplicaCredentialFreeze } from "./replicaCredentialFreeze"
import { createRustyIdentityProfileScopeFetcher } from "./rustyIdentityTransport"
import type { LocalProfile } from "../domain/identity"

/** A frozen transition can finish an existing request, but has no port capable of creating or admitting content. */
export async function drainFrozenReplica(pending: ReplicaCredentialFreeze, config: PrivateReplicaConfig,
  profile: LocalProfile, guardCurrentAuthority: () => Promise<void>): Promise<void> {
  pending = structuredClone(pending)
  config = structuredClone(config)
  profile = structuredClone(profile)
  const owner = pending.personId
  const guard = async () => {
    await guardCurrentAuthority()
    await assertReplicaCredentialFreezeCurrent(pending, config)
    await guardCurrentAuthority()
  }
  const unavailable = async (): Promise<never> => { throw new Error("Frozen maintenance cannot create or admit replica content") }
  const scopeFetch = createRustyIdentityProfileScopeFetcher({ access: config, profile, ensureCurrent: guard })
  const engine = new ReplicaEngine<never, BlindObject, BlindReceipt>(privateReplicaBinding(owner, config), {
    repository: {
      read: () => getPrivateReplicaProgress(owner, config, pending),
      commit: async (generation, next) => {
        await guard()
        await persistPrivateReplicaState(owner, config, generation, next, () => {}, pending)
        await guard()
      },
    },
    content: { revision: unavailable, capture: unavailable, seal: unavailable },
    transport: { inventory: unavailable, download: unavailable, upload: (object, requestId, observedSequence) =>
      uploadBlindObject(config, object, requestId, observedSequence, scopeFetch) },
    admit: unavailable,
    verifyReceipt: (receipt, object, requestId) => verifyBlindReceipt(receipt, config, object, requestId),
    guard,
  })
  await engine.drainPending()
  await guard()
  if ((await getPrivateReplicaProgress(owner, config, pending)).pending) throw new Error("Frozen Rusty outbox remains unconfirmed")
}
