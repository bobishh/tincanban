## ADDED Requirements

### Requirement: Recoverable versioned legacy migration

The system SHALL migrate v0.0.1 using a durable plan and the exact mapping in `contracts/commands.md`, preserve original record IDs/timestamps and old Automerge history, and publish the new catalog reference only after durable completion. Unsupported newer formats SHALL remain intact and read-only/unopened with an update message.

#### Scenario: Existing job workspace upgrades without data loss

- **GIVEN** a legacy bundle includes all five statuses, notes, a template, an artifact, and local paths
- **WHEN** migration completes
- **THEN** records retain IDs and references, statuses map to columns, and templates remain workspace-global
- **AND** Archive is active and collapsible
- **AND** old native history and original migration input remain available.

#### Scenario: Interrupted migration resumes

- **GIVEN** a migration plan has allocated IDs and stored original bytes
- **WHEN** the app stops before publishing the catalog entry
- **THEN** reopening resumes the same plan and reuses all IDs
- **AND** it creates one workspace and one migration result.

#### Scenario: Independent migrations are not silently combined

- **GIVEN** two devices independently migrated the same legacy lineage to different workspace IDs
- **WHEN** one attempts to reconcile those copies as the same workspace
- **THEN** the app reports migration_conflict and offers keep-both/export recovery
- **AND** neither copy or old history is overwritten.

#### Scenario: Newer document is not downgraded

- **GIVEN** an imported document declares an unsupported formatVersion
- **WHEN** it is opened
- **THEN** the app requests a compatible application version
- **AND** it does not normalize unknown records into an empty workspace.

### Requirement: Workspace-scoped portable bundle

The system SHALL export v2 bundles containing the canonical document, manifest, readable snapshot, public verification proofs, and selected blobs. It SHALL exclude private roots, private keys, and invitation secrets. It SHALL preserve historical data without promising redaction of legacy paths embedded in old history.

#### Scenario: Round trip preserves workspace identity and layout data

- **GIVEN** a board has renamed columns, a nested item, archived content, and custom fields
- **WHEN** its bundle is exported and imported into an authorized installation
- **THEN** the same IDs, ordering, values, history, and archive timestamps remain
- **AND** the receiving UI renders the board from those records.

#### Scenario: Import chooses identity-aware merge behavior

- **GIVEN** one workspace is already present locally
- **WHEN** another bundle with that workspace ID and compatible lineage is imported
- **THEN** native changes merge without duplicating items
- **WHEN** a bundle with another workspace ID is imported
- **THEN** it is registered separately rather than merged into the selected workspace.

#### Scenario: Corrupt canonical bundle fails before publication

- **GIVEN** a bundle has a mismatched ID, invalid signature, or wrong blob hash
- **WHEN** import is attempted
- **THEN** it returns a specific failure and existing workspace/catalog heads remain unchanged
- **AND** it never falls back to trusting its JSON snapshot.

#### Scenario: JSON-only import is a new snapshot workspace

- **GIVEN** a readable legacy JSON export without Automerge bytes
- **WHEN** it is imported
- **THEN** the app creates a new workspace ID and retains original entity IDs where unambiguous
- **AND** the UI identifies it as snapshot import without original history.

### Requirement: Local file availability is explicit

The system SHALL distinguish replicated blob references from device-local file locations. File bytes SHALL be verified by hash. A local path SHALL NOT be treated as a transferred file or automatically opened after import.

#### Scenario: Remote device lacks a referenced local PDF

- **GIVEN** an item has a PDF artifact stored only as a local path on another device
- **WHEN** the workspace syncs
- **THEN** the artifact and its provenance are visible
- **AND** its file state says unavailable on this device rather than complete or broken item.

#### Scenario: Archived attachment stays recoverable

- **GIVEN** a blob-backed attachment is archived
- **WHEN** storage is compacted and the attachment is restored
- **THEN** its file reference and retained blob remain available
- **AND** archiving has not triggered blob garbage collection.
