## ADDED Requirements

### Requirement: Owner-configured storage serves every admitted participant
The system SHALL make owner-configured Rusty board storage available to authorized participants across identities while owner devices are offline. Only the board owner SHALL configure storage; storage access SHALL NOT confer board editing or service management rights.

#### Scenario: Independent participants while owner is offline
- **GIVEN** an owner configured Rusty and a distinct editor and visitor received current scoped access
- **WHEN** all owner sessions close and the editor saves an authorized change
- **THEN** the visitor receives the change through Rusty
- **AND** the visitor cannot edit and neither participant can configure storage

#### Scenario: Independent service owners
- **GIVEN** two unrelated owners authenticate to one Rusty service
- **WHEN** each manages its own resources and the service restarts
- **THEN** both remain authorized for their resources
- **AND** neither can read management rights or replace policies on the other's established resources

#### Scenario: Two separately configured boards of one owner
- **GIVEN** the same owner configured Rusty on two boards and admitted the same distinct editor to both
- **WHEN** the editor switches between boards, reopens them, and the owner's sessions close
- **THEN** each board retains its own authenticated Rusty connection and exchanges its authorized changes
- **AND** credentials and content from one board cannot be used for the other
- **AND** a failed owner setup remains visibly incomplete rather than being represented as a successful connection

### Requirement: Retained recovery intent selects the operation
A pending credential transition SHALL preserve its exact signed intent, keys and pending uploads. Connect/recovery UI SHALL identify the operation and offer its matching existing resume path without silently clearing the freeze or generating unrelated replacement credentials.

#### Scenario: Interrupted conflict recovery
- **GIVEN** a retained conflict recovery for a board or identity scope
- **WHEN** the initiating device resumes it
- **THEN** the saved scope and evidence are used and ordinary writers remain frozen until required confirmations succeed

#### Scenario: Interrupted device removal
- **GIVEN** a retained origin-wide device revocation
- **WHEN** recovery is opened
- **THEN** it identifies that device removal and resumes its existing coordination path
- **AND** a failed or foreign-signer attempt preserves the retained evidence

#### Scenario: Automation inspection fails before a new removal
- **GIVEN** unchanged Rusty credentials and an incompatible or unreachable automation
- **WHEN** the owner starts device removal
- **THEN** inspection fails before the local origin freeze is created
- **AND** original credentials and ordinary replication remain available

#### Scenario: Replication advances during inspection
- **GIVEN** successful automation inspection while ordinary replication advances its cursor
- **WHEN** the unchanged credential bindings are frozen for removal
- **THEN** the newest progress is retained
- **AND** a concurrent credential change instead rejects stale preparation without freezing it

### Requirement: Public delivery follows confirmed visibility and current access
The client SHALL establish public board visibility before resolving editor publication credentials. A private board SHALL have no public-delivery error or retry action. Public delivery SHALL require current scoped authority and retain signature/frontier checks throughout the operation.

#### Scenario: Private board with incomplete local editor cache
- **GIVEN** a private board and missing local editor publication authority
- **WHEN** its current editor changes the board or opens Settings
- **THEN** private visibility ends publication processing quietly
- **AND** no editor publication grant is requested and no public-delivery error/action appears

#### Scenario: Public board access cannot be verified
- **GIVEN** a confirmed public board and unavailable or revoked editor authority
- **WHEN** automatic delivery begins
- **THEN** it stops before signing/staging and offers an applicable Sync/access action
- **AND** it does not repeatedly retry a permanent authority failure

#### Scenario: Transient public delivery failure
- **GIVEN** a public board and current editor authority
- **WHEN** the service temporarily fails and later recovers
- **THEN** admitted changes retry and are confirmed by a verified scoped receipt
- **AND** an obsolete board/source result cannot become the newly selected board's state

### Requirement: Connection status reflects working data exchange
The system SHALL distinguish peer presence, local persistence and durable Rusty availability. It SHALL repair underlying channel churn rather than hide it with display debounce.

#### Scenario: Multiple workspaces on one computer
- **GIVEN** distinct admitted browser sessions on one computer and several workspaces
- **WHEN** they remain idle, exchange edits, and one tab closes/reopens
- **THEN** data exchange and heartbeats remain healthy without repeated connection churn or stream-budget rejection

#### Scenario: Idle responses do not occupy payload slots
- **GIVEN** two scopes await response headers and another scope receives a heartbeat
- **WHEN** the heartbeat is read
- **THEN** it completes without waiting for those responses
- **AND** header waits, payload frames and total reserved bytes remain bounded

### Requirement: Intake and service status have complete journeys
The deployed public form SHALL use its current integration contract and report the actual accepted/rejected outcome. Authorized users SHALL be able to inspect meaningful board/storage state and applicable recovery actions without interpreting internal protocol exceptions.

#### Scenario: Accepted deployed form submission
- **GIVEN** the deployed form configuration and an explicitly authorized synthetic submission
- **WHEN** the challenge and submission complete
- **THEN** the form outcome agrees with the retained integration event and no retired intake route is used

#### Scenario: Storage unavailable or pending
- **GIVEN** a configured Rusty service that is unavailable or has a pending operation
- **WHEN** an authorized participant opens Sync
- **THEN** the board's storage state and applicable action remain visible alongside truthful peer state
