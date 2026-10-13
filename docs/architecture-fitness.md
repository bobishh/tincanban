# Architecture fitness checks

These checks prevent regressions found during the 2026-10-12 startup/sync audit.
They run in the existing unit, browser and formal CI jobs. Operation counts protect
architectural behavior. The opt-in local-save workload also requires warm writes
below 250ms; it reports separate full-replay timings and is not a network deadline.

| Contract | Production regression | Formal model |
| --- | --- | --- |
| Reload of an unchanged atomically admitted snapshot performs no full history admission and no workspace commit. | `src/state.test.ts`; real reload with unavailable history worker in `e2e/startup-preview.spec.ts`. | `SavedAdmission`: exact local raw/proofs/authority/heads/decisions/policy binding. |
| Changed history, decisions, missing checkpoint or policy invalidates reuse. Incoming metadata grants no trust. | `src/state.test.ts`, `src/sync/workspaceAdmissionCheckpoint.test.ts`; network admission uses its own verifier. | `SavedAdmission`, including forged remote marker and omitted authority mutants. |
| Reclassification rechecks authority after asynchronous admission before committing. | Existing authorization context/race tests in `src/sync/changeAuthorization.test.ts`. | `SavedAdmissionIgnoresRace` must violate current-context safety. |
| Identical snapshot/evidence/proofs replay writes no journal or catalog. | `src/storage.test.ts`. New command receipts still require atomic persistence. | Existing `WorkspaceCommit`; exact duplicate storage cost is an implementation assertion. |
| Ordinary local commands write only a new delta, proof, receipt and frontier; aborted or competing writes cannot advance it. | `src/workspaceDeltaJournal.test.ts`, `src/state.test.ts`, `e2e/repeated-card-save.spec.ts`; opt-in `src/stateLocalSavePerformance.test.ts` checks growing histories. | Implementation tests cover IndexedDB integrity and atomicity; no model claims storage performance. |
| A warm tab verifies only new indexed deltas; damaged tails do not advance its cache, replacement bases require cold validation, and retries cannot associate stale content with a newer frontier. | `src/workspaceDeltaJournal.test.ts`; offline two-tab Archive/Applied flow in `e2e/incremental-tabs.spec.ts`; version 2/3 upgrade and preserved numeric order in `e2e/storage-upgrade-block.spec.ts`. | Indexed reads and cache publication are implementation assertions. |
| Repeated committed peer packets skip history loading and replay only under current authority, policy and durable revision; extension across local deltas requires every supplied hash and proof to be verified. | `src/state.test.ts`, `src/stateIncomingReuseEquality.test.ts`, `e2e/repeated-peer-packet.spec.ts`: duplicates, local edit preservation, altered signatures, unknown hashes becoming relevant, private input copies and cache maintenance failures. | Success-only packet reuse is an implementation assertion; peer markers never authorize it. |
| Changed evidence advances a workspace revision atomically; legacy transaction writes invalidate the frontier and idempotent retries keep their revision. | `src/workspaceDeltaJournal.test.ts`: atomic append/abort/retry and legacy IndexedDB write. | The small revision binds packet reuse to durable state. |
| Legacy journal replay excludes known pending/quarantined hashes from the admitted view; new legacy writes survive in raw recovery without inheriting old admission. | `src/storage.test.ts`, `src/workspaceDeltaJournal.test.ts`: memory and IndexedDB reopen; `e2e/startup-preview.spec.ts`: quarantined legacy rewrite remains hidden during pending/failed startup checks. | Recovery preserves raw changes separately from their authorized projection. |
| Full local admission covering retained journal hashes allows unchanged evidence reads without historical document decoding; unknown hashes still require raw assembly. | `src/storage.test.ts`: three reads with zero Automerge loads; `e2e/card-move-responsiveness.spec.ts`: 55 detailed cards at fourfold CPU throttling, 200ms main-thread gate. | Classified hashes are local checkpoint metadata; peer markers grant no trust. |
| Pairing transfers node ownership before awaiting durable mesh startup; closing its UI cannot close the adopted node, including Close during the earlier handshake request. Superseded cleanup cannot clear a newer direct session. | `src/sync/workspaceJoinBrowserFlow.test.ts`: controlled Close during request and resume; `e2e/workspace-sync-data.spec.ts`: authenticated attachment transfer after closing pairing, lifecycle attachments on failure. | Cleanup checks current node ownership and controller generation. |
| Unchanged Rusty polls skip document/proof export and historical hashing only after successful acknowledgement; document, proof, rights and chat changes invalidate reuse. | `src/sync/blindReplication.test.ts`, `src/sync/blindSnapshotRevision.test.ts`, `e2e/repeated-rusty-poll.spec.ts`: idle passes, card archive, chat update, unstable revision and failed delivery/acknowledgement. | Revision reuse never bypasses receipt or checkpoint verification. |
| Reclassification catches up a stale active view without publishing a new shared change; reconciliation publishes under the shared mutation boundary. | `src/state.test.ts`: verified later delta, no subscriber notification, controlled older read and queued writer. | Read/publication ordering is exercised in the application boundary. |
| Certificate ordering does not invalidate rights or access caches; signed payload order, distinct certificates and revocations remain consequential. | `src/sync/authorityFingerprint.test.ts`, `src/sync/changeAuthorization.test.ts`, `src/sync/workspaceAccess.test.ts`. | Canonical representation is an implementation invariant. |
| Successful snapshot/delta commits do not depend on a later legacy catalog write. | `src/storage.test.ts`, `src/sync/localWorkspaceAdmission.test.ts`: unavailable legacy writer, fresh storage reader and recovered catalog. | The atomic commit contains its catalog metadata. |
| Renewing a local admission checkpoint does not publish a shared change. | `src/state.test.ts`: actual reclassify entry point, persisted repaired checkpoint, zero subscribed notifications; a real edit notifies. | `SavedAdmissionPublishesMarker` must fail. |
| Eviction disconnects and rejects new work without awaiting its own receive queue or draining under a mutation lock. Cleanup is supervised separately. | `src/sync/workspaceSet.test.ts`: current-peer control callback and actual concurrent mutation-lock owner. | `ScopeShutdown`: self-drain and lock-drain variants must fail eventual cleanup. |
| A gossip timer queued before driver replacement cancels if the driver closes before execution; explicit API calls on closed drivers still reject. | Vendored `gossip.test.ts`: blocked send, timer tick, close, no timer effects or unhandled rejection. | `GossipTimerShutdown` checks silent cancellation; the old rejecting variant must fail. |
| Optional favicon decoration cannot throw on later role/presence changes after malformed fetch. | `e2e/favicon.spec.ts`: malformed HTTP-200 SVG, editable owner and no page errors. | No concurrency model needed; real DOM behavior checked. |

