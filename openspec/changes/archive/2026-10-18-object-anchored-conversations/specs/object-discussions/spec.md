## ADDED Requirements

### Requirement: Contextual Discuss composer

The system SHALL expose Discuss beside selected text and through an application context menu for items and fields. Right click on those sources SHALL suppress the browser context menu. Board cards SHALL expose a compact SVG chat action on hover or keyboard focus, and continuously on touch devices. Item detail windows SHALL NOT contain permanent Discuss buttons. The chosen anchor SHALL attach to the composer, which accepts a message with optional explicit participant mentions. Desktop, touch, and keyboard paths SHALL remain available.

#### Scenario: Discuss selected text
- **GIVEN** an item field contains selectable text
- **WHEN** the user selects a passage, activates Discuss, and submits a message
- **THEN** one committed message appears in the workspace log and item conversation with a quote chip for that passage.

#### Scenario: Whole-item discussion on tablet
- **GIVEN** a board card is visible at a tablet viewport
- **WHEN** the user taps its chat icon
- **THEN** a reachable composer opens with a whole-item reference without requiring text selection or right click.

#### Scenario: Persistence failure retains context
- **GIVEN** a composer contains text, an anchor, and a reply target
- **WHEN** its durable write fails
- **THEN** the draft and context remain with a visible error and retry action
- **AND** no committed message or send-success event is published.

### Requirement: One signed message across conversation views

The system SHALL store body, bounded references, mentions, and reply metadata in one immutable signed message. Conversation views SHALL project the workspace log without duplicating records. Existing plain messages SHALL remain readable. Metadata SHALL obey signature, authorization, record-size, retention, and import-idempotency rules.

#### Scenario: Message references two items
- **GIVEN** a composer references two items in the same workspace
- **WHEN** its message commits
- **THEN** the same message ID appears once in each item discussion and once in the workspace log
- **AND** reload and peer sync preserve both references.

#### Scenario: Tampered reference is rejected
- **GIVEN** a contextual message has been signed
- **WHEN** a received record changes an anchor or reply target without a valid signature
- **THEN** import rejects the record and no view displays it as accepted.

#### Scenario: Unsupported peer schema
- **GIVEN** a peer cannot read the contextual payload schema
- **WHEN** a person sends a contextual message
- **THEN** the signed message is saved locally without requiring an online or upgraded peer
- **AND** synchronization with that peer exposes an upgrade-required state and withholds the complete signed contextual record until compatible capability is negotiated
- **AND** context is not silently stripped or downgraded.

### Requirement: Mentions invite workspace participants

The system SHALL resolve explicitly selected mentions to stable person IDs. A mention SHALL invite attention within existing workspace visibility and SHALL NOT define private delivery or grant access. Notification eligibility SHALL follow existing policy and SHALL be deduplicated across views and tabs. Read-only users SHALL NOT send contextual messages.

#### Scenario: Mention participant in item discussion
- **GIVEN** a workspace participant is selected through mention completion
- **WHEN** the contextual message commits
- **THEN** the mention records that person's stable ID and the message remains visible in the workspace log
- **AND** eligible notification is produced at most once through existing notification policy.

#### Scenario: Visitor attempts contextual send
- **GIVEN** workspace access is read-only
- **WHEN** the user opens an item discussion
- **THEN** references remain navigable and write controls remain unavailable.

### Requirement: Replies share roots and remain globally visible

The system SHALL retain the immediate reply target and normalize the conversation root. Reply-to-reply SHALL render at one reply level with an immediate-target quote. All committed replies SHALL remain in the global log. Missing ancestors SHALL render unavailable context without preventing valid out-of-order import; self references, cycles, and inconsistent root membership SHALL NOT create misleading conversation groups.

Reply from the workspace log or an item discussion SHALL open or focus a separate root thread with the immediate reply target attached. Every committed message SHALL expose an Open thread action. Reply within a root thread SHALL retain that window and root.

The workspace log SHALL show reply counts beside roots and a collapsed-by-default, read-only reply preview. Expanding the preview SHALL reveal replies without an editor; Open on a previewed reply SHALL focus that reply in the same chat-style thread window. Retained replies whose root is unavailable SHALL remain directly visible with unavailable context.

#### Scenario: Reply to reply
- **GIVEN** a root message has a reply
- **WHEN** the user replies to that reply
- **THEN** the new message renders as another child of the original root with a quote of its immediate target
- **AND** it appears once in the global log.

#### Scenario: Parent absent from retained history
- **GIVEN** a valid signed reply arrives before its parent or after the parent was pruned
- **WHEN** the reply is imported
- **THEN** its body remains visible with unavailable reply context
- **AND** a later available parent resolves the quote without duplicating the reply.

### Requirement: Safe source navigation

The system SHALL resolve item/field identity independently of display titles and highlight only a verified captured range or unique contextual match. Changed, ambiguous, and deleted sources SHALL retain the captured quote with an explicit state.

#### Scenario: Source renamed and text shifted
- **GIVEN** a referenced item was renamed and text was inserted before its uniquely identifiable passage
- **WHEN** the user activates its quote chip
- **THEN** the owning item and field are focused and the matching passage is highlighted.

#### Scenario: Passage became ambiguous or unavailable
- **GIVEN** the referenced passage no longer has a unique contextual match or its field was deleted
- **WHEN** the user activates the reference
- **THEN** the original quote remains visible with changed-source or unavailable-source feedback
- **AND** no unrelated text is highlighted.
