# Tincanban redundant work audit

2026-10-12. Baseline: `b7bf997`. Scope: startup, state, storage, local commands,
history, mesh and queues, Rusty, chat, components and templates, publication and
imports, frontend and automation Workers, and vendored browser/Rust admission
integration. Findings distinguish measured behavior from source-derived costs.

Unchanged reload previously replayed complete admission and committed its result.
This change reuses a locally committed checkpoint bound to raw bytes, normalized
proof/authority inputs, projection heads, decisions and the frontend build. Missing
or changed bindings still require admission. An identical snapshot/evidence replay
also avoids journal and catalog writes. Follow-up changes separate local checkpoint renewal from shared-change notifications
and disconnect sessions without waiting on their own queued callback. Real control
receive and mutation-lock regression tests cover both audited close cycles.
Incremental admission for new edits remains unimplemented.

## Production evidence

TinSink events on 2026-10-12 show Chrome completing `reclassify-admit-history` in
3282.3 ms at 20:14:30.940 UTC, followed by `reclassify-commit` with no completion.
The preceding reload records `startup.previous.interrupted` at that same commit
stage. Another pass at 20:29:40.431 UTC took 10331.9 ms and again reached commit.
The user Chrome tab displayed build `b7bf997`, saved cards and view-only
`Checking saved changes` during inspection. This is an unresolved production hang,
not proof that the queue cycles below caused it.

Between 20:10 and 20:31 UTC, the queried window contained 193 events in each of
`dial.failed`, `route.failed` and `dial.device.failed`. One attempt is reported at
three abstraction layers; these are not 579 independent dial attempts. Codes are
`unknown_error`. Two `transport.response-read` phases lasted 559567 and 542863 ms.
Their durations show prolonged waiting, not equivalent CPU work.

TinSink drops unknown attributes: the producer sends `stage` and admission phase
timings, but the collector allowlist does not retain them. Reclassification and
commit diagnostics now use the supported `phase` attribute. Detailed admission
CPU timings remain in the bounded local trace; extending the collector contract
is separate from enabling additional event volume.

## Findings

