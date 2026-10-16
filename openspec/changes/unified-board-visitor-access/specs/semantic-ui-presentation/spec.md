## ADDED Requirements

### Requirement: Typography follows semantic content roles
Shared UI components SHALL explicitly identify heading/navigation/board-summary, prose/input/explanation, concise metadata and technical-value roles. Font family, size and spacing MUST derive from those roles rather than access mode, incidental DOM nesting or string-pattern heuristics. Caveat SHALL remain on the handwritten board and UI; prose and long explanations SHALL use compact Fira Sans; application-supplied machine identifiers SHALL use subordinate Fira Code. Public and private visitor presentation MUST agree.

#### Scenario: Mixed content in a card and discussion
- **GIVEN** a card/discussion has a heading, body, ordinary source link, quick-note input, author and application-supplied checksum
- **WHEN** it is rendered through the shared UI
- **THEN** the text uses its declared semantic roles consistently
- **AND** the checksum is monospaced, prose remains compact, and the surrounding board keeps its handwritten appearance

#### Scenario: Empty or failing content
- **GIVEN** original-posting evidence is pending, attachments are empty or a connection has failed
- **WHEN** the UI shows its status/explanation
- **THEN** the same prose/metadata rules apply as for populated content
- **AND** an implementation-specific error is not hidden or presented as successful delivery

### Requirement: Readable history attribution and actions
History SHALL show an available verified person's display name as its primary author label and readable action labels for known operations. Raw person/device/actor IDs, change hashes and operation keys MUST remain intact and available under technical details with copy access. Missing, imported, system and archived/unverified attribution MUST remain distinguishable; labels MUST NOT determine authorization or fabricate verified attribution.

#### Scenario: A known person made a change
- **GIVEN** an admitted history entry has person/device IDs and an eligible profile name
- **WHEN** history is displayed
- **THEN** the person name appears instead of a concatenated full ID pair
- **AND** technical details retain the exact original IDs/hash and existing restore permissions

#### Scenario: Identity or attribution is unavailable
- **GIVEN** an entry is imported, system-generated or has no verified name binding
- **WHEN** history is displayed
- **THEN** a truthful imported/system/unknown or unverified label appears
- **AND** the UI neither guesses a name nor disguises a raw identifier as one

### Requirement: Boundaries communicate hierarchy and interaction
Card-detail and settings surfaces SHALL use a single window outline, visible input/button boundaries and coherent section headings/spacing. They MUST NOT accumulate decorative frames around every section, form, history row and scroll container. Dividers MUST separate meaningful peer regions and adapt when the inspector stacks on narrow screens. Focus indication MUST identify the focused interactive target.

#### Scenario: Description properties documents and history
- **WHEN** a detail containing prose, properties, files, history and a quick-note form opens at desktop or phone width
- **THEN** each section has an understandable heading/grouping without redundant nested outlines
- **AND** the textarea, action controls, scrolling and keyboard focus remain visible and usable

#### Scenario: Inspector layout changes
- **GIVEN** properties appear beside the description in a wide window
- **WHEN** the window narrows and the inspector stacks with the content
- **THEN** a former vertical separator does not remain as an unexplained line
- **AND** consistent spacing or a meaningful section separator preserves the hierarchy
