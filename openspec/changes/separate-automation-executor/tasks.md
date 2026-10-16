# Work blocks

No local test/build runs. Author acceptance checks before changing behavior;
execute component CI after implementation. Production automation is final proof.

- [x] Specify separate executor, shared code boundaries and scoped items API.
- [x] Map existing participant dependencies and define portable storage/runtime ports.
- [x] Author command, denial, retry and migration acceptance scenarios/tests.
- [x] Host the same participant/domain code in a separate durable executor process (source).
- [x] Implement authenticated items command submission/results and bounded execution (source).
- [ ] Replace Cloudflare CRDT execution with bounded intake/classification/forwarding.
- [x] Preserve existing management APIs and interrupted writer-transition recovery (source).
- [x] Implement encrypted state transfer, import acknowledgement and durable old-writer fence (source).
- [x] Exclude old letters, event queues, bindings and nonce ledgers from the cutover contract.
- [x] Add component-owned immutable CI/deployment and infra configuration.
- [x] Release the standalone executor through its CI; verify the active checked image and health.
- [ ] Release narrowed participant transfer and intake bridge; verify integration cutover checkpoints.
- [ ] Confirm real production automation with admitted change, durable receipt and board result.
- [ ] Remove retired Cloudflare keys/CRDT paths after verified migration; document recovery.
- [ ] Recover local Rusty policy independently; move automation confirmation after ordinary replication.
- [ ] Ship compact detail/chat prose without changing handwritten board cards.
- [ ] Verify TinSink browser-origin Logs/Traces delivery independently of automation.

## Current implementation boundary

Source blocks now include the portable coordinator, Node participant process,
scoped command API, exact-write receipt journal, paged encrypted migration and
Cloudflare intake outbox. Tests are authored, not executed locally. The separate
executor DNS record and isolated CI environment exist; infra configuration is
pinned to `2ba230f771523b967977c74cdc582ba293a43c1f`.
Executor CI `38942711938` deployed source `aabc3a8e293e53ae0fb01bd27b6c11accf3e7092`;
live `/health` and immutable registry/config evidence matched its checked artifact.
Intake CI `38945619930` independently deployed `65a7bdac997c0db17fcbfda575f1857424092682`.
Import `38946006101` transferred eight tables/four pages: zero imported events and
no pending signed upload. Node activation `38946109742` succeeded; intake
acknowledgement failed on workerd's unsupported `redirect: "error"` mode. Its
compatible redirect fix is authored; acknowledgement and real-event acceptance
remain pending. A clearly marked new synthetic form submission is durably queued
in intake for the real production check. Old letters, event queues, bindings and
nonce ledgers are excluded rather than reconciled. Configured production routes
do not use the compiled legacy adapter after cutover; legacy acceptance fixtures
still import that adapter. Retired readable rows are deleted by acknowledgement.
