## ADDED Requirements

### Requirement: Inbox events preserve source identity and evidence
The inbox SHALL persist each accepted event under a namespaced source identifier and immutable source digest before acknowledging durable acceptance. It SHALL retain the original bounded source evidence needed for review and policy evaluation. Re-delivery of the same source event SHALL resolve to the existing event; equal content with a different source identifier SHALL remain distinct.

#### Scenario: Duplicate delivery
- **WHEN** the same source event is delivered again
- **THEN** the inbox returns its existing outcome without creating another event or board effect.

#### Scenario: Distinct identical content
- **WHEN** two source identifiers carry identical content
- **THEN** they remain separate events and are processed under normal policy.

### Requirement: Email is an inbox source
Forwarded email SHALL be routed by the configured private recipient integration and bounded envelope policy. Sender-provided board, workspace, card or integration identifiers SHALL NOT grant or expand access. The system SHALL retain the original message identity, bounded MIME evidence, thread/reference headers and original date when present.

#### Scenario: Injected destination
- **WHEN** a message body names an unapproved workspace or card
- **THEN** routing remains bound to the configured recipient integration.

#### Scenario: Invalid or oversized message
- **WHEN** MIME content or attachments exceed declared limits or fail validation
- **THEN** the event is rejected or held for review without a board mutation.

### Requirement: Application binding uses immutable source references
An email event SHALL bind automatically only when immutable original source references uniquely identify one eligible application. Valid references include verified thread/reference identifiers, exact original job URLs, and source-backed identifiers captured from the original message. Editable card titles, role/company labels, notes and mutable candidate fields SHALL NOT establish identity. Legacy applications without immutable references SHALL require explicit review and binding.

#### Scenario: Unique verified thread
- **GIVEN** a verified thread reference maps to one eligible application
- **WHEN** a later event arrives in that thread
- **THEN** processing may use that application as its target without creating a duplicate.

#### Scenario: Ambiguous company match
- **GIVEN** multiple eligible applications share a company and the event has no unique immutable reference
- **WHEN** the event is evaluated
- **THEN** it remains in review with candidate matches and no application changes.

#### Scenario: Mutable label resembles source
- **WHEN** an editable card label matches text in an event but original source references do not identify that card
- **THEN** the label does not authorize a match or action.

### Requirement: Owner binding is explicit and event-specific
An owner MAY bind a retained ambiguous event to one displayed eligible application. The binding SHALL record the event identity, immutable source digest, selected application identity, current authority and binding revision. Saving a binding SHALL NOT itself apply a board action. A retry SHALL use the retained event and binding, recheck current authorization and causal preconditions, and SHALL NOT reclassify or replace the original source evidence.

#### Scenario: Bind then retry
- **WHEN** an owner binds an event to one eligible application and requests retry
- **THEN** the system processes the retained event against that exact application under current policy.

#### Scenario: Stale binding
- **WHEN** the event, candidate, binding revision or current authority changed after review
- **THEN** retry remains unapplied and returns the event to review.

### Requirement: Declarative rules bound inputs and effects
Each processing rule SHALL be versioned and owner-approved. Approval SHALL bind source scope, stable workspace and target IDs, a typed bounded evidence projection, classifier policy, exact permitted action schemas, thresholds, expiry and monotonic authority generation. Unknown selectors, arbitrary document paths, executable rule content and unapproved targets SHALL be rejected. Classification output SHALL NOT grant authority or broaden approved inputs or effects.

#### Scenario: Rule edited after approval
- **WHEN** any source, projection, target, action, threshold or limit changes
- **THEN** the changed rule requires a new approval before execution.

#### Scenario: Classifier proposes unapproved effect
- **WHEN** a classifier response proposes a target or operation outside the approved rule
- **THEN** the proposal is rejected or held for review without changing the workspace.

### Requirement: Actions preserve causal and human decisions
Before classification and before authoring, processing SHALL capture and recheck the target's stable identity, relevant status and placement revision, and causal frontier. Receivers SHALL validate the action against current signed authority and its proven causal predecessor. Event timestamps alone SHALL NOT establish precedence. Rejected applications SHALL remain visible status items and SHALL NOT be archived or deleted.

#### Scenario: Human changes application during processing
- **WHEN** a person changes the target status or placement after processing captured its precondition
- **THEN** the automated action is held for review and does not overwrite the change.

#### Scenario: Concurrent offline decisions
- **WHEN** a manual change and an automated action are causally incomparable
- **THEN** both pieces of evidence remain available for reconciliation; no silent winner is selected.

### Requirement: Processing is durable, idempotent and auditable
The inbox SHALL distinguish event identity, action identity and retry attempt identity. It SHALL persist action intent before upload and retry uncertain delivery with the exact prepared action. An event SHALL become applied only after authorized local commit and required durable receipt. Audit records SHALL link source digest, rule version, bounded projection, decision, precondition, action, receipt and outcome without exposing secrets in ordinary logs.

#### Scenario: Lost action response
- **GIVEN** an action may have been committed but its response was lost
- **WHEN** processing retries
- **THEN** it retries the exact prepared action and records one logical effect after receipt validation.

#### Scenario: Revocation during retry
- **WHEN** rule authority is revoked while an action is pending
- **THEN** future action application is rejected while source evidence and retry/audit state remain reviewable.
