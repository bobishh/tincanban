## ADDED Requirements

### Requirement: Owner-approved storage serves every authorized participant
The application SHALL distribute board-scoped Rusty access independently from private identity preferences. Only the current owner SHALL approve a storage connection. Authorized peers SHALL forward only owner-attested access within that board and no more access than they hold.

#### Scenario: Owner sleeps after configuration
- **GIVEN** owner, editor and visitor have different identities and owner-approved Rusty access
- **WHEN** all owner devices close and the editor edits a card
- **THEN** the editor uploads authorized changes through Rusty and the visitor receives them without an owner device
- **AND** the visitor never receives a usable storage write token

#### Scenario: Participant reconnects through another participant
- **GIVEN** an authorized editor holds owner-attested storage access and the owner is offline
- **WHEN** another authorized participant establishes a mesh session
- **THEN** it acquires only its role's permitted access, without receiving private identity preferences

### Requirement: Attestations preserve authority and local progress
Receivers SHALL verify owner signature/certificates, workspace/service/scope/key binding, write-token digest and monotonic policy revision. Transfers SHALL recheck current membership around asynchronous work. Repeated credentials SHALL retain local cursors and pending ciphertext.

#### Scenario: Forgery or stale delivery
- **WHEN** a transfer has a foreign workspace, forged owner signature, revoked session, changed same-revision credentials or an older policy
- **THEN** it SHALL NOT replace the current connection or publish its credentials

### Requirement: Shared access does not confer owner administration
Received board access SHALL NOT provision private identity storage, manage the owner's Rusty policy or bypass signed application admission. Read-only synchronization SHALL only download/admit data and SHALL NOT upload snapshots, checkpoints or attachments.

#### Scenario: Read-only synchronization and unavailable storage
- **GIVEN** a visitor has received reading access
- **WHEN** synchronization runs
- **THEN** Sync shows that connection and its actual status without management controls or writes
- **AND** an unavailable Rusty is reported without deleting saved board data
