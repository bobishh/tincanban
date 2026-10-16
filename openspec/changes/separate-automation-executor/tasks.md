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
- [ ] Reconcile legacy events against manual Tesla creation and Amazon movement.
- [x] Add component-owned immutable CI/deployment and infra configuration.
- [ ] Release through CI; verify actual active artifacts and migration checkpoints.
- [ ] Confirm real production automation with admitted change, durable receipt and board result.
- [ ] Remove retired Cloudflare keys/CRDT paths after verified migration; document recovery.

## Current implementation boundary

Source blocks now include the portable coordinator, Node participant process,
scoped command API, exact-write receipt journal, paged encrypted migration and
Cloudflare intake outbox. Tests are authored, not executed locally. The separate
executor DNS record and isolated CI environment exist; infra configuration is
pinned to `2ba230f771523b967977c74cdc582ba293a43c1f`. No executor deployment,
production migration or real-event acceptance is proven yet. The old Cloudflare
CRDT adapter remains only for the explicitly fenced transfer and must be removed
after the verified cutover, together with retired readable state.
