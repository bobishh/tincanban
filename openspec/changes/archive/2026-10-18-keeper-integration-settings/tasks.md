## 1. Rusty update protocol
- [x] Add signed exact settings-update request validation, ownership checks, idempotency, and revision CAS.
- [x] Add pairing-bound expansion metadata and merge new owner-signed scopes into the same integration.
- [x] Preserve unrelated scopes and future policy during exact scope cleanup; baseline removed scopes when follow-owner remains enabled.
- [x] Reject stale automatic future offers after policy revisions and require grants newer than tombstones.
- [x] Add Rusty unit/HTTP tests for normal updates, replay, stale revision, cleanup retry, wrong owner, epoch floor, and service-signed receipts.

## 2. Tincanban settings flow
- [x] Add settings view and service-signed status/update parsing.
- [x] Reuse pairing comparison and provision flow for access expansion; show durable pending/failure/retry states.
- [x] Apply local owner-keeper and personal-root reference changes only after verifying service completion.
- [x] Add route-level Playwright happy path, pending approval, and stale/service-failure flows.

## 3. Formal model and validation
- [x] Add normal TLA+ lifecycle configuration and mutants for stale CAS, missing dual approval, and removed-board auto-readd.
- [x] Run OpenSpec validation, focused Rusty tests, Tincanban type/unit checks, Playwright BDD, and TLA+ expected-result suite.

## 4. Orphaned withdrawal recovery
- [x] Preserve a missing-pairing state separately from signed cancellation and resolve only from exact verified Rusty status plus owner-signed local revocation evidence.
- [x] Add Playwright happy, ambiguous-tombstone, and same-integration revision-CAS rebind scenarios; retain unresolved cleanup proofs internally without a user-facing history list.
- [x] Verify saved grant signatures and owner certificate chains; reject stale or missing grant epochs and rely on exact-epoch local revocation fences.
- [x] Add finite TLA+ normal no-grant/grant models and mutants for skipped local revocation, stale tombstone epoch, and erased history.
