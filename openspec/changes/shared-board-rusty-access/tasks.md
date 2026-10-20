## 1. Explore
- [x] 1.1 Trace source/history and distinguish private identity privacy from missing board access.
- [x] 1.2 Specify role-scoped delivery, signature/replay checks and honest revocation limits.

## 2. Apply
- [x] 2.1 Add failing acceptance/integration scenarios for cross-identity exchange, replay and read-only delivery.
- [x] 2.2 Implement owner attestations and bounded, guarded board access exchange.
- [x] 2.3 Wire durable mesh sessions and local replication lifecycle without sharing private identity state.
- [x] 2.4 Implement read-only behavior and shared storage presentation/management separation.
- [x] 2.5 Verify focused integration and isolated browser acceptance; run types and affected checks.
- [x] 2.6 Update documentation and ticket with evidence and remaining release limits.

## Release verification

- [ ] CI verifies the pinned SDK and frontend commit.
- [ ] Frontend deployment confirms the served build and sealed artifact.
- [ ] User verifies owner-offline participant delivery in the live browser before Done.

Focused evidence, 2026-10-20: 27 transport tests, 26 participant/enrollment/window tests, types, and owner-offline browser acceptance passed. Browser acceptance cold-starts distinct editor and visitor identities with relay WebSockets blocked, confirms an editor write reaches the visitor through Rusty, rejects visitor uploads, and displays unavailable storage truthfully. A prior local join attempt timed out; retain that failure as a routing reliability observation. Deployment remains pending CI.
