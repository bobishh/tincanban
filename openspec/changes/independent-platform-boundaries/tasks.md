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

- [ ] Production automation follow-up requested by user: inspect Worker errors, queue state and task execution after release; distinguish intake, authorization, Rusty sync and executor failures from live evidence.

Production checkpoint, 2026-10-16 15:17 UTC: Rusty `/health` confirms
`80af4859afafbb829fba78192ebc5ffc6b4977ca`; TinSink's own
[CI/deployment](https://github.com/bobishh/tinsink/actions/runs/38921366329)
activated `ef0286190e53b14aab7068ceb521801aa4f4d662`. Direct ClickHouse reads
confirm that standard native logs and spans reached `otel.otel_logs` and
`otel.otel_traces`. Frontend and automation remain pending at this checkpoint.
The existing automation Worker reports `Module terminated` during control sync;
Automerge's generated guard emits this after an earlier exception terminated its
WASM instance. The initiating exception is not established by that message.
The next Worker artifact captures restore/sync phases and flushes alarm diagnostics
outside the business operation. Recent retained email status also shows a separate
review outcome for missing original posting evidence; it is not an applied action.

Production investigation, 2026-10-16 17:53 CEST: the live browser debugger
captured `POST /v2/automation-instances/discover` returning HTTP 422 with
`{"error":"Module terminated"}`. Its caller chain enters Worker discovery from
`ensureWorkspaceReplicaWriter` before constructing the ordinary board replica.
The same tab successfully synchronizes the identity profile through Rusty.
Thus the board's `Unavailable` label is not evidence of a Rusty outage: an optional
initial writer-policy migration currently propagates an automation error into
board replication health. Separate ordinary replication under existing accepted
policy from that maintenance pass; retain the strict resume barrier whenever a
durable writer-transition intent exists. Source changes and focused regressions
are pending CI; no production recovery is claimed. Historical Worker logs show
repeated termination and separate HTTP 502 JSON failures, without establishing
the initiating WASM exception.
The pending Worker artifact also records management failures inside the Durable
Object before the RPC boundary and flushes that operation's diagnostic records.

- [ ] Release and verify independent ordinary board sync while automation discovery
  fails, plus preserved barriers for already-started writer-policy transitions.