| Priority | Trigger and source | Evidence and effect | Fix and acceptance check |
| --- | --- | --- | --- |
| P1 | Current-peer revocation during scope receive. [durableMeshAuthority](../src/sync/durableMeshAuthority.ts), [workspaceSet](../src/sync/workspaceSet.ts), [browserScopeSync](../vendor/meta-mesh/packages/mesh-runtime/src/browserScopeSync.ts). | `mergeMesh` awaits eviction, eviction awaits scope close, close awaits the queue containing `mergeMesh`. An isolated run of the actual scope class reached the host callback but never closed/freed the runtime. Today's production cause is not established. | Disconnect and reject new work immediately; drain outside the current queued callback. A current-peer revoke must finish receive and free the runtime. |
| P1 | `revokePerson` holds the workspace mutation lock while waiting for eviction. [durableMeshAuthority](../src/sync/durableMeshAuthority.ts). | Source-derived lock cycle: receive waits mutation lock; lock owner waits close; close waits receive. No separate runtime reproduction of this variant yet. | Wait for session drain after releasing the mutation lock. Test concurrent receive and revoke. |
| P1 | Each new local command. [statePersistence](../src/statePersistence.ts), [changeAuthorization](../src/sync/changeAuthorization.ts). | New heads invalidate exact-input reuse, so the entire raw history, proof verification and transitions are replayed for one edit. Reload reuse does not remove this cost. | Incremental admission over an admitted base and new causal delta; changed rights/proofs must reconsider affected history. Test a long base plus one edit and late revocation. |
| P1 | Empty Rusty poll every 15 seconds. [useBlindReplication](../src/sync/useBlindReplication.ts), [blindReplication](../src/sync/blindReplication.ts), [blindReplicaStore](../src/sync/blindReplicaStore.ts). | Three isolated unchanged syncs: document reads 3, authorization exports 3, chat exports 3, inventories 3, uploads 1. Unchanged detection occurs after full serialization and hashing. At this interval there are 240 computations per hour per config/tab. | Compare a cheap coherent document/proof/authority/chat revision before export. Preserve inventory pulls. Test store reads, not only upload count. |
| P2 | Typing or one-board events. [useBlindReplication](../src/sync/useBlindReplication.ts), [chat service](../src/chat/service.ts). | Subscriptions ignore workspace IDs and chat event kind. Typing triggers all configs although Rusty strips typing from exported payloads. | Ignore typing-only events and sync only affected configs. Durable messages/edits still trigger their board. |
| P2 | Duplicate signed remote snapshot. [stateSyncActions](../src/stateSyncActions.ts), [storage](../src/storage.ts). | Original `|| causalEvidence` forced snapshot writes for unchanged evidence; catalog updated too. Fixed in this change: unchanged heads, proofs and normalized evidence with no command skip both writes. | Regression checks zero journal/catalog writes; changed evidence, proof and command receipts retain atomic persistence. |
| P2 | Catalog refresh. [localDb](../src/localDb.ts), [storageCatalog](../src/storageCatalog.ts), [BrowserMeshStore](../vendor/meta-mesh/packages/mesh-browser-store/src/index.ts). | `listLocalKeys` lists and clones every KV value, then discards values. Large unrelated private entries increase catalog cost. | Keys-only API backed by `getAllKeys` or key cursor. Verify a large unrelated value is not read. |
| P2 | Startup migrations. [stateStartupMigration](../src/stateStartupMigration.ts). | Available and archived lists scan the same catalog separately; every document, including archived boards, is decoded before active startup finishes. Roles are already checked only when migration is needed. | One catalog read; durable schema revision to skip current inactive documents. Keep mandatory active-board migration before writes. |
| P2 | Typing-only incoming chat. [chat service](../src/chat/service.ts), [storeTransactions](../src/chat/storeTransactions.ts). | Empty durable batches still open merge, read all messages/profiles/meta, sort and apply retention. Limits permit 2000 messages or 4 MiB per scope. | Validate typing and update ephemeral state without durable merge when messages/profiles are empty. Test indicator plus zero durable merge. |
| P2 | Chat export and startup. [chat service](../src/chat/service.ts), [useWorkspaceChat](../src/chat/useWorkspaceChat.ts). | Profile assurance loads all chat, then export loads it again. Startup refreshes before and after assurance even when unchanged. | Profile-only lookup; return whether assurance changed durable data. Existing profile/rename/create paths must remain correct. |
| P2 | Mounted stable automation settings. [useAutomations](../src/app/useAutomations.ts), [coordinator](../workers/automation/src/coordinator.ts). | Poll every 3 seconds implies up to 1200 observation requests/hour/instance. Worker loads/decrypts replica state and derives observation/control separately. | Fast polling while commands are pending; reduce stable polling and pause hidden UI. Preserve freshness and acceleration after desired-state changes. |
| P2 | Worker intake or observation. [replica](../workers/automation/src/replica.ts), [coordinator](../workers/automation/src/coordinator.ts). | Profile, priority bands, candidates, control, source permission and observation repeatedly decode/load the same admitted document. Existing admission cache does not remove materialization. | One projection per exact replica revision; invalidate after pull/write/grant change. Test load count and changed-control freshness. |
| P3 | Large authorization sets. [workspaceAdmissionCore](../src/sync/workspaceAdmissionCore.ts). | Each verified record uses `.find` over all inputs. O(P²); 20000 distinct matching records can require roughly 200 million signature comparisons. Complexity estimate, not production timing. | Signature-to-variants index; retain exact signed/certificate/grant equality before copying owner metadata. Test equal signatures with different grants. |
| P3 | Opening card history or any document version update. [history](../src/domain/history.ts), [useAppBoard](../src/app/useAppBoard.ts). | Whole-board change metadata and transaction JSON are scanned again for a selected card. | Cache an index for an immutable owning document/revision. Verify changed documents invalidate it. |

## Verification and boundaries

Focused unit checks cover unchanged startup, changed raw history, missing or stale
policy checkpoints, changed decisions, rights/proof fingerprints, atomic causal
storage and unchanged replay. Real Chromium and WebKit startup scenarios cover
ready editing without any admission worker job, pending/failed history, and saved
preview visibility. Chromium storage scenarios cover concurrent tabs and atomic
failure. The late-revocation scenario retains retraction and authorized review;
its storage-failure case now uses an older-policy checkpoint that requires a write.

Admission checkpoints remain local journal metadata. Authorization bundles,
workspace bundles, Rusty snapshots and mesh frames build explicit payloads without
them. Incoming packets still enter admission. The saved checkpoint is not an
authorization certificate for incoming data.

Templates and Markdown already use bounded rendering caches and explicit saves;
no additional background replay was confirmed there. The frontend Worker has no
periodic application polling. Temporary Automerge handles without explicit free
remain a peak-memory candidate; FinalizationRegistry prevents concluding a
permanent leak from missing calls alone.
