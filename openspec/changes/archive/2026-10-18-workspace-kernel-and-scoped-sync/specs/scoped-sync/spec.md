## ADDED Requirements

### Requirement: Direct workspace sync selection, custom workspace sets, and distinct enrollment

The system SHALL provide direct sync selection upon opening the Sync dialog, presenting a list of workspace names with checkboxes with the currently active workspace preselected by default and a single "Generate link" action on the same screen without preliminary branch choosers. Empty selection SHALL disable link generation. Merely opening the dialog SHALL NOT create an invitation or start transport; clicking "Generate link" starts the transport node.

The system SHALL support custom workspace sets where one or multiple selected workspaces produce ONE invitation bound to exactly that fixed set of workspace IDs (`workspaces: WorkspaceItem[]`). Selecting all currently listed workspaces SHALL represent a fixed shared set, not personal identity enrollment and not subscription to future workspaces. Recipient acceptance SHALL display all invited workspace names. The issuer SHALL validate authority for every selected workspace, issuing signed workspace-specific grants. Replication SHALL authorize strictly the granted set, excluding unselected and future workspaces from discovery or transfer.

The system SHALL retain "Add my device (Sync all)" as a distinct secondary action for personal identity enrollment and live catalog following with mutual authentication code (TAC) verification, source approval, and delegated device certificate issuance.

#### Scenario: Direct sync selection preselects active workspace and generates scoped link

- **GIVEN** the user opens the Sync dialog with an active workspace
- **WHEN** the dialog opens
- **THEN** workspace checkboxes are displayed with the active workspace preselected
- **AND** a "Generate link" button is available on the same screen without an intermediate chooser
- **WHEN** the user clicks "Generate link"
- **THEN** an invitation scoped to that workspace is generated and transport starts.

#### Scenario: Custom workspace set transfers authorized workspaces and excludes others

- **GIVEN** workspaces A, B, and C exist on the host
- **WHEN** the user selects workspaces A and B and generates an invitation
- **THEN** ONE invitation containing both workspace IDs is created
- **AND** the recipient acceptance screen displays both workspace names
- **WHEN** the guest accepts and connects
- **THEN** workspaces A and B are transferred and synchronized
- **AND** workspace C and any future workspace D are strictly excluded and undisclosed.

#### Scenario: Empty workspace selection disables generation

- **GIVEN** the Sync dialog is open
- **WHEN** all workspace checkboxes are unchecked
- **THEN** the "Generate link" button is disabled.

#### Scenario: Add my device selects complete sync

- **GIVEN** the user opens Sync and chooses the secondary "Add my device (Sync all)" action
- **WHEN** their second device is approved and enrolled
- **THEN** the private root and every accessible workspace are transferred
- **AND** the UI distinguishes document readiness from remaining files.

#### Scenario: Invalid or wrong-kind invitation fails safely

- **GIVEN** a malformed, expired, cancelled, consumed, wrong-kind, or legacy unscoped link
- **WHEN** the user opens or pastes it
- **THEN** the appropriate actionable failure appears
- **AND** identity and workspace heads remain unchanged.

### Requirement: One-time redemption is resumable and race-safe

The system SHALL expire invitations after ten minutes by default, redeem them only on the issuing device, and atomically bind the first redemption to one authenticated target. Retry from that target SHALL resume; another target SHALL fail.

#### Scenario: Two recipients race to redeem

- **GIVEN** two devices present the same invitation
- **WHEN** their redemption requests overlap
- **THEN** at most one receives enrollment or a workspace grant
- **AND** the other sees an already-used invitation message.

#### Scenario: Connection drops after approval

- **GIVEN** one target was approved but transfer was interrupted
- **WHEN** that target reconnects
- **THEN** it resumes the existing redemption/trust record without duplicating devices or membership
- **AND** a different target cannot take over the invitation.

### Requirement: Durable trust and live catalog following

