# Work blocks

No local test/build runs. Author acceptance checks before changing behavior;
execute component CI after implementation. Production automation is final proof.

- [x] Specify separate executor, shared code boundaries and scoped items API.
- [x] Map existing participant dependencies and define portable storage/runtime ports.
- [x] Author command, denial, retry and migration acceptance scenarios/tests.
- [x] Host the same participant/domain code in a separate durable executor process (source).
- [x] Implement authenticated items command submission/results and bounded execution (source).
- [x] Replace Cloudflare CRDT execution with bounded intake/classification/forwarding.
- [x] Preserve existing management APIs and interrupted writer-transition recovery (source).
- [x] Implement encrypted state transfer, import acknowledgement and durable old-writer fence (source).
- [x] Exclude old letters, event queues, bindings and nonce ledgers from the cutover contract.
- [x] Add component-owned immutable CI/deployment and infra configuration.
- [x] Release the standalone executor through its CI; verify the active checked image and health.
- [x] Release narrowed participant transfer and intake bridge; verify integration cutover checkpoints.
- [ ] Confirm real production automation with admitted change, durable receipt and board result.
- [x] Remove retired Cloudflare participant keys and disable its execution path after verified migration; document recovery.
- [x] Recover local Rusty policy independently; move automation confirmation after ordinary replication.
- [ ] Release the corrected reading scale and quiet detail sections/Quick note without changing handwritten board cards.
- [x] Verify TinSink browser-origin Logs/Traces delivery independently of automation.
- [ ] Include admitted automation approvals in the owner's signed public-delivery policy and verify production delivery.
- [ ] Prevent status polling from starving due commands; retain validated runtime instances across their own durable progress writes.

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
no pending signed upload. Node activation `38946109742` succeeded; its first intake
acknowledgement failed on workerd's unsupported `redirect: "error"` mode.
Verify `38950907446` and independent frontend/Worker deployments passed for
`78f51a1`; retry `38952676874` completed acknowledgement at the same epoch 1.
New form intake reached Node and its first synthetic non-vacancy example was
retained for review. Positive write/receipt acceptance is still pending.
Production investigation also found an empty public writer-grant policy and
status polling repeatedly rebuilding history. The source batch now includes admitted
automation grants in the owner policy, shares one validated participant between
execution and guarded management, preserves it across its own durable writes,
and reserves a bounded scheduler slot for due work under polling load. Intake-only
alarms initialize and flush OTel so forwarding failures retain their original
exception. These changes, the semantic reading scale, and quiet detail sections
await their component CI and production evidence. Old letters, event queues, bindings and
nonce ledgers are excluded rather than reconciled. Configured production routes
do not use the compiled legacy adapter after cutover; legacy acceptance fixtures
still import that adapter. Retired readable rows are deleted by acknowledgement.
