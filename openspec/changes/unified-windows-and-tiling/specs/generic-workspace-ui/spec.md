## MODIFIED Requirements

### Requirement: History and synchronization states are visible

The system SHALL expose item history and the scoped Sync window through ordinary
controls and the shared spatial window system. It SHALL distinguish saved,
saving/failed, waiting for approval, syncing documents, files pending, connected
and offline states using user-facing language. Migrating presentation SHALL NOT
change the synchronization lifecycle or claim success before it is established.

#### Scenario: Author and device appear in history

- **GIVEN** a collaborator's verified edit has arrived
- **WHEN** the user opens item history
- **THEN** the action identifies the person and device
- **AND** legacy entries remain labeled as such.

#### Scenario: Pending enrollment has no false success

- **GIVEN** another device is waiting for approval
- **WHEN** the Sync window is displayed or its layout changes
- **THEN** it shows the pending step and cancel action
- **AND** it does not say connected or everything synced.
