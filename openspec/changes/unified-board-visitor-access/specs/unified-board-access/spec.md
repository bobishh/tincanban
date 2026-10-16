## ADDED Requirements

### Requirement: One board with public visitor access
The system SHALL expose public access as a read-only access mode of the existing board, with the same board/card/column/field IDs and source content/settings. It MUST NOT create an independently editable publication board or require Publish Update, Update public copy, or content comparison actions. Enabling and disabling public access MUST require current owner authority.

#### Scenario: Enable access to the existing board
- **GIVEN** an owner has an existing private board
- **WHEN** the owner confirms public access
- **THEN** its stable board URL becomes readable with visitor capabilities
- **AND** no second board identity, editable copy or manual refresh workflow is created

#### Scenario: An editor changes an already public board
- **GIVEN** public access is enabled and an editor has valid board write authority
- **WHEN** that editor changes a card while Settings and all owner devices are closed
- **THEN** the normal admitted write automatically reaches the public visitor view
- **AND** the editor cannot change public access merely because it can edit cards

### Requirement: A single visitor rendering implementation
Public and invited visitors SHALL use the same board, card, details, discussion, file and responsive window components and presentation rules. Separate public HTML/templates/CSS for these surfaces MUST be removed. Adapters MAY differ by data transport and capability availability, but MUST NOT initialize a private workspace to obtain shared presentation.

#### Scenario: Compare public and invited visitor rendering
- **GIVEN** both readers observe the same board content, settings and viewport
- **WHEN** they read the board, filter cards, open a detail, read a thread and preview/download a file
- **THEN** the shared components produce the same layout, typography and visitor interactions
- **AND** no mutation is authorized by anonymous access

#### Scenario: Fresh anonymous reader
- **WHEN** a fresh browser opens a public board and a card discussion/file
- **THEN** it creates no identity, private workspace, participant or Visitor grant
- **AND** private IndexedDB, mesh, Automerge and policy/transport WASM do not start

### Requirement: Authoritative shared presentation settings
Both access modes SHALL honor the board's actual preset bindings, effective card values, column colors, archive/lifecycle visibility, independent collapsibility, stage controls and aging settings. Missing legacy settings MUST be obtained from admitted source state, not inferred from column titles. Local folded state SHALL follow the same visitor defaults and remain a per-viewer preference.

#### Scenario: Two independently collapsible columns
- **GIVEN** the board enables collapse for two columns and disables it for another
- **WHEN** a public or invited visitor opens the board
- **THEN** each permitted column has the same collapse/expand behavior and the other has none
- **AND** filtering temporarily reveals matching cards without changing the saved board settings

#### Scenario: A board setting changes
- **GIVEN** a public reader has the board open
- **WHEN** an authorized writer changes a column's collapse capability or color
- **THEN** the same setting reaches the open visitor view automatically
- **AND** no independent public setting or manual publication update is needed

### Requirement: Durable automatic public delivery
Every authorized source mutation path, including editor and approved automation writes, SHALL durably schedule conditional delivery to the public serving representation. Delivery MUST bind board ID, admitted source state and current access generation, preserve coherent settings/content/file manifests, resume after interruption and reject stale overwrite or resurrection. Local save and confirmed public delivery MUST remain distinct states. Owner Settings/tab availability MUST NOT be required.

#### Scenario: Automation updates with owners offline
- **GIVEN** an approved automation can update a public board and no owner browser is running
- **WHEN** it commits an authorized card transition
- **THEN** public readers receive that transition through the ordinary delivery path
- **AND** no manual owner publication command is involved

#### Scenario: Interrupted delivery
- **GIVEN** a public delivery acknowledgement is lost or the writer restarts
- **WHEN** synchronization resumes
- **THEN** the same pending source state is recovered or superseded by an admitted containing state
- **AND** retries create no duplicate card and cannot replace newer confirmed board state with stale content

#### Scenario: Public delivery is pending
- **GIVEN** local changes are saved but a network/file dependency prevents complete public delivery
- **WHEN** the writer or reader reports synchronization status
- **THEN** it distinguishes saved, pending and failed delivery without claiming the public view is current
- **AND** local offline editing and the last coherent confirmed read remain available

### Requirement: Continuous reader updates and withdrawal
Visible public readers SHALL revalidate at least every five seconds when no subscription is active and immediately on focus/reconnect. New admitted state SHALL update the shared view in place. Confirmed withdrawal MUST block subsequent board/file reads and clear open reader content/windows upon revalidation, even while an older delivery retries.

#### Scenario: Update without reloading the page
- **GIVEN** a reader has a search and a detail window open
- **WHEN** revalidation receives a changed board state
- **THEN** changed cards/settings render without a page reload
- **AND** existing local view state is preserved for objects that remain present

#### Scenario: Withdrawal defeats a delayed writer
- **GIVEN** a reader and a pending public delivery exist
- **WHEN** the owner disables public access and receives durable confirmation
- **THEN** new anonymous reads fail and the reader clears content on its next revalidation
- **AND** the delayed delivery cannot enable access again

### Requirement: Scope isolation and existing-board migration
Public read access SHALL expose only visitor-visible data within the selected board's authorized public scope. Other boards, private workspace-wide data, identity secrets and transport credentials MUST remain private. Existing public board IDs and links MUST survive migration; no private board may become public as a side effect.

#### Scenario: Legacy public data lacks settings
- **GIVEN** an existing public board record lacks preset/collapse metadata
- **WHEN** the actual admitted source board becomes available to authorized delivery
- **THEN** its real settings replace the incomplete serving data automatically under the same board ID
- **AND** the owner is not required to recreate or manually republish the board

#### Scenario: Selected-board isolation
- **GIVEN** a workspace contains a public board and another private board
- **WHEN** any writer synchronizes public content or an anonymous reader follows a reference
- **THEN** unrelated board/chat data, credentials, private history evidence and private file locators remain inaccessible
