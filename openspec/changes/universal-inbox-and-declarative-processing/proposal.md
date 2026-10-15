## Why

Tincanban needs one reviewable inbox for incoming work events, with clear separation between source evidence, classification and authorized board changes. Email-specific matching rules otherwise risk becoming a second automation path with weaker identity and retry guarantees.

## What Changes

- Specify a universal inbox of durable, source-bound events with explicit pending, review, applied, failed and revoked outcomes.
- Specify declarative, versioned processing rules that bind a source, bounded evidence projection, stable workspace targets, permitted actions and owner approval.
- Fold forwarded-email ingestion and application binding into the inbox contract. Match only immutable original source references and verified thread/job references; mutable card labels cannot establish identity.
- Require ambiguous events to remain reviewable until an owner explicitly binds them. Binding is durable, exact to the event and candidate, and does not itself apply an action.
- Preserve event identity, source evidence and action intent across retries. Duplicate delivery cannot create duplicate effects; uncertain writes retry the same prepared action.
- Keep Clef as a bounded classifier. It cannot select authority, broaden the projection, choose a new target or authorize a board mutation.

This change specifies behavior only. Inbox runtime, new email UI and deployment are outside this release.

## Capabilities

### New Capabilities

- `universal-inbox`: Durable source events, review and explicit application binding.
- `declarative-processing`: Owner-approved bounded rules, constrained decisions, causal action admission and retry semantics.

### Modified Capabilities

- `lead-and-email-ingestion`: Folded into `universal-inbox`; email is one event source and follows the same binding, review and idempotency rules.

## Impact

Specification scope covers the Tincanban application and automation Worker contracts. It does not claim runtime or UI implementation in this release.
