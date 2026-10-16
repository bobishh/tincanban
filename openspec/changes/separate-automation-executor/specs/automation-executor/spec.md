## ADDED Requirements

### Requirement: Shared authorized participant in a separate service
The executor SHALL reuse mesh protocol/security and application command code.
Runtime adapters SHALL NOT duplicate authorization, causal admission or item
semantics. Rusty SHALL remain unable to decrypt private board state or author items.

#### Scenario: Same mutation from a different runtime
- **GIVEN** an owner-approved automation identity and supported board state
- **WHEN** the standalone executor proposes an item change
- **THEN** the shared command/admission code enforces the same grant constraints
- **AND** Rusty receives only encrypted objects and authenticates durable receipts

#### Scenario: Configuration cannot grant access
- **GIVEN** a service credential but no valid grant or board reading key
- **WHEN** a caller submits an item command or changes service configuration
- **THEN** no private board is read or authored and no owner/editor privilege appears

### Requirement: Durable scoped items command API
Form and email intake SHALL submit through the same bounded authenticated command
API. Acceptance SHALL be durable before acknowledgement. Result reads SHALL be
scoped. A submitted command SHALL NOT imply an applied board mutation.

#### Scenario: Lost acceptance reply
- **GIVEN** a command committed before its HTTP reply was lost
- **WHEN** the producer retries the same integration/key/payload
- **THEN** the original command/result is returned without another item change

#### Scenario: Changed payload or foreign integration
- **GIVEN** an accepted command key and an integration-bound caller
- **WHEN** the key is reused for different content or another integration is targeted
- **THEN** the request is rejected without changing the original command or board

#### Scenario: Current grant denies a queued action
- **GIVEN** a durably queued command whose grant is now expired, revoked or paused
- **WHEN** execution loads and admits current board authority
- **THEN** no new mutation is authored and the result explains the denial

#### Scenario: Ambiguous target
- **GIVEN** a recognized email action with insufficient original-source target evidence
- **WHEN** the command is processed
- **THEN** the original event is retained for review and no guessed card is changed

### Requirement: Exact pending-write recovery
The executor SHALL persist the command and exact signed/encrypted outbox before
upload. Applied status SHALL require verified matching storage acknowledgement.

#### Scenario: Restart after Rusty accepted an upload
- **GIVEN** persisted pending bytes and a lost upload response
- **WHEN** the executor restarts and retries
- **THEN** it resumes the same bytes/change and obtains a verified receipt
- **AND** the command does not create a second item mutation

### Requirement: Fenced migration preserving manual work
Migration SHALL preserve existing identity, scoped authority, history, deduplication
and pending writes. Exactly one runtime SHALL author for an integration. Legacy
events SHALL be reconciled with current manual outcomes before execution.

#### Scenario: Interrupted import
- **GIVEN** the Cloudflare writer is durably fenced and import is incomplete
- **WHEN** either service restarts or the old release is rolled back
- **THEN** neither an incomplete new writer nor the retired writer authors changes
- **AND** migration resumes from its durable checkpoint without dropping accepted intake

#### Scenario: Manually handled Tesla and Amazon events
- **GIVEN** Tesla cards already created and Amazon already moved by the owner
- **WHEN** matching legacy events reach the migrated queue
- **THEN** manual outcomes remain unchanged and no duplicate Tesla card is created
- **AND** exact manual-resolution evidence or a non-mutating review outcome is retained

### Requirement: Independent release and actual production acceptance
Executor and intake SHALL release through their own component CI. Neither SHALL
deploy Rusty/TinSink or require the frontend's simultaneous release. Completion
SHALL require a real authorized production automation result, not CI alone.

#### Scenario: Executor unavailable
- **GIVEN** an unavailable executor and an available Rusty
- **WHEN** intake accepts an event and a browser synchronizes its board
- **THEN** the event remains durable/pending and ordinary board sync proceeds independently

#### Scenario: Production event applies
- **GIVEN** a clearly identified new authorized production event with an unambiguous action
- **WHEN** intake forwards it and the executor completes execution
- **THEN** the actual board contains the intended admitted signed change
- **AND** its command result contains a verified Rusty receipt and correlated diagnostic trace
