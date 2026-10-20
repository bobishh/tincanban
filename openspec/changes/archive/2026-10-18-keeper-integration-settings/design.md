## Protocol

Treat settings as operations on one stable integration ID. Every request carries a unique operation ID, exact integration revision, and exact scope delta. The controller identity and service identity bind the signed request. Rusty validates owner scope authority, grant epochs, and current revision before recording an intent.

Integration revisions are scoped to integration IDs; aggregate service revision is diagnostic only and MUST NOT be used for an integration CAS. Resolve the canonical ID from the protocol's controller/service identity derivation. A terminal noncanonical legacy record may remain in signed status as history and grant-epoch floor, but cannot become the write target. Any noncanonical record with active scopes, future-board consent, pending operation, or incomplete tombstone cleanup makes automatic selection ambiguous and MUST block writes. Multiple canonical rows also fail closed.

An expansion is an existing pairing operation with an integration-update payload. The comparison code binds integration ID, expected revision, added workspace IDs, and requested future policy. Existing active scopes stay usable while operator and owner approvals are pending. Only after both approvals does the owner send the exact new workspace invitation. Rusty admits the owner-signed grants and commits the delta; it does not replace or rebind the integration.

A reduction or future-policy disable is owner-signed and can proceed without operator availability. A board removal carries its active grant epoch and creates a tombstone for exactly that scope. It retains unrelated active scopes and the existing future policy. If future access stays enabled, removed board IDs join the baseline so the future-offer path cannot immediately re-add them. Disabling future access retains all active scopes and blocks later automatic offers.

Enabling future access is an expansion and requires both approvals. Its baseline contains every currently owned board, including boards not selected for this integration. Automatic admission therefore applies only to boards created after approval. The update and automatic-offer paths share revision CAS; an offer prepared against an older revision cannot reactivate follow-owner after an owner disables it.

Rusty records operation hash, expected revision, exact added/removed IDs, requested policy, approval state, and completion receipt durably. Same operation ID and same payload returns the same result; reused IDs with another payload conflict. Stale revision conflicts without changing active scopes or policy. Cleanup failures remain pending and retryable. Status and completion receipts are service-signed; the client updates local settings only after verifying them.

## Safety

- No board outside the controller's owner-signed exact addition set is admitted.
- Active scopes remain unchanged until an expansion commits.
- A completed removal tombstone covers the removed grant epoch; later re-addition needs a strictly newer owner-signed grant.
- A removed board cannot be automatically re-added by an existing future policy.
- Turning future access off cannot be undone by a stale future-board offer.
- A revision conflict, invalid receipt, or unavailable service leaves local active scopes and policy unchanged and exposes retry/status.
- Owner boundary records and device identity remain unchanged by integration settings.

## Local state and recovery

The latest service-signed integration status and revision are authoritative for keeper lifecycle state. Personal-root integration references cache that verified state and local pending intent; the owner-keeper list is a locator/projection and legacy fallback, not authority. Workspace access remains grounded in owner-signed grants and ownership proofs; Rusty status or removal never revokes the owner's membership. Withdrawal outbox records retain exact cleanup proofs privately and never project as active keepers or user-facing cancellation history. Visible dialogs and selections are ephemeral and may be dismissed without deleting durable cleanup evidence.

Writes to the PersonalRoot map serialize read-current, mutate, and write under one shared storage-key lock, including enrollment's deliberate whole-root replacement. Owner-keeper cache updates use a separate per-owner lock. Every modern cache projection write requires the exact current integration ID and revision for the same owner root; same-integration writes also reject older revisions. Removal preserves a different or newer modern row. These keys are not an atomic transaction pair; signed service state and its revision fences remain the recovery source if a write fails between them. Keeper-grant revocation also stays generation-fenced: removing a grant cannot revoke a later owner-signed generation.

Rusty publishes policy revisions and operation outcomes only after configuration files and their containing directory are durably persisted. The client retains intent on ambiguous persistence or transport outcomes and resolves it from fresh signed status; it does not infer completion from a local cache write.
