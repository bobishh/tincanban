## Why

Owners can inspect a Rusty keeper integration but cannot change its board scopes or future-board policy. Re-pairing does not update an existing integration, while removing the keeper tears down every scope.

## What Changes

- Add an owner-visible settings view for one existing keeper integration, with exact active board scopes and the future-board policy.
- Let owners remove one board or turn future access off through an owner-signed, revision-fenced update; retain every unrelated active board.
- Require authenticated owner authorization and Rusty admission before adding a board or enabling future-board access. On configured owner-origin admission, one explicit owner decision can satisfy both cryptographic authorities; legacy services retain the separate operator approval flow.
- Capture all currently owned boards in the future-policy baseline. Only boards created after approval qualify for automatic offers; previously unselected boards require explicit addition.
- Persist update intent and signed completion so retries are idempotent and reload can recover pending approval.
- Keep current scopes active while expansion waits for approval. Reject stale revisions and grant epochs that do not advance tombstones.

## Capabilities

### Modified Capabilities
- `keeper-integrations`: Add revision-fenced scope and future-policy updates with durable approval, exact cleanup, and recovery semantics.

## Impact

Keeper settings UI and application API, owner-local integration references, Lighthouse pairing and integration lifecycle endpoints, Rusty registry persistence, OpenSpec behavior, Playwright route flows, and finite TLA+ safety models. No identity replacement, workspace-owner repair, service rebind, or deletion of workspace content is included.
