## ADDED Requirements

### Requirement: Storage-owned mutation context

Workspace persistence SHALL expose a controlled read/admission/commit context
bound to the repository, workspace, lifecycle epoch and durable basis. Raw commit
primitives SHALL NOT be public. Final persistence SHALL compare that basis inside
the write transaction, in addition to holding the cross-tab workspace lock.
Initialization, full snapshots, deltas, causal metadata, received-history activation
and maintenance SHALL use this boundary. It SHALL NOT keep an IndexedDB transaction
open across network, cryptography or admission awaits.

#### Scenario: A context is missing, stale or belongs to another workspace

- **GIVEN** a candidate without a live matching transaction context
- **WHEN** code attempts to persist it, including by casting an arbitrary JS object
- **THEN** storage rejects the operation before mutation or publication
- **AND** captured callbacks cannot commit after their context has closed.

#### Scenario: A concurrent delta invalidates an older full snapshot

- **GIVEN** two instances read revision R and one commits a delta at R+1
- **WHEN** the other attempts a full-snapshot commit based on R
- **THEN** the final transaction returns a typed conflict
- **AND** the R+1 snapshot, delta chain, proofs, receipts and history metadata remain intact.

#### Scenario: Authority changes without changing admitted document heads

- **GIVEN** a candidate admitted under revision R and an authority-only update at R+1
- **WHEN** the candidate commits with unchanged document heads
- **THEN** the stale durable revision still causes conflict
- **AND** retry reloads current authority and reruns admission.

#### Scenario: Separate authority storage fails after invalidation

- **GIVEN** authority records and the workspace journal occupy separate databases
- **WHEN** an authority mutation runs under the workspace lock
- **THEN** it durably advances the journal revision and invalidates reusable admission before writing authority
- **AND** every credential, grant, peer-role and recovery authority writer follows this ordering
- **WHEN** the authority write fails or the process stops after invalidation
- **THEN** a previously admitted candidate cannot commit under the old revision
- **AND** no authority success or replica acknowledgment is published; a fresh admission may be required even if authority remained unchanged.

#### Scenario: Two initializers target the same workspace

- **GIVEN** two create-if-absent operations captured no durable workspace
- **WHEN** the first commits and the second reaches its final write
- **THEN** the second cannot overwrite the first initialization
- **AND** it receives a conflict with the first workspace preserved.

### Requirement: Durable success controls publication

A successful commit SHALL atomically persist the relevant snapshot/delta, original
change bytes, proof/receipt, admission evidence, baseline/frontier and revision.
Failed or conflicting writes SHALL NOT advance cached admitted state, UI saved
status, replication acknowledgment or notifications. Explicit authorized projection
replacement SHALL use its own validated basis rather than an arbitrary overwrite.

#### Scenario: The final transaction aborts

- **GIVEN** an admitted command or incoming candidate and an injected storage failure
- **WHEN** its final transaction aborts
- **THEN** the previous durable state and exact pending replica upload remain unchanged
- **AND** no success notification or acknowledgment is emitted
- **WHEN** the operation retries against the current basis
- **THEN** admission and command idempotency prevent unauthorized or duplicate changes.

### Requirement: Owned document and matching frontier

Every returned Automerge document SHALL have explicit caller ownership and heads/
revision describing that same handle. Async cache reads SHALL NOT depend on a later
lookup of an evictable entry. Cache eviction/replacement SHALL release only cache
ownership; each caller-owned handle SHALL be released exactly once.

#### Scenario: Cache eviction occurs during a materialized read

- **GIVEN** a suspended `loadDocument(A)` and more workspaces than cache capacity
- **WHEN** another operation evicts or explicitly forgets A before the read resumes
- **THEN** the read returns an owned consistent document or a typed retry result
- **AND** it does not dereference a missing/freed cached handle.

#### Scenario: A newer cached revision replaces the checked result

- **GIVEN** a read captured document/heads at R and a concurrent refresh installs R+1
- **WHEN** the first read completes
- **THEN** it cannot pair an R+1 document with R heads
- **AND** subsequent disposal by either operation cannot invalidate the other's owned handle.
