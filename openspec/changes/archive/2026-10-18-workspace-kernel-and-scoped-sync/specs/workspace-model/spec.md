## ADDED Requirements

### Requirement: Independent typed workspaces

The system SHALL store each workspace as a separate Automerge document matching `contracts/model.ts`. A workspace SHALL contain boards, columns, items, fields, documents, templates, and artifacts as typed records keyed by stable IDs. It SHALL NOT store a second authoritative status/column/board pointer on items or an EAV table.

#### Scenario: Another workflow needs no job-search fields

- **GIVEN** a person has a Job search workspace
- **WHEN** they create another workspace using Blank board
- **THEN** it has a distinct UUID and To do, Doing, Done columns
- **AND** an item can be created using only a title and parent
- **AND** neither workspace changes the other's fields or columns.

#### Scenario: Column rename preserves membership

- **GIVEN** an item references an Applied column
- **WHEN** that column is renamed to Sent
- **THEN** its ID and the item's placement remain unchanged
- **AND** the item is shown in Sent after reload.

### Requirement: Stable IDs and explicit containment

The system SHALL allocate UUIDv4 IDs for new mutable content, transactions, and workspaces; preserve legacy record IDs; and validate the parent-kind table in `design.md`. Item nesting SHALL inherit board/column through ancestry. References SHALL resolve only within the containing workspace.

#### Scenario: Item and subitem move together

- **GIVEN** item A contains subitem B in To do
- **WHEN** A moves to Doing
- **THEN** B derives Doing through A without a write to B
- **AND** A and B retain their IDs.

#### Scenario: Invalid move is atomic failure

- **GIVEN** item A contains B
- **WHEN** a command moves A under B, under a field, or into another board/workspace
- **THEN** it returns the corresponding cycle/invalid-parent/cross-board error
- **AND** document heads and placements remain unchanged.

### Requirement: Archiving preserves relationships

The system SHALL retain mutable records and links when `archivedAt` changes between `null` and an ISO timestamp, and compute inherited visibility through containment. It SHALL provide explicit restore and restore-with-move operations. One optional Archive column SHALL project archived items from its board.

#### Scenario: Archive and restore a populated column

- **GIVEN** an active column contains active A, active subitem B under A, and separately archived C
- **WHEN** the column is archived
- **THEN** A, B, and C are hidden from ordinary board/search results without changing their timestamps or parents
- **WHEN** the column is restored
- **THEN** A and B reappear and C remains archived.

#### Scenario: Restore under archived ancestor

- **GIVEN** an archived item belongs to an archived column
- **WHEN** the item alone is restored
- **THEN** its own timestamp is cleared but it remains hidden
- **AND** the result identifies the archived ancestor and offers restore-with-move.

#### Scenario: Remote creation under archived column survives

- **GIVEN** two replicas share an active column
- **WHEN** one archives it while the other creates an item there offline
- **THEN** after merge the new item is preserved and hidden
- **AND** restoring the column reveals that item.

#### Scenario: Non-parent provenance does not cascade

- **GIVEN** a PDF artifact references a writing template
- **WHEN** the template is archived
- **THEN** the artifact remains visible under its active item
- **AND** the template reference remains inspectable as archived.

### Requirement: Deterministic recoverable placement

The system SHALL store parent and rank in one placement register and apply rational ordering with ID tie-breaks as specified in `design.md`. It SHALL derive invalid ancestry issues after merge without destructive automatic repairs.

#### Scenario: Concurrent moves preserve one effective membership

- **GIVEN** two replicas move the same item to different columns
- **WHEN** both merge in either delivery order
- **THEN** both show the same parent/rank pair from one complete placement value
- **AND** the item appears at most once
- **AND** the other placement remains inspectable as a conflict.

#### Scenario: Concurrent valid moves create a cycle

- **GIVEN** A and B are sibling items
- **WHEN** one replica moves A under B and another moves B under A
- **THEN** all replicas terminate ancestry traversal and identify the same affected entities in Needs placement
- **AND** a normal move to a live column repairs placement without deleting history.

#### Scenario: Concurrent insertions share a rank

- **GIVEN** two replicas insert items at the same gap
- **WHEN** changes merge
- **THEN** both items remain and sort by rational rank then ID identically
- **AND** another insertion between them succeeds through deterministic sibling renumbering.

### Requirement: Board-owned custom field definitions

The system SHALL support text, URL, date, boolean, bounded number, and single-select fields. Field IDs and select option IDs SHALL remain stable through label changes. Archiving SHALL preserve values. Field type changes SHALL require creating a replacement field.

#### Scenario: Rename and delete a select option

- **GIVEN** an item selects an option by ID
- **WHEN** its label changes
- **THEN** the item shows the new label without an item-value write
- **WHEN** the option is archived
- **THEN** the old value stays readable with an unavailable marker and cannot be newly selected.

#### Scenario: Field definition changes do not erase data

- **GIVEN** an item contains a numeric value
- **WHEN** bounds are tightened past that value or the field is archived
- **THEN** its stored value remains unchanged
- **AND** the UI marks an invalid value or hides the archived field respectively
- **AND** restoring the field reveals the retained value.
