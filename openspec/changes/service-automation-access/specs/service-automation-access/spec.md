## ADDED Requirements

### Requirement: Standing workspace approval

An authorized workspace owner SHALL be able to approve the exact existing
service identity, workspace, board, definition and permissions until access
is explicitly withdrawn or its owner authority is superseded. The service
SHALL prove possession of that identity. Approval SHALL distinguish any
workspace-wide reading access from the exact allowed writes.

#### Scenario: Service continues after the original 30-day boundary
- **GIVEN** the owner approved standing access and has since gone offline
- **WHEN** Job Hunt runs beyond the original 30-day boundary
- **THEN** the same participant obtains fresh credentials, reads the board,
  and publishes only the approved writes

#### Scenario: Renewing access cannot change its scope
- **WHEN** the worker requests credentials for another identity, board,
  definition, authority, or permission
- **THEN** issuance fails and the prior approval remains intact

### Requirement: Automatic credential renewal

The system SHALL issue short-lived credentials bound to the approved
participant and the current authority generation. The runtime SHALL renew
them before use whenever remaining validity is insufficient, without a
browser session, owner signing key, reconnect, or renewal control. Operators
SHALL be able to distinguish transient issuer failure from denied authority.

#### Scenario: Renewal is interrupted
- **GIVEN** an approved participant and an unavailable credential issuer
- **WHEN** no usable credential remains
- **THEN** protected work fails closed with a retryable cause
- **AND** the next eligible retry after recovery renews the credential with
  the same participant and work identity

#### Scenario: Credentials expire during a scheduled run
- **WHEN** a scheduled run starts with valid credentials and reaches a later
  board operation after their expiry
- **THEN** the runtime refreshes access before that operation and does not
  repeat a committed write

### Requirement: Upgrade the existing connection in place

An owner SHALL be able to convert an existing approval, including an expired
one, through the normal connection flow. Migration SHALL retain the existing
participant and definition, board data, pending work and deduplication state.
Legacy approval SHALL retain its signed expiration unless the owner
explicitly approves standing access.

#### Scenario: Upgrade an expired participant
- **GIVEN** Reflux reports that the existing Job Hunt board approval expired
- **WHEN** the owner reviews and approves standing access for that connection
- **THEN** the existing participant gains a valid credential under the
  approved scope without creating a replacement participant

#### Scenario: Activation is retried after losing the response
- **WHEN** the owner retries the same approved upgrade after the service
  committed it and the response was lost
- **THEN** the connection retains the same identity and authority generation
  and reports the already committed upgrade

#### Scenario: Existing storage credentials cannot bypass service authorization
- **GIVEN** a board uses a shared storage bearer and accepts signed device requests
- **WHEN** Rusty registers the first standing service principal for the board
- **THEN** Rusty requires a signed device request at that scope for all reads and writes
- **AND** authorized board devices retain the same scope, content keys, and history
- **AND** the old bearer alone remains unusable after restart and withdrawal

### Requirement: Verified connection status

Reflux SHALL show the current access state and its latest verification time.
The status SHALL distinguish a ready connection, required owner approval,
renewal trouble, expired access, verified revocation and unavailable or stale
evidence. A stored integration flag SHALL NOT establish readiness.

#### Scenario: Integration is enabled while access is unusable
- **WHEN** the connection is enabled and the runtime verifies legacy expiry,
  revocation, or an unavailable issuer
- **THEN** Reflux shows the corresponding access state and does not show
  the board as ready on the strength of the integration flag

#### Scenario: Status recovers on the next successful refresh
- **WHEN** automatic refresh verifies usable access again
- **THEN** Reflux shows the connection as ready with a fresh verification time
  and no change to its connection identity
