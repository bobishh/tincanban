## ADDED Requirements

### Requirement: Native generic board from workspace data

The system SHALL render boards from stored columns, order, titles, items, and fields using native Vue components. It SHALL preserve existing desktop/mobile usability and SHALL NOT require or introduce a declarative UI language for this change.

#### Scenario: User changes a board's columns

- **GIVEN** a board is open at `/w/:workspaceId/b/:boardId`
- **WHEN** the user adds, renames, and reorders columns
- **THEN** the board reflects those records and reload preserves them
- **AND** keyboard movement and mobile column navigation still work.

#### Scenario: Invalid column creation stays in the form

- **GIVEN** the add-column form is open
- **WHEN** the user submits an empty title
- **THEN** it displays field validation without closing or creating a column.

### Requirement: Generic items and nested detail

The system SHALL provide item creation/editing based on board fields, parent/subitem navigation, and same-board movement. It SHALL retain job-search template/PDF workflows through the preset adapter.

#### Scenario: Non-job item works end to end

- **GIVEN** a Blank board named Reading with a text field Author
- **WHEN** a user creates an item, fills Author, adds a subitem, and moves the parent
- **THEN** all edits remain after reload
- **AND** no company, role, CV, or application-status control is required.

#### Scenario: Required custom field fails visibly

- **GIVEN** a board has a required custom field
- **WHEN** an item is submitted without it
- **THEN** the form identifies that field and preserves the draft
- **AND** neither the board nor its peer shows a partial item.

### Requirement: Archive and placement recovery are reachable

The system SHALL expose archived items through one optional Archive column per board. Archive SHALL use the item's `archivedAt` timestamp. The Add column form SHALL offer an Archive checkbox that becomes unavailable when an Archive column exists. Needs placement SHALL remain separate, with explicit recovery for malformed ancestry.

#### Scenario: Restore an archived item

- **GIVEN** an item was archived before its board enabled Archive
- **WHEN** the user enables Archive and restores that item
- **THEN** the item reappears in its original column and position.

#### Scenario: Placement recovery survives malformed ancestry

- **GIVEN** a merged graph has a cycle or missing parent
- **WHEN** the user opens Needs placement
- **THEN** the affected items and reasons are visible without hanging the page
- **AND** moving an item to a live column resolves its affected subtree where ancestry becomes valid.

### Requirement: History and synchronization states are visible

The system SHALL expose item history and the scoped Sync modal through ordinary controls. It SHALL distinguish saved, saving/failed, waiting for approval, syncing documents, files pending, connected, and offline states using user-facing language.

#### Scenario: Author and device appear in history

- **GIVEN** a collaborator's verified edit has arrived
- **WHEN** the user opens item history
- **THEN** the action identifies the person and device
- **AND** legacy entries remain labeled as such.

#### Scenario: Pending enrollment has no false success

- **GIVEN** another device is waiting for approval
- **WHEN** the Sync modal is displayed
- **THEN** it shows the pending step and cancel action
- **AND** it does not say connected or everything synced.

### Requirement: Existing agent and responsive workflows remain usable

The system SHALL expose one preset-independent WebMCP command surface through the generic domain boundary. Job search is seed data, not a second protocol. It SHALL preserve 390-by-844 portrait behavior and complete 1024px controls, with real-route browser coverage.

#### Scenario: Agent mutation matches visible generic state

- **GIVEN** a board is open
- **WHEN** a valid generic command creates or moves an item
- **THEN** the same visible item changes and survives reload
- **AND** unknown fields or nested CRDT payloads return validation errors without mutation.

#### Scenario: Responsive board remains reachable

- **GIVEN** the app opens at 390-by-844 or 1024 CSS pixels wide
- **WHEN** the user navigates columns and opens item details/Sync
- **THEN** controls remain reachable without page-level horizontal clipping or forced rotation
- **AND** portrait filters start collapsed and columns retain horizontal snap navigation.

#### Scenario: Wide desktop uses available board width

- **GIVEN** the viewport is wide enough to fit every live column at its minimum width
- **WHEN** the board renders
- **THEN** the board expands to the viewport instead of stopping at a fixed desktop maximum
- **AND** no horizontal board scrollbar appears.

#### Scenario: Expanded Archive column shares normal sizing

- **GIVEN** a column has the `archive: true` role
- **WHEN** the user expands it
- **THEN** it uses the same flex sizing and minimum width as ordinary columns at every viewport
- **AND** only its closed state uses the narrow fixed width.

#### Scenario: Archive role is unique and title-independent

- **GIVEN** a board has one Archive column under any title
- **WHEN** settings assign `archive: true` to a second column
- **THEN** validation rejects the second assignment at its exact JSON path
- **AND** Archive rendering and move behavior use the role rather than a title, ID, or preset binding.

### Requirement: Mobile-first navigation and accessible drawer

The system SHALL provide a mobile-first header with an accessible hamburger menu trigger on mobile viewports (≤768px). The drawer SHALL house navigation in clearly labeled semantic groups: Workspaces, Board & Schema, Collaboration, Data & Storage, Recovery, and Resources. It SHALL manage keyboard focus (focus trap, Escape key to close, focus restoration to trigger), support backdrop dismissal, and prevent accidental horizontal page-level overflow across 360px, 390px, and 430px viewports while preserving direct desktop usability at 1024px.

#### Scenario: Mobile drawer navigation and focus management

- **GIVEN** tincanban is opened on a mobile viewport (360px, 390px, or 430px)
- **WHEN** the user activates the accessible hamburger button
- **THEN** the navigation drawer opens with focus placed inside
- **AND** navigation options are organized into labeled groups (Workspaces, Board & Schema, Collaboration, Data & Storage, Recovery, Resources)
- **AND** pressing Escape or clicking the backdrop closes the drawer and restores focus to the trigger button
- **AND** clicking an item opens its target dialog and closes the drawer without whole-page horizontal overflow.