The system SHALL retain successful enrollment/grants and reconnect known authorized peers while the app is open or after reopening. Sync all SHALL follow future catalog changes; workspace scope SHALL remain limited to the granted workspace.

The system SHALL make mesh-member selection useful by listing that person's known devices. Each device row SHALL show online/offline state, a shortened device ID, last-seen time, and signed self-reported device name. A bounded optional user agent SHALL be carried in the peer advertisement and rendered both verbatim on demand and as an explicitly best-effort browser/OS description. User-agent metadata SHALL NOT participate in identity, authorization, or capability decisions. Older advertisements without metadata SHALL remain valid and render an unknown browser/OS state.

#### Scenario: Selecting a member shows known devices

- **GIVEN** a trusted member advertised a device name and user agent
- **WHEN** another member selects that person in Mesh members
- **THEN** their device list shows presence, shortened device ID, last-seen state, and the reported name
- **AND** the UI labels inferred browser/OS as likely and exposes the raw user agent on demand.

#### Scenario: Older device metadata remains honest

- **GIVEN** a valid older peer advertisement has no user agent
- **WHEN** its member is selected
- **THEN** the device remains listed
- **AND** the UI reports Browser / OS unknown without inventing a platform.

#### Scenario: Later workspace appears on own device

- **GIVEN** two own devices completed Sync all
- **WHEN** one creates or joins a new workspace
- **THEN** its reference and document synchronize automatically to the other connected device
- **AND** an unrelated collaborator does not learn that workspace's name or ID.

#### Scenario: Reload reconnects without QR

- **GIVEN** two devices have durable trust and one remains reachable
- **WHEN** the other reloads the application
- **THEN** it can reconnect and negotiate missing changes without another invitation
- **AND** an unreachable peer shows waiting/offline rather than synced.

### Requirement: Per-document incremental authorized replication

The system SHALL use native Automerge sync state per peer/document, verify authorization before advertising or merging documents, and offer only durably committed/proof-complete changes. It SHALL apply bounded framing, backpressure, and chunking from `design.md`.

#### Scenario: Later edit transfers a delta

- **GIVEN** two devices have synchronized a workspace with a long history
- **WHEN** one item title changes
- **THEN** the other converges through native sync messages
- **AND** instrumentation shows no full-document save payload for that live edit
- **AND** the idle connection stops sending once peers are up to date.

#### Scenario: Out-of-order duplicate delivery converges

- **GIVEN** peers made independent edits offline
- **WHEN** transport duplicates, delays, or reorders supported message delivery and reconnects
- **THEN** sync resumes with dependencies and both trusted documents converge
- **AND** no duplicated domain command is executed.

#### Scenario: Unauthorized document offer is rejected

- **GIVEN** a valid session grants only workspace Y
- **WHEN** the peer offers another document/root ID or requests its data
- **THEN** the service rejects the offer/request before trusted merge or disclosure.

#### Scenario: Oversized frame is bounded failure

- **GIVEN** a peer sends a frame or reassembly declaration beyond protocol limits
- **WHEN** it is decoded
- **THEN** the service rejects it without unbounded allocation
- **AND** existing documents remain usable.

### Requirement: File transfer has distinct progress

The system SHALL replicate referenced available blobs by hash with bounded resumable chunks and distinguish missing local-only files from transferable files. It SHALL NOT mark all data transferred while selected files remain pending.

#### Scenario: Board usable while file transfer waits

- **GIVEN** workspace changes arrived but a PDF transfer is interrupted
- **WHEN** the board opens
- **THEN** items are usable and the artifact says file pending
- **WHEN** transfer resumes and its hash verifies
- **THEN** the artifact becomes available without retransmitting completed chunks.

#### Scenario: Corrupt blob never becomes available

- **GIVEN** received file bytes fail their declared hash
- **WHEN** transfer finishes
- **THEN** the file remains unavailable with a retryable error
- **AND** metadata and other files remain intact.
