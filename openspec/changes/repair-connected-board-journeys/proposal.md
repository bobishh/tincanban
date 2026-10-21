## Why

Reported failures cross several boundaries that the current UI conflates: peer presence, durable board storage, identity-device credential recovery, and optional public publication. TinSink confirms real channel failures and frozen replication; source/history shows removed service journeys and private-board publication checks performed before visibility is known. The user needs usable offline-owner board exchange and actionable recovery, with evidence from deployed behavior.

## What Changes

- Preserve saved boards, encrypted objects, keys, exact pending uploads, and durable recovery intent while restoring the appropriate existing operation.
- Make owner-configured Rusty available to editors and visitors across identities; only the owner configures board storage. Remove deployment-wide owner/controller pins while preserving scoped ownership and signed authorization.
- Diagnose and repair same-computer multi-workspace/session channel churn from a reproducible trace; keep truthful status while fixing the transport cause.
- Separate public visibility discovery from editor publication authority. Private boards have no publication error/action; public boards retain verified delivery and targeted recovery.
- Export bounded connection failure/lifecycle diagnostics under existing device consent and collector configuration, independently of verbose packet logging.
- Give board discovery compact actions and window-relative layout; give desktop Sync a participant/detail layout with explicit board storage state.
- Establish the actual deployed public form contract, repair the reported request failure, and restore useful service/board status inspection.
- Delete obsolete Actions artifacts and automate retention; prepare/verify Rusty images before writer handoff and avoid another registry pull after stopping it.

## Capabilities

### New Capabilities

- `connected-board-availability`: participant-wide storage, exact recovery, truthful private/public states and observable channel behavior.

### Modified Capabilities

- `board-discovery`: usable independently resized directory windows.
- `configurable-telemetry`: automatic, bounded connection incident evidence without verbose packet export.

## Impact

Tincanban Vue windows, publication delivery, private replication and diagnostics; MetaMesh transport/runtime where a reproduced shared cause belongs; Rusty scoped authorization and activation; Reflux/website intake as established by real request evidence; GitHub workflow retention. Existing service keys, ciphertext and policy formats remain intact for the initial fixes. Larger storage architecture changes, including full blue/green concurrency, require their own evaluated design. Tickets stay Doing until the user personally checks deployed browser behavior.
