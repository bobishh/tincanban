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

## Current implementation boundary

Source blocks now include the portable coordinator, Node participant process,
scoped command API, exact-write receipt journal, paged encrypted migration and
Cloudflare intake outbox. Tests are authored, not executed locally. The separate
executor DNS record and isolated CI environment exist; infra configuration is
pinned to `2ba230f771523b967977c74cdc582ba293a43c1f`.
Executor CI `38940879267` deployed source `547ca3d43f78665e561e9b737380b063664a7191`;
live `/health` and immutable registry/config evidence matched its checked artifact.
Participant-only transfer is a later source change; its CI release, integration
cutover and real-event acceptance remain pending. The old Cloudflare CRDT adapter
remains only for the explicitly fenced approved-participant transfer and must be
removed after verified cutover, together with retired readable state. Old letters,
event queues, bindings and nonce ledgers are excluded rather than reconciled.
