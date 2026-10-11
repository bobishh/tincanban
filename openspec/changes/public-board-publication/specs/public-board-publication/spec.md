## ADDED Requirements

### Requirement: Explicit selected-board publication
The system SHALL allow a confirmed source owner with configured Keeper publication authority to publish one selected board through an explicit disclosure action. It MUST publish a strictly allowlisted projection and MUST NOT expose other boards, archived entities, private workspace metadata, unrelated files/global chat, identity records, credentials or CRDT history.

#### Scenario: Publish one board from a private workspace
- **GIVEN** an owner workspace contains two boards, attached documents, anchored discussions, unrelated private documents/global chat and storage credentials
- **WHEN** the owner confirms Publish for the first board
- **THEN** the publication contains only that board's active columns, fields, cards, their attached content and scoped discussions, including card bodies and published field values
- **AND** sentinel data from excluded content is absent from every publication request and anonymous response

#### Scenario: Editor cannot publish
- **GIVEN** the client has editor or unresolved source permissions
- **WHEN** publication management is attempted
- **THEN** the client blocks the action and does not upload a snapshot

### Requirement: Authenticated durable publication management
Keeper SHALL accept publication mutations only from its configured publication controller through verified device certificates and exact signed challenge-bound commands. Commands MUST bind origin/service, board ID, action, content hash, expected revision and expiration. Durable publication acknowledgement MUST follow atomic persistence. Publication-controller authority MUST be documented separately from private workspace ownership.

#### Scenario: Exact signed snapshot survives restart
- **GIVEN** an authorized controller and a valid publish command for revision zero
- **WHEN** Keeper accepts the snapshot and restarts
- **THEN** an anonymous read returns the exact acknowledged snapshot and revision

#### Scenario: Forged stale or replayed commands fail
- **WHEN** a mutation has a wrong controller, device certificate, origin, hash, signature, expired/reused challenge or expected revision
- **THEN** Keeper rejects it and preserves the last confirmed publication

### Requirement: Update and withdrawal are explicit
The system SHALL provide Update and Unpublish for confirmed publications. Private edits MUST NOT silently publish new content. The client MUST show pending/failure and MUST NOT claim success before a verified durable receipt. Withdrawal MUST prevent new anonymous reads, retain revision continuity and reject stale resurrection.

#### Scenario: Failed update preserves public content
- **GIVEN** a published board and a newer local edit
- **WHEN** the owner requests Update and persistence fails
- **THEN** the UI reports failure and anonymous readers retain the prior confirmed snapshot

#### Scenario: Unpublish invalidates later reads
- **GIVEN** a board was fetched successfully
- **WHEN** the owner unpublishes and receives a confirmed receipt
- **THEN** a fresh navigation or revalidated reload reports the publication unavailable
- **AND** an old update command cannot resurrect it

### Requirement: Anonymous read-only viewing
The frontend SHALL serve a published board at `/boards/<board-entity-id>` without enrollment, invitations, Visitor grants, audience records or online source devices. Public startup MUST NOT initialize the private app, local identity, Automerge or mesh. Search, card-body viewing, published discussion reading and attachment downloads SHALL work while mutation and discussion posting controls remain absent. Existing private Visitor invitations MUST remain available.

#### Scenario: Fresh anonymous mobile reader
- **GIVEN** a fresh browser has no profile or local workspace and the source owner devices are offline
- **WHEN** it navigates to the published board URL and reloads
- **THEN** the confirmed board is readable with search, card inspection, discussions and attachment downloads
- **AND** no identity/workspace is created, no mesh connection or policy/transport WASM starts, and no Visitor badge or write controls appear

#### Scenario: Public reads fail clearly
- **WHEN** the publication is missing, withdrawn, malformed or its Keeper is unavailable
- **THEN** a distinct unavailable/error state with appropriate retry appears without creating a private workspace

