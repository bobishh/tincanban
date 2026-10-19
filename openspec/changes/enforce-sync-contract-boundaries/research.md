# Inspection baseline

Inspected 2026-10-18: Tincanban `8aacdf4f9516af688bf511b6fc4eec5ac01ab73a`,
MetaMesh `0af200292beb37dc16b5430ef2c52c9e6864def7`.
Read-only source investigation; no runtime reproductions or local tests executed.
Line numbers describe this baseline; named symbols identify the lasting contract.

| Finding | Evidence | Established fact / limit of conclusion |
| --- | --- | --- |
| Automation packaging | [replica.ts:7](../../../workers/automation/src/replica.ts#L7), imports of `workspaceAdmissionCore`, `blindClient`, `blindReplication`, `replicaContentKeys`, `historyBaselineReceiver` | Production participant depends on Tincanban source layout. `ReplicaEngine` and archive remote already come from MetaMesh. This is coupling, not proof of duplicated crypto or a signature bypass. |
| Full-snapshot commit | [storage.ts:290](../../../src/storage.ts#L290), `commitWorkspace`; [workspaceMutation.ts](../../../src/workspaceMutation.ts) | Method documents an external lock requirement. Its IDB transaction reads current snapshot but can write a candidate with different heads without checking the earlier read's durable revision. Current ordinary command/receive callers do acquire the lock; current data loss is not established. |
| Other workspace writers | [storage.ts](../../../src/storage.ts), `saveSnapshot`, `compactWorkspace`, `rekeyWorkspace`; [storageDeltaAccess.ts](../../../src/storageDeltaAccess.ts) | Wrappers and maintenance must enter the same boundary. `rekeyWorkspace` has test callers but no production caller found; remove unused API rather than inventing a new migration. Delta CAS already exists and must be retained. |
| Decoder allocation | [pairing.rs:66](../../../vendor/meta-mesh/crates/meta-mesh-core/src/pairing.rs#L66), `inspect` / `decode` | Header scanning/JSON and payload `to_vec()` have no common frame/header cap. Some downstream frame types already have limits. A core budget gap is confirmed; remote exploitability is not. |
| Browser ingress | [node.rs:152](../../../vendor/meta-mesh/crates/meta-mesh/src/node.rs#L152), `BrowserStream::read`; [workspaceSetLive.ts](../../../src/sync/workspaceSetLive.ts), `confirmHeartbeat` / receive loops; [deviceSyncEnrollment.ts](../../../src/sync/deviceSyncEnrollment.ts) | Omitting a byte bound becomes `usize::MAX`; production call sites omit it. A timeout race alone does not stop the underlying read. Byte-budget enforcement must precede buffering, not just decoding. |
| Native/core mismatch | [native node.rs:32](../../../vendor/meta-mesh/crates/meta-mesh-native/src/node.rs#L32), `MAX_RPC_BYTES`; [live_session.rs:10](../../../vendor/meta-mesh/crates/meta-mesh-core/src/live_session.rs#L10), `MAX_OWNER_OFFER_BYTES` | Native transport caps a complete RPC at 16 MiB; core allows a 24 MiB offer payload. The advertised logical allowance cannot be treated as a cross-host single-frame allowance. This is a confirmed limit mismatch, not an observed production outage. |
| Cache lifetime | [storageDeltaRepository.ts:19](../../../src/storageDeltaRepository.ts#L19), `forget` / `remember`; [loadDocument:61](../../../src/storageDeltaRepository.ts#L61) | `forget` frees the cached handle; cache has eight entries. `loadDocument` awaits `read`, then retrieves the document again from the mutable map while retaining the earlier `checked` heads. Replacement/eviction can make the result absent or inconsistent. Proposed interleaving below still needs an executable regression. |

## Proposed failure reproductions

- Workspace: two storage instances read basis R; A commits a snapshot/delta or
  authority-only revision R+1; B attempts a full commit based on R without the
  outer lock. B must fail before snapshot, proof, frontier or receipt mutation.
  Also test the same schedule with unchanged document heads.
- Cache: pause a cold/tail `loadDocument(A)` after it has materialized a checked
  result, before its continuation consumes the cache. Replace/forget A, including
  eviction by reads of nine workspaces. Resume A; it must own a consistent document
  or return a typed retry result, never dereference a missing/freed cache entry.
- Framing: feed a header without a delimiter, oversized declared frame and a
  16 MiB-plus owner offer through browser and native ingress. Observe bounded
  allocation/cancellation and equivalent decisions, including a healthy second peer.

These are acceptance schedules, not claims that they were executed. In particular,
the cache interleaving has not been linked to the earlier `automerge_materialize`
out-of-bounds error; that cause remains unknown.

## Counterchecks: chat and existing guards

[Chat service](../../../src/chat/service.ts) publishes saved messages after awaited
storage; [store transactions](../../../src/chat/storeTransactions.ts) update message
and content revision together. [Retention policy](../../../src/chat/storePolicy.ts)
already caps messages at 2,000 / 4 MiB, profiles at 512 and records at 32 KiB.
Therefore “export contains every message” alone is not evidence of unbounded chat.
`workspaceSetLive` stages known-chat sets and adopts them after a successful send;
send completion is not a general claim of remote durable acknowledgment. Dedicated
confirmed-delivery paths verify their receipt. No new independent chat-loss defect
was established in this bounded inspection.

Typed delta/frontier comparisons, exact pending-outbox retries, existing signed
receipt checks and lower proof/control frame limits are useful existing boundaries.
The proposal must extend their coverage, not replace them with trust in a lock,
sender-provided length, UI status, or a generic “verified” boolean.