`SavedAdmission.Check` assumes successful cryptographic classification;
`Commit` assumes an atomic durable transaction. Signatures, document classification,
IndexedDB and browser workers are checked in implementation tests, not proved by
TLC. Six finite context dimensions each change once. `ScopeShutdown` assumes
storage callbacks can finish after the lock releases; it supplies no deadline or
availability guarantee for failed storage/network. Queue drain remains supervised
by the session `done` promise and a diagnostic rejection handler even when close
is requested by an in-flight callback.

The checkpoint currently binds the whole build revision. This safely invalidates
reuse on policy changes but also replays history after unrelated UI deployments.
Replacing it requires a generated fingerprint of the complete resolved admission
code/dependency/WASM closure. A manual version or worker-only hash would weaken the
security boundary and is not an accepted optimization.

Additional candidates remain in [the redundant-work audit](redundant-work-audit.md):
scoped durable replication, typing without durable merges, keys-only catalog reads,
revision-based automation projections and indexed proof/history lookups. These are
identified work, not enforced or completed contracts. No passing model is evidence
that every production finding has been fixed.

Rusty's current blind-storage models and implementation mapping live in the
[sibling repository](../../mesh-lighthouse/formal/tla/README.md). Its CI checks
pinned TLC with exact required counterexamples, alongside native fault-injection,
retry, checkpoint, concurrent-write and restart tests.
