## ADDED Requirements

### Requirement: One atomic command boundary

The system SHALL apply every accepted domain mutation as one native Automerge change through the shared transaction service, with versioned transaction metadata. It SHALL patch independent fields in place and SHALL NOT replace root entity maps/arrays or maintain a second event-replay authority.

#### Scenario: Composite restore and move has one history entry

- **GIVEN** an archived item and an active target column
- **WHEN** restoreAndMove succeeds
- **THEN** one change contains both modifications and one named transaction
- **AND** UI and agent subscribers observe the complete committed result.

#### Scenario: Validation failure creates no partial history

- **GIVEN** a command includes an invalid field value
- **WHEN** UI or WebMCP submits it
- **THEN** both receive a field-specific error
- **AND** entity values, durable changes, and heads remain unchanged.

#### Scenario: Independent offline field changes survive

- **GIVEN** two replicas share an item
- **WHEN** one edits its title and the other edits a custom field offline
- **THEN** both edits remain after merge in either order
- **AND** unrelated entities are not replaced.

#### Scenario: Complete workspace configuration changes atomically

- **GIVEN** a valid workspace-settings draft changing title, columns, fields, and document templates
- **WHEN** `updateWorkspaceSettings` executes against matching expected heads
- **THEN** every setting changes in one native Automerge change
- **AND** no intermediate schema can be published or replicated.

### Requirement: Durable commit before publication

The system SHALL persist candidate change bytes, proof, and receipt atomically before marking them saved or making them available for outbound replication. It SHALL preserve the previously committed state on failure and support transaction-ID idempotence.

#### Scenario: IndexedDB fails during save

- **GIVEN** the next storage transaction is forced to fail
- **WHEN** an item creation is submitted
- **THEN** the UI reports a retryable save failure and the peer receives no new change
- **AND** reload shows the previous committed workspace
- **WHEN** the same transaction is retried after storage recovers
- **THEN** exactly one item and one receipt are committed.

#### Scenario: A committed command is retried

- **GIVEN** a transaction UUID already has a durable receipt
- **WHEN** its identical command is resubmitted
- **THEN** the same receipt is returned without another native change
- **AND** reuse with different command data fails.

### Requirement: Concurrent local persistence retains history

The system SHALL store immutable chunks keyed by document and change hash, reconcile durable changes between tabs, and compact storage only over covered heads. Readable JSON SHALL remain a disposable representation.

#### Scenario: Two tabs save from stale snapshots

- **GIVEN** two tabs share a profile and start at the same heads
- **WHEN** each writes a different item before receiving the other's notification
- **THEN** closing both and reopening preserves both items and their histories
- **AND** snapshot compaction does not discard the unseen writer's chunk.

#### Scenario: Canonical reload needs no JSON state cache

- **GIVEN** a saved workspace with native history
- **WHEN** its readable JSON cache is removed and the app reloads
- **THEN** current entities and history are reconstructed from Automerge storage
- **AND** the UI does not replay business commands.

### Requirement: Native history has verified attribution

The system SHALL project native changes into a history view with action, entity IDs, stable person/device IDs, and verified display attribution. It SHALL label unverified legacy history explicitly and preserve causal relationships without claiming a global wall-clock order.

#### Scenario: Relay preserves original editor

- **GIVEN** A on device J signs an edit and device K relays it to B
- **WHEN** B opens item history
- **THEN** it shows A / J as author, not the relay
- **AND** the author proof can be traced to A's device certificate.

#### Scenario: Imported legacy authors remain unknown

- **GIVEN** an old workspace contains unsigned changes
- **WHEN** it is migrated by A
- **THEN** old entries are labeled Legacy/imported
- **AND** only the migration and subsequent signed edits are attributed to A.

### Requirement: Causal review preserves source history and resolves after durable apply

The system SHALL keep review dismissal separate from causal admission. Dismissing a pending or quarantined row SHALL hide it from the active review count while retaining its source change, proof, and review history. The user SHALL be able to reopen dismissed history and retry the same source change. A dismissal persistence failure SHALL hide the row immediately, show an independent dismissible error, and permit retry; reload SHALL reconstruct dismissal from the last durable value. Applying a review SHALL create a trusted authorized change from selected fields and atomically persist that derived change, proof, receipt, and source-hash resolution record before resolving the review row or counting it as complete. The original source decision SHALL remain quarantined; only the derived change SHALL be admitted. Repeated clicks or retries for a source hash with a durable resolution record SHALL NOT create another derived command.

#### Scenario: Dismissed source remains recoverable

- **GIVEN** a quarantined source change with retained causal history and proof
- **WHEN** the user dismisses its active review row
- **THEN** the row is hidden from the active review count
- **AND** its source change and proof remain in review history
- **AND** its causal decision remains quarantined
- **WHEN** the user reopens that history entry
- **THEN** the same source hash can be reviewed without admitting the source change.

#### Scenario: Dismissal save fails and retries

- **GIVEN** a quarantined review row and a storage failure during dismissal
- **WHEN** the user dismisses the row
- **THEN** the row is hidden immediately and a separate dismissal error is shown
- **AND** dismissing that error does not erase the retained source history or proof
- **WHEN** storage recovers and dismissal persistence is retried
- **THEN** reload restores the dismissed state from durable metadata
- **AND** the source remains quarantined and available in review history.

#### Scenario: Failed authorized apply remains retryable

- **GIVEN** a quarantined source change and a storage failure while persisting its authorized derived change
- **WHEN** the user applies the review
- **THEN** the source remains quarantined, its history and proof remain available, and no completion is counted or published
- **AND** the UI shows a dismissible retry error
- **WHEN** storage recovers and the same source hash is reviewed again
- **THEN** exactly one trusted derived change, proof, receipt, and source-hash resolution record are committed atomically
- **AND** only the derived change is admitted; the original untrusted branch remains quarantined
- **AND** reload shows the review resolved.

#### Scenario: Retry after durable apply does not duplicate the command

- **GIVEN** a trusted derived change and admitted decision are durably committed but the review projection has not refreshed
- **WHEN** the user repeats the action or reloads the workspace
- **THEN** the same source hash resolves from its durable derived-change receipt
- **AND** the original source decision remains quarantined
- **AND** no second derived command or completion count is created.
