## ADDED Requirements

### Requirement: A request during a pass runs again immediately
The replica scheduler SHALL start another pass when a sync request arrives while a pass is running. That follow-up MUST start when the current pass finishes. A pass that finishes still catching up SHALL start at most two immediate follow-up passes.

#### Scenario: Local edit during a pass
- **WHEN** a replica pass is running and the local board changes
- **THEN** another pass starts when the current pass finishes, without waiting for the poll interval

#### Scenario: Pass is still catching up
- **WHEN** a replica pass finishes still catching up and no further edit arrives
- **THEN** an immediate follow-up pass starts

### Requirement: Visibility starts a pass
Showing the document or the page starting to hide SHALL start a replica pass immediately. The visible fallback poll MUST be two seconds. The hidden fallback poll MUST be fifteen seconds.

#### Scenario: Document becomes visible
- **WHEN** the document becomes visible and a replica is configured
- **THEN** a replica pass starts without waiting for the previous poll interval

#### Scenario: Fallback delay follows visibility
- **WHEN** the fallback poll delay is chosen
- **THEN** a visible document uses a shorter delay than a hidden document

### Requirement: Document-only edits upload changes
After a full snapshot of an Automerge board, an ordinary upload that changes only the document and its signed change records SHALL seal the Automerge changes and MUST NOT seal the whole document. A change to chat, authority policy, attachments, or history SHALL still upload a full snapshot. An unchanged board MUST NOT upload again. A stored full snapshot MUST remain readable.

#### Scenario: Title change after a snapshot
- **WHEN** an Automerge board has been uploaded and only its document then changes
- **THEN** the next upload is a document-changes object and an unchanged repeat uploads nothing

#### Scenario: Chat change
- **WHEN** chat changes after an Automerge upload
- **THEN** the upload is a full snapshot

### Requirement: Changes apply onto the current document
A document-changes object SHALL be applied to the current local document and then merged. It MUST NOT start history admission. A snapshot that contains a document field SHALL keep the existing merge path.

#### Scenario: Pull a document-changes object
- **WHEN** a replica pull downloads document changes whose dependencies are in the local document
- **THEN** the merged document contains those changes and history admission is not invoked

### Requirement: Browser and Worker share the payload contract
Browser and automation readers SHALL decode version 3 document changes through the same product-owned codec, then verify signed causal authority through their existing admission paths. Missing change dependencies MUST prevent merging and cursor acknowledgement. Replayed changes MUST preserve concurrent local edits. A Worker with an admitted compact basis SHALL accept an ordinary descendant snapshot without another history descriptor.

#### Scenario: Signed owner edit reaches automation
- **GIVEN** an owner has archived history and the Worker has admitted that basis
- **WHEN** the owner sends an ordinary edit and its current signed change records through Rusty
- **THEN** the Worker admits the edit and continues its scoped intake without another history publication

#### Scenario: Change dependencies are unavailable
- **WHEN** a document-changes object depends on a change absent from the receiver
- **THEN** the receiver rejects before merging and keeps its previous replica cursor
