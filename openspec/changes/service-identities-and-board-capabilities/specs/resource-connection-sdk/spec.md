## ADDED Requirements

### Requirement: Shared resource connection protocol
The system SHALL expose resource connection through meta-mesh SDKs using the shared core identity, pairing and authority rules. Product UI SHALL call this SDK rather than implementing a private authorization protocol.

#### Scenario: External application requests a board
- **GIVEN** an external node with its own persistent identity
- **WHEN** its Connect board action requests access
- **THEN** the resource issuer displays the exact subject, resource, capabilities, read disclosure and expiry before signing a grant
- **AND** the external node reports Connected only after authenticated activation acknowledgement

#### Scenario: Registering a resource grants no access
- **GIVEN** a caller registering a resource descriptor
- **WHEN** another identity requests an operation
- **THEN** descriptor registration alone SHALL NOT authorize that operation

### Requirement: Bound and revocable grants
The system SHALL bind grants to issuer, subject, resource, audience, capabilities, expiry and authority epoch, and SHALL validate current authorization before privileged work or cached-result disclosure.

#### Scenario: A copied invitation or stale grant is presented
- **GIVEN** a consumed, expired, revoked, wrong-audience or other-subject invitation/grant
- **WHEN** activation or an operation is attempted
- **THEN** access is denied without creating another identity or revealing bootstrap secrets

### Requirement: Connection codes are not identity keys
The CLI setup flow SHALL redeem a single-use connection code through the same subject-bound protocol and SHALL NOT require the owner's private identity key.

#### Scenario: Initializing an existing node
- **GIVEN** a node with a retained identity and an owner-approved connection code
- **WHEN** node initialization redeems the code
- **THEN** the existing node identity is retained and private resource material is delivered only to that subject

### Requirement: Reading scope is truthful
The system SHALL NOT describe a connection as board-only or field-only reading if its delivered key decrypts a wider resource.

#### Scenario: Selected board shares a workspace encryption key
- **GIVEN** a selected board without isolated encrypted storage
- **WHEN** restricted reading is requested
- **THEN** the flow either provides genuinely isolated content or discloses/requires the actual wider scope; it SHALL NOT silently grant wider reading
