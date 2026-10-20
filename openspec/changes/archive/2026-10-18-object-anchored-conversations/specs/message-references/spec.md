## ADDED Requirements

### Requirement: Copy stable committed-message link

The system SHALL expose Copy message link for durably committed messages using a versioned reference to canonical workspace chat scope and immutable message ID. Links SHALL survive local workspace rekeying and SHALL contain no message body, grants, invitation secrets, or private keys. The action SHALL explain that the workspace must already be available on the receiving device.

#### Scenario: Copy committed message
- **GIVEN** a message has committed to the chat journal
- **WHEN** the user copies its message link
- **THEN** clipboard success is reported only after the write succeeds and the URL identifies its scope and message ID.

#### Scenario: Clipboard denied
- **GIVEN** clipboard permission is denied
- **WHEN** the user activates Copy message link
- **THEN** a selectable URL fallback appears with failure feedback rather than false copied feedback.

#### Scenario: Message still saving
- **GIVEN** a message has only a temporary pending UI ID
- **WHEN** its actions are displayed
- **THEN** Copy message link remains unavailable until durable commit.

### Requirement: Navigate known local message references

The system SHALL validate reference version/shape and resolve chat scope through authorized known workspaces. It SHALL select the workspace, focus an existing or new relevant conversation/chat window, and reveal/highlight the exact retained message even outside the initial rendered history. Startup and in-app navigation SHALL preserve deployment base paths and existing invitation/login routes.

#### Scenario: Open older linked message
- **GIVEN** a known workspace contains a linked message older than the initial 100 rendered messages
- **WHEN** the user opens its URL
- **THEN** its workspace and relevant conversation/chat window open and the exact message becomes visible and highlighted
- **AND** merely loading other messages does not mark them read.

#### Scenario: Local workspace rekeyed
- **GIVEN** a message link was copied before local workspace rekeying
- **WHEN** the link is opened after rekeying
- **THEN** the preserved canonical chat scope resolves the same retained message.

#### Scenario: Invalid reference
- **GIVEN** a URL contains malformed or unsupported reference data
- **WHEN** the application processes it
- **THEN** visible invalid-link feedback appears without mutating workspace data or granting access.

### Requirement: Honest unavailable and loading states

The system SHALL distinguish loading, unknown workspace, unavailable retained message, and blocked access. Unknown scope SHALL NOT imply automatic workspace download or discovery. Existing join/import controls MAY be offered, with unresolved target retained for retry after successful access. Reference navigation SHALL NOT bypass existing access checks or expose revoked cached content.

#### Scenario: Unknown workspace
- **GIVEN** no authorized local workspace matches the reference scope
- **WHEN** the link opens
- **THEN** Workspace unavailable appears with existing join/import entry points
- **AND** no workspace is fabricated or silently selected by title.

#### Scenario: Workspace becomes available
- **GIVEN** an unresolved message target is retained
- **WHEN** the user imports or joins its workspace through existing flows and retries
- **THEN** the target is resolved using current authorization and retained chat history.

#### Scenario: Target missing after load
- **GIVEN** the workspace is known but the message is absent from retained history
- **WHEN** chat loading completes
- **THEN** Message unavailable appears without claiming confirmed deletion or generating a replacement message.

#### Scenario: Chat loading is pending
- **GIVEN** local chat loading has not completed
- **WHEN** its message link is opened
- **THEN** the window shows a pending state instead of prematurely claiming Message unavailable.

#### Scenario: Access revoked
- **GIVEN** referenced workspace access is revoked or blocked
- **WHEN** its message link opens
- **THEN** access feedback appears and cached message content is not exposed through navigation.
