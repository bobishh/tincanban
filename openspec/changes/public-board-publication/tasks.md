## 1. Acceptance and projection

- [x] 1.1 Author isolated real-route owner publish → anonymous read/reload → update → unpublish acceptance tests, with phone and desktop plus failure/pending states; record actual test ordering and deviations in implementation.md.
- [x] 1.2 Add unit tests for selected-board allowlisting, nested ordering, archived/cross-board/private sentinel exclusion, scoped discussion/reply/quote sanitation, file manifest privacy and malformed/oversized input; confirm focused regressions fail before their fixes.
- [x] 1.3 Implement the strictly validated board/discussion/document projection and content hashing without loading/serializing the full workspace into public payloads.
- [x] 1.4 Author red tests for attachment retrieval/hash validation and missing-source failure; implement a complete public asset plan using existing authorized readers.

## 2. Keeper publication protocol

- [x] 2.1 Add native tests for signed publication commands, trust/device/origin/hash/revision/challenge enforcement, withdrawal and durable restart behavior; confirm focused security regressions fail before their fixes and document ordering.
- [x] 2.2 Implement separate authenticated publication challenges/mutations, strict DTO bounds, atomic snapshot/tombstone persistence, exact receipts and anonymous revalidated reads in sibling mesh-lighthouse; preserve existing user changes.
- [x] 2.3 Author red tests and implement authenticated idempotent asset staging, manifest activation only after complete verified files, current-revision anonymous downloads, failure/restart/withdrawal enforcement and safe orphan cleanup.
- [x] 2.4 Verify the existing blind-storage suite still passes, unknown files remain rejected and anonymous readers cannot retrieve private encrypted objects.

## 3. Client publication controls

- [x] 3.1 Implement capability/configuration discovery and signed publish/update/unpublish client operations using existing authorized identity and receipt verification.
- [x] 3.2 Add owner-only publication controls with exact card/discussion/attachment disclosure, confirmed public link/revision, explicit Update and pending/failure feedback; no optimistic successful state.

## 4. Anonymous reader and analytics

- [x] 4.1 Branch startup before private application imports and implement `/boards/<board-id>` with a standalone responsive read-only renderer, search/card inspection, read-only discussion threads and attachment downloads, plus missing/unpublished/malformed/unavailable handling.
- [x] 4.2 Implement optional one-event-per-navigation public-view telemetry with empty private identities, existing opt-out/configuration and nonblocking delivery; cover disabled/unavailable intake.
- [x] 4.3 Verify public viewing creates no identity/workspace/Visitor grant/mesh session and loads no Automerge or transport/policy WASM.

## 5. Verification and handoff

- [x] 5.1 Execute browser acceptance scenarios after implementation, including actual local Keeper restart, exact binary attachment download, staged-file invisibility, missing-file/update failure and unpublish after a successful snapshot/file read.
- [x] 5.2 Run relevant unit/native tests and required quality/build/bundle checks; fix regressions without raising existing budgets or rewriting unrelated code.
- [x] 5.3 Update README/API/deployment configuration and test inventory; record concrete test results and any infrastructure rollout limitations in implementation.md.
- [x] 5.4 Validate this OpenSpec change strictly and report implemented behavior. Production infrastructure deployment, domain purchase and publishing the user's board remain separate explicit actions.
