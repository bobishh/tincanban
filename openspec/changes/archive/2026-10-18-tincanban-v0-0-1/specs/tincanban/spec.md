## ADDED Requirements

### Requirement: Trello-equivalent lead board

The system SHALL render one flat card pipeline with Lead, Applied, Interview, Offer, and Archive statuses.

#### Scenario: Board shows pipeline columns

- **WHEN** the app loads
- **THEN** it shows Lead, Applied, Interview, Offer, and a collapsed Archive bin in this order
- **AND** each column shows card count
- **AND** a lead belongs to one column based on its `status` value.

#### Scenario: User expands the Archive bin

- **GIVEN** one or more leads have Archive status
- **WHEN** the user opens the compact Archive bin at the end of the board
- **THEN** it expands with an animation into a regular card column
- **AND** its cards obey the current search and filters.

#### Scenario: User moves a card

- **WHEN** the user changes a selected card status
- **THEN** the card moves to the matching column
- **AND** the change persists after reload.

### Requirement: Mobile board navigation

The system SHALL keep the board usable in portrait on a 390-by-844 CSS-pixel viewport without asking the user to rotate their phone.

#### Scenario: Phone starts with filters collapsed

- **GIVEN** the app opens on a viewport at most 720 CSS pixels wide
- **THEN** filter controls are hidden behind a visible Filters disclosure by default
- **WHEN** the user opens Filters
- **THEN** all status, priority, work-mode, and fit controls become available.

#### Scenario: Phone swipes complete pipeline columns

- **GIVEN** the app opens on a 390-by-844 CSS-pixel viewport
- **THEN** one pipeline column occupies the visible board width
- **AND** the board has horizontal overflow with snap points at each complete column
- **AND** portrait remains supported without an orientation prompt.

### Requirement: Legible desktop controls

The system SHALL keep TINCANBAN branding and all filter controls readable on a 1024 CSS-pixel-wide desktop viewport.

#### Scenario: Mid-size desktop shows complete controls

- **WHEN** the app opens on a 1024 CSS-pixel-wide viewport
- **THEN** the brand reads `TINCANBAN`
- **AND** search and each filter select remain visible without clipping or page-level horizontal overflow
- **AND** each filter label and control are laid out as one field rather than squeezed into adjacent controls.

### Requirement: Flat lead cards

The system SHALL store company and role directly on a lead card. It SHALL NOT require organization creation or a separate vacancy record.

#### Scenario: Agent creates a lead

- **WHEN** a valid generic item command supplies the seeded company and role fields under a Job search column
- **THEN** the app creates one visible card
- **AND** the card appears in the requested status column
- **AND** no organization or application setup is requested.

#### Scenario: Invalid lead is rejected

- **WHEN** a Job search item omits required seeded fields or supplies an invalid field value
- **THEN** the command fails with field-level validation
- **AND** no partial card is persisted.

### Requirement: Attached notes and file references

The system SHALL let each lead show and manage attached notes and file references. CVs and cover letters SHALL be represented by the dedicated PDF artifact model.

#### Scenario: Card shows documents

- **WHEN** a lead has attached notes or file references
- **THEN** its card shows compact document badges
- **AND** its detail panel lists document title, kind, and format.

#### Scenario: Agent attaches a document

- **WHEN** the user attaches a valid note or file reference to an item
- **THEN** the document is attached to that lead
- **AND** the detail panel shows it without changing lead status.

### Requirement: Global Markdown writing templates

The system SHALL store CV and cover-letter bases as dedicated global Markdown templates. A template SHALL NOT be an attached lead document and SHALL NOT contain presentation or PDF-renderer configuration.

#### Scenario: User saves a base CV

- **WHEN** the user saves a named CV template with non-empty Markdown
- **THEN** the template is available from the Templates library
- **AND** it is not attached to any lead card.

#### Scenario: User edits a base template

- **WHEN** the user edits and saves an existing template
- **THEN** the same template id remains
- **AND** its Markdown and updated timestamp change.

