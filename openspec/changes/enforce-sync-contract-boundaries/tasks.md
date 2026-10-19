## 1. Proposal evidence

- [x] Inspect the three reported boundaries against current source and existing specifications.
- [x] Inspect adjacent cache ownership, chat durability/retention and actual browser/native limits.
- [x] Record facts, unexecuted reproductions and unknown production causes separately.
- [x] Write proposal, design and Given/When/Then acceptance requirements.
- [x] Validate this OpenSpec change and local document links.

## 2. Workspace persistence and handle ownership

- [x] Author external regressions for two storage instances: stale full snapshot after delta, authority-only revision, concurrent initialization and aborted commit.
- [x] Author deterministic cache interleavings for eviction, same-workspace replacement, returned heads and exactly-once handle release.
- [x] Add storage-owned live transaction contexts and atomic durable-basis comparisons; keep existing delta CAS and fast paths.
- [x] Route commands, incoming admission, causal review, initialization, snapshot/compaction and received-history activation through the controlled boundary.
- [x] Remove unrestricted/unused commit and rekey escape hatches; update fixtures to use the real boundary.
- [x] Return owned document/frontier results; remove post-await mutable-cache pairing.
- [ ] Prove conflicts/abort publish no saved state, cursor, ACK or notification and retain original evidence/outbox.

## 3. Core and transport input budgets

- [x] Inventory every pairing frame, stream read and logical bulk payload; record exact numeric caps and units in one public profile.
- [x] Author shared exact-boundary/header/oversize vectors and actual WASM/native ingress checks.
- [x] Enforce budgets before transport buffering, core parsing/copy and unchecked FFI copies; remove unlimited read defaults.
- [x] Resolve 24 MiB logical owner/control allowances versus 16 MiB wire caps through bounded transfer and explicit capability failure.
- [x] Bind cancellation to underlying streams; bound concurrent frames and aggregate reassembly.
- [ ] Verify healthy-peer progress after another peer times out or exceeds its budget; preserve existing proof/authorization checks.

## 4. Independent replica contract

- [x] Define a module/export ownership map; isolate product admission/model entry points from browser orchestration.
- [x] Author an independent consumer that compiles without Tincanban source and runs real receipt/crypto/history/retry vectors.
- [x] Extract common Rusty HTTP/envelope/receipt/history contracts into existing MetaMesh packages without changing signed bytes or AAD.
- [x] Switch browser and automation adapters to public exports; enforce forbidden reverse imports in CI.
- [ ] Run both actual host adapters against shared exact-pending, revocation, wrong-receipt, crash/restart and failed-CAS scenarios.

## 5. Verification and rollout

- [ ] Complete the single full local runtime/logic/browser/native run authorized by the user, collect failures across independent groups, then run focused checks for fixes and final CI.
- [x] Publish matching SDK native/WASM artifacts and update the consumer pin only after SDK CI passes.
- [ ] Complete Tincanban CI, including existing sync/chat and performance scenarios without weakened thresholds.
- [ ] Deploy affected components through their existing independent CI pipelines; verify actual build identities.
- [ ] Verify a real board sync and chat retry after rollout, including repeated ordinary polls and a relevant failure/recovery state.
- [ ] Record evidence and update architecture documentation only for contracts actually implemented; do not mark unknown WASM failures resolved without evidence.