### Requirement: Direct board editing and Trello-style ordering

The system SHALL edit board structure in place. `Edit board` SHALL be a header/drawer action, not a separate full-width row. Edit mode SHALL add and rename columns visually, open `Edit {entityName}` for the singular entity label and fields, and drag columns from their headers. Normal mode SHALL drag cards to exact positions within or across columns with pointer/touch feedback.

#### Scenario: Card and column order survives reload

- **GIVEN** a board with ordered columns and cards
- **WHEN** a user drags a card before another card or drags a column by its header
- **THEN** placeholder feedback shows the destination
- **AND** exact `beforeId` order survives reload.

#### Scenario: Failed drag restores committed state

- **GIVEN** persistence fails for the next transaction
- **WHEN** a card drag ends in another column
- **THEN** the UI reports failure and rebuilds from committed CRDT state
- **AND** no peer or reload observes the failed placement.

### Requirement: Column-scoped creation and transient notices

The system SHALL place the primary `Add {entityName}` action inside every expanded live column. Opening it SHALL preselect that column. The global header SHALL remain reserved for workspace-level navigation and settings. Successful-action notices SHALL render in a fixed overlay, support explicit dismissal, and disappear automatically. Save failures SHALL remain visible in the active form and SHALL retain pending-save state after the overlay expires.

#### Scenario: Add an item from a column

- **GIVEN** a board has multiple columns
- **WHEN** the user invokes `Add {entityName}` inside one column
- **THEN** the item form opens with that column selected
- **AND** no global add action occupies the desktop or mobile header.

#### Scenario: Notice disappears without moving layout

- **GIVEN** a workspace action succeeds
- **WHEN** its notice appears
- **THEN** the notice overlays board content without changing layout
- **AND** it disappears after a bounded interval or explicit dismissal.

### Requirement: Schema-driven board filters

The system SHALL derive filter controls and values from the active workspace schema. Columns SHALL provide the status choices. Select fields SHALL provide their live options by stable option ID and current title. Number fields SHALL provide bounded minimum/maximum controls; boolean and date fields SHALL provide controls matching their stored value types. Generic workspaces SHALL use the same filtering path as preset workspaces.

#### Scenario: Schema edits immediately change filters

- **GIVEN** a select field option is renamed without changing its ID
- **WHEN** workspace settings are applied
- **THEN** the filter shows the new title with the existing option ID
- **AND** no preset enum or label table overrides it.

#### Scenario: Generic field filters generic items

- **GIVEN** a generic workspace has a select field and items with different option IDs
- **WHEN** one option is selected in its generated filter
- **THEN** only items storing that option ID remain visible
- **AND** no job-search binding is required.

### Requirement: Complete workspace settings JSON

Workspace Settings SHALL provide Document templates and an advanced typed JSON view over all editable workspace configuration: workspace title, board title/entity name, columns, fields/options, and entity document templates. It SHALL exclude item data, identities, private keys, trust records, sync state, and native history. One apply SHALL call `updateWorkspaceSettings` and create one Automerge change.

#### Scenario: Human or agent applies complete settings

- **GIVEN** current settings and CRDT heads from UI or `get_workspace_settings`
- **WHEN** the complete draft is submitted through UI or `apply_workspace_settings`
- **THEN** both use the same validator and transaction boundary
- **AND** stable IDs remain, new IDs are allocated once, omissions archive typed configuration records, and reload preserves the result.

#### Scenario: Invalid or stale draft creates no change

- **GIVEN** a draft with an invalid `/board/entityName`, foreign record ID, unknown property, or stale expected heads
- **WHEN** apply is attempted
- **THEN** a precise JSON path or conflict error is returned
- **AND** settings, heads, relationships, item values, and document templates remain unchanged.

### Requirement: Entity document templates

The system SHALL store templates as generic `document_template` workspace-root entities containing stable ID, title, Markdown, placement, and `archivedAt`. It SHALL NOT require a CV/cover-letter/template-kind enum. Legacy `template` entities remain readable and editable.

#### Scenario: Template works without workspace-specific enum

- **GIVEN** any workspace
- **WHEN** a user creates an entity document template
- **THEN** it is available to operations that consume templates without declaring a stored template kind
- **AND** archiving remains reversible and preserves produced artifacts.

### Requirement: One editable narrative per card

The system SHALL present a card's description, legacy preset Notes, and attached inline notes as one editable Description. Opening the editor SHALL include all source text. Saving its draft or adding a quick note SHALL consolidate the sources atomically; the user MAY intentionally edit or remove text from the draft. File-backed notes and other real attachments SHALL remain attached documents. The card detail SHALL NOT expose a Reviewed action; edits and moves continue to update card activity.

#### Scenario: Legacy narrative sources are consolidated

- **GIVEN** a card has description text, preset Notes, and an attached plain-text note
- **WHEN** the user edits or appends to its Description
- **THEN** the saved draft remains in the editable Description after reload
- **AND** source note fields are retired in the same durable command

### Requirement: Configurable Rejected column and retrospective notes in Job search

The system SHALL provide a standard configurable Rejected column (`status.rejected`) and an optional retrospective note field (`field.rejectionReason`) within the Job search preset. Rejected SHALL remain an active business pipeline status distinct from Archive, retaining full card data, attachments, timestamps, and history without automatic archival.

#### Scenario: Moving a lead to Rejected with retrospective note persists across reload

- **GIVEN** a lead on the Job search board
- **WHEN** the lead is moved to the Rejected column and an optional retrospective note is entered
- **THEN** the card is displayed in the Rejected column
- **AND** reloading the page retains the card in Rejected with the retrospective note intact.