### Requirement: Lead-bound PDF artifacts

The system SHALL represent generated CVs and cover letters as dedicated PDF artifacts bound to one lead. PDF rendering and styling SHALL remain local-agent concerns outside workspace state.

#### Scenario: User records a generated CV PDF

- **GIVEN** a lead and a matching base CV template
- **WHEN** the user records a title and local PDF path
- **THEN** the lead shows one CV PDF artifact
- **AND** the artifact records the originating template id.

#### Scenario: Artifact requires generation inputs

- **WHEN** the user attempts to attach a PDF artifact without a title, matching template, or PDF path
- **THEN** the app shows a validation error
- **AND** no artifact is persisted.

### Requirement: Local workspace persistence

The system SHALL persist leads and documents on the current device without a backend.

#### Scenario: Reload preserves workspace

- **WHEN** the user creates a card or document and reloads the app
- **THEN** the same records remain available.

#### Scenario: User exports workspace

- **WHEN** the user invokes the visible workspace export action
- **THEN** the app downloads a `.tincanban` bundle containing a manifest, readable leads/documents JSON, and Automerge state.

### Requirement: Local merge transport

The system SHALL merge same-origin tab changes through Automerge without choosing a timestamp winner.

#### Scenario: Two tabs edit workspace

- **WHEN** two app tabs publish independent workspace changes
- **THEN** each tab merges the other tab's Automerge document
- **AND** both visible boards converge
- **AND** `updatedAt` does not decide the winner.

#### Scenario: A stale tab catches up from local storage

- **GIVEN** two tincanban tabs share one browser profile
- **WHEN** one tab persists a workspace change, including a change received from a paired device
- **THEN** the other tab reads the latest Automerge document from IndexedDB and merges it automatically
- **AND** returning focus to a background tab triggers the same IndexedDB reconciliation
- **AND** no QR pairing is required for same-browser tabs.

### Requirement: Experimental browser iroh transport

The system SHALL use browser iroh only through a transport boundary and SHALL NOT report a synced workspace before a paired peer has completed authenticated request, response, and acknowledgement frames.

#### Scenario: Opening Sync creates a pairing invitation

- **WHEN** the user opens Sync
- **THEN** the app starts the browser WASM adapter, opens an acceptor, and renders a pairing QR without another setup action
- **AND** the dialog does not present caller/listener roles or transport implementation details
- **AND** no workspace is claimed as synced until pairing and an ALPN `match/sync/0` stream exist.

#### Scenario: QR link waits for the scanning browser

- **WHEN** a second device opens a valid pairing QR link or pastes it into Sync
- **THEN** it shows one explicit Connect to mesh action before transport startup
- **WHEN** the user chooses Connect to mesh
- **THEN** temporary bootstrap failures retry while both pairing dialogs remain open
- **AND** both visible workspaces converge after the authenticated merge.

#### Scenario: A paired peer replicates a later change

- **GIVEN** two browser profiles have completed one QR pairing
- **WHEN** either profile creates, updates, or moves a card
- **THEN** the other profile merges that change without another QR, import, or manual move
- **AND** closing or stopping either live session ends this replication until a new pairing.

#### Scenario: Invalid pairing link fails safely

- **WHEN** a device opens a malformed pairing link
- **THEN** it shows a pairing failure
- **AND** it does not report a synced workspace or merge data.

### Requirement: Flat WebMCP surface

The system SHALL expose imperative WebMCP tools that call the same domain commands as visible UI controls.

#### Scenario: Valid tool mutation updates visible state

- **WHEN** a supported browser calls `create_item` with a valid flat payload
- **THEN** the tool returns the created item id and parent id
- **AND** the card is visible in the board.

#### Scenario: Tool rejects nested or unknown input

- **WHEN** a tool receives unknown fields or a CRDT-shaped nested payload
- **THEN** it rejects the input
- **AND** workspace state remains unchanged.
