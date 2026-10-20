## ADDED Requirements

### Requirement: Explicit settings scopes
Settings SHALL separate Identity, Workspace and Connections. Identity SHALL contain the global name, one identity photo, identity recovery and device diagnostic consent. Workspace SHALL identify the workspace and board affected by configuration. Advanced JSON SHALL be collapsed within Workspace.

#### Scenario: Scoped settings on desktop and mobile
- **GIVEN** a workspace and a desktop or mobile viewport
- **WHEN** the user opens Settings and switches scope
- **THEN** only Identity, Workspace and Connections appear in the top-level navigation
- **AND** collector configuration is absent from Identity and photo editing appears only in Identity
- **AND** workspace templates, board priority rules and advanced JSON identify their scope

### Requirement: Identity photo
A participant SHALL have one identity photo, edited under Identity. The durable personal catalog SHALL own the preference; signed workspace member profiles SHALL carry public projections. Existing own workspace photos SHALL migrate to the identity preference. Removal SHALL propagate a timestamped empty value so stale workspace photos cannot restore it.

#### Scenario: Save once and reuse everywhere
- **GIVEN** a participant chooses and crops a valid photo
- **WHEN** the participant saves the crop
- **THEN** the photo persists immediately without a second save action
- **AND** reloading or opening another workspace displays the same photo
- **AND** photo changes remain limited to that participant's authenticated profile

#### Scenario: Failed identity persistence
- **GIVEN** photo saving fails
- **WHEN** the error appears
- **THEN** the previous durable identity photo remains intact and the crop can be retried
- **AND** failed workspace sharing is explicit without erasing the successfully saved identity preference

### Requirement: Single access and backup workflows
Participants and device access SHALL have one management view. Whole-person revocation SHALL require confirmation disclosing all affected devices and the workspace. Ownership succession SHALL belong to participant access. Workspace file operations SHALL belong to Backups; identity backup SHALL remain a separate Identity action.

#### Scenario: Confirm or cancel participant removal
- **GIVEN** an owner selects another participant
- **WHEN** the owner requests removal
- **THEN** confirmation names the participant, workspace and all their devices
- **AND** cancellation retains access while confirmation stops writes without discarding previously accepted history

#### Scenario: Workspace backup shortcut
- **GIVEN** Settings Connections is open
- **WHEN** the user chooses Back up or move workspace
- **THEN** Settings closes and Sync opens directly to Backups with export/import actions
- **AND** ownership succession controls remain in Participants

### Requirement: Owner-managed supported automations
Connections SHALL expose supported automation types and versions through a registry. Owners SHALL add, pause, resume and remove independent Worker instances. Desired state SHALL reside in signed workspace CRDT records; displayed confirmation SHALL require a fresh Worker acknowledgement of the exact admitted control heads. Rusty storage SHALL expose only storage connection and replication controls.

#### Scenario: Scoped activation through Connections
- **GIVEN** a connected blind replica and a workspace owner
- **WHEN** the owner opens Connections and connects a supported automation with explicit workspace reading consent
- **THEN** an independent certified Worker receives the exact owner-signed Automation grant and private activation packet
- **AND** invalid Worker identity proof is rejected without creating an automation record
- **AND** operator credentials and private activation exports are absent from the ordinary UI

#### Scenario: Pause, resume and terminal removal
- **GIVEN** a connected automation
- **WHEN** its owner changes the desired state
- **THEN** the Worker reads admitted CRDT controls and acknowledges their exact heads
- **AND** pending or unreachable execution remains explicit until confirmation
- **AND** pause preserves queued events without classification or spent retries
- **AND** removal cannot be reversed by stale snapshots or repeated activation
