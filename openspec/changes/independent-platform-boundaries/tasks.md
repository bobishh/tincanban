## 1. Contract
- [x] 1.1 Inspect deployment coupling; record local-first + CRDT, Rusty-only backend, independent release/rollback and optional observability before implementation.
- [x] 1.2 Author acceptance for product-only deploy/rollback, different compatible SDK builds, unavailable diagnostics and retained data/authority.

## 2. Implementation blocks
- [x] 2.1 Make tincanban deployment/recovery component-scoped; remove Rusty activation/host credentials, mandatory cohorts and cross-service SDK equality.
- [x] 2.2 Finish Rusty-owned immutable deployment/rollback and component-scoped workflows, with independent locks/records and existing-volume safety; no central repository.
- [x] 2.3 Preserve local CRDT and existing Rusty backend/public API; remove the withdrawn new-Worker-backend proposal and any resulting adapter edits.
- [x] 2.4 Keep TinSink/observability deployment independent and diagnostic configuration/export optional for every producer and product CI.
- [x] 2.5 Finish pending shared visitor UI, semantic typography and OTel source work; reconcile prior specs/docs against these boundaries.

## 3. Acceptance and release
- [ ] 3.1 Only after implementation blocks close, run required checks and focused browser/native/Worker public delivery, failure and rollback acceptance.
- [ ] 3.2 Stage all authorized work, commit/push main in affected repos; deploy each selected component through its owning repository CI, without mandatory paired deployment.
- [ ] 3.3 Verify actual deployed artifacts, retained private data and stored OTel rows. Keep manual phone verification separate.

Module terminated diagnosis follows expanded diagnostics and the first captured
primary exception; speculative WASM changes do not block these releases.

User release instruction, 2026-10-16: stop further local rechecks and ship through owning CI. Prior local proof remains recorded; final stale-file URL fix is left for CI/production verification. Do not report that unrun keeper rerun as passed.