### Requirement: Optional content-free view events
When deployment diagnostics are enabled and not opted out, the frontend SHALL emit at most one public-view event per successful public navigation through the existing ingestion contract. Viewer person/device/workspace identifiers MUST remain empty. No card content, titles, field values, credentials or raw errors SHALL be sent, and analytics delivery MUST NOT block viewing.

#### Scenario: A view never waits for analytics
- **GIVEN** the collector withholds acknowledgement or returns an error
- **WHEN** a public board renders
- **THEN** the board remains immediately usable and no mesh audience is created
- **AND** the event contains only allowlisted public identifiers and operational attributes

#### Scenario: Analytics disabled
- **GIVEN** analytics are unconfigured or opted out
- **WHEN** a public board renders
- **THEN** no view event is sent

### Requirement: Blind storage remains private
Publication SHALL use its own durable namespace and APIs. Existing encrypted-object authentication, receipts, enrollment policies and refusal of unknown/legacy state MUST retain their behavior.

#### Scenario: A publication coexists with private ciphertext
- **GIVEN** a Rusty volume contains private encrypted objects and an explicitly published board
- **WHEN** the service restarts and an anonymous reader requests both
- **THEN** it serves only the publication anonymously and requires the existing storage authorization for ciphertext objects
- **AND** unrecognized filesystem entries still prevent startup rather than being silently accepted

### Requirement: Scoped public discussions
The projection SHALL include valid stored discussion threads anchored to the selected published board/cards/fields and their valid replies. It MUST exclude unrelated/global chat and private reference expansion. Author display labels MAY be published as discussion content; workspace/person/device IDs, source message IDs containing device IDs, signatures, certificates and participant profiles MUST NOT be exported. Public thread/reply identifiers MUST be opaque and consistent within the snapshot. Anonymous viewers MUST NOT be able to post messages.

#### Scenario: Publish selected card discussion with replies
- **GIVEN** a published card has an anchored thread with replies and another board has a private discussion
- **WHEN** the owner publishes the selected board
- **THEN** the public card shows its thread, author display labels and ordered replies
- **AND** private discussion sentinels and identity-bearing source IDs are absent from requests and responses

#### Scenario: Private references do not disclose content
- **GIVEN** a selected discussion references both a published card and an unpublished card or private field
- **WHEN** the public projection is built
- **THEN** only published references remain navigable and private reference/selection data is excluded
- **AND** public rendering never fetches or resolves private content

### Requirement: Complete independent public attachments
Publishing SHALL include active attached documents/files belonging to the selected board or published cards as independently stored public copies. Private transport references, local paths, tickets, credentials and access keys MUST NOT be disclosed. Every manifest file MUST have verified bytes, digest, size, safe name and media type before durable publication acknowledgement. Anonymous file access MUST require a current active publication revision and manifest reference, with safe download headers and no-store semantics.

#### Scenario: Download survives author shutdown and Keeper restart
- **GIVEN** a selected card has an available attachment and a different board has a private file
- **WHEN** the owner publishes, closes the browser and Keeper restarts
- **THEN** an anonymous reader downloads the exact selected attachment bytes from Keeper
- **AND** private file bytes and original storage references remain inaccessible

#### Scenario: Missing file fails before successful publication
- **GIVEN** a selected attachment cannot be retrieved through its authorized source mechanism
- **WHEN** the owner attempts Publish or Update
- **THEN** the UI identifies the unavailable attachment and does not claim publication success
- **AND** any previous confirmed publication remains readable

#### Scenario: Staging does not expose unconfirmed files
- **GIVEN** a signed asset upload succeeds but manifest activation fails or is interrupted
- **WHEN** an anonymous reader requests that staged asset
- **THEN** Keeper refuses the download and preserves the previous confirmed manifest
- **AND** the controller can retry idempotently without exposing a partial publication

#### Scenario: Update and withdrawal revoke subsequent file reads
- **GIVEN** a reader fetched a publication and its attachment URL
- **WHEN** a confirmed update removes the attachment or the owner unpublishes
- **THEN** new requests for the old revision and unreferenced file fail
- **AND** stale upload/commit commands cannot resurrect the withdrawn publication
