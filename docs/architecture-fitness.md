# Architecture fitness checks

These checks prevent regressions found during the 2026-10-12 startup/sync audit.
They run in the existing unit, browser and formal CI jobs. Operation counts protect
architectural behavior; no arbitrary elapsed-time quota is introduced.

| Contract | Production regression | Formal model |
| --- | --- | --- |
| Reload of an unchanged atomically admitted snapshot performs no full history admission and no workspace commit. | `src/state.test.ts`; real reload with unavailable history worker in `e2e/startup-preview.spec.ts`. | `SavedAdmission`: exact local raw/proofs/authority/heads/decisions/policy binding. |
| Changed history, decisions, missing checkpoint or policy invalidates reuse. Incoming metadata grants no trust. | `src/state.test.ts`, `src/sync/workspaceAdmissionCheckpoint.test.ts`; network admission uses its own verifier. | `SavedAdmission`, including forged remote marker and omitted authority mutants. |
| Reclassification rechecks authority after asynchronous admission before committing. | Existing authorization context/race tests in `src/sync/changeAuthorization.test.ts`. | `SavedAdmissionIgnoresRace` must violate current-context safety. |
| Identical snapshot/evidence/proofs replay writes no journal or catalog. | `src/storage.test.ts`. New command receipts still require atomic persistence. | Existing `WorkspaceCommit`; exact duplicate storage cost is an implementation assertion. |
| Renewing a local admission checkpoint does not publish a shared change. | `src/state.test.ts`: actual reclassify entry point, persisted repaired checkpoint, zero subscribed notifications; a real edit notifies. | `SavedAdmissionPublishesMarker` must fail. |
| Eviction disconnects and rejects new work without awaiting its own receive queue or draining under a mutation lock. Cleanup is supervised separately. | `src/sync/workspaceSet.test.ts`: current-peer control callback and actual concurrent mutation-lock owner. | `ScopeShutdown`: self-drain and lock-drain variants must fail eventual cleanup. |
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
scoped durable replication, typing without durable merges, unchanged Rusty polling
without full export, incremental command admission, keys-only catalog reads,
revision-based automation projections and indexed proof/history lookups. These are
identified work, not enforced or completed contracts. No passing model is evidence
that every production finding has been fixed.

Rusty's current blind-storage models and implementation mapping live in the
[sibling repository](../../mesh-lighthouse/formal/tla/README.md). Its CI checks
pinned TLC with exact required counterexamples, alongside native fault-injection,
retry, checkpoint, concurrent-write and restart tests.
