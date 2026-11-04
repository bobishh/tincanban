## ADDED Requirements

### Requirement: Ordinary replica upload omits history
An ordinary workspace replica upload SHALL carry the current document, its authorization, chat, and any attachment locators. It MUST NOT include a stored history baseline. Unchanged content MUST keep the existing short-circuit that avoids a repeated upload.

#### Scenario: Card edit with a published baseline
- **WHEN** a workspace has a stored history baseline and an ordinary replication push runs after a document change
- **THEN** the uploaded snapshot contains the new document and does not contain that history baseline

#### Scenario: Unchanged ordinary snapshot
- **WHEN** an ordinary replication push runs and the document, authorization, chat, and attachment locators are unchanged
- **THEN** no new replica object is uploaded

### Requirement: History publication stays on the checkpoint path
A history storage checkpoint SHALL include the history baseline it publishes. Replica-object compaction SHALL retain a published history baseline in the compacted head. An ordinary document upload MUST NOT be the publication of that baseline.

#### Scenario: History checkpoint
- **WHEN** a history storage checkpoint is published for a baseline
- **THEN** the checkpoint snapshot contains that baseline

#### Scenario: Compaction after ordinary uploads
- **WHEN** retained replica objects are compacted and a history baseline is already published
- **THEN** the compacted head contains that baseline

### Requirement: Receive follows the snapshot contents
The receiver SHALL admit history before acknowledging a replica object that contains a history baseline. History admission failure MUST leave the replica cursor unchanged. A replica object without a history baseline SHALL merge its document as the current board and MUST NOT start history admission.

#### Scenario: Stored object still contains history
- **WHEN** a replica pull downloads an object whose snapshot contains a history baseline and history admission fails
- **THEN** the replica cursor stays at the previous value

#### Scenario: History admission later succeeds
- **WHEN** the same history-bearing object is pulled again and history admission succeeds
- **THEN** the replica cursor advances past that object

#### Scenario: Current card snapshot has no history
- **WHEN** a replica pull downloads an ordinary snapshot that has no history baseline
- **THEN** the document is merged and history admission is not invoked

### Requirement: Board loading uses the merged document
Board loading SHALL finish for a workspace whose current document was merged from replica storage. It MUST NOT start a same-person history transfer solely because the ordinary snapshot omitted a history baseline. A missing document or a failed document pull SHALL still be able to recover from an approved peer.

#### Scenario: Phone already has the merged board
- **WHEN** identity board loading pulls an ordinary snapshot and the current document merges
- **THEN** board loading completes without a same-person history transfer

#### Scenario: Stored copy is missing
- **WHEN** identity board loading cannot retain the current document from replica storage and an approved peer is provided
- **THEN** board loading may recover that document from the peer
