## ADDED Requirements

### Requirement: Separate person device and actor identities

The system SHALL persist public identity and device registrations in a private personal-root document, keep private keys in device-local storage, and give independent Automerge writers distinct actor IDs. Person/device identities SHALL be bound through verified certificate chains, not asserted display metadata.

#### Scenario: Fresh installation creates a local identity

- **GIVEN** no local profile exists
- **WHEN** the application initializes
- **THEN** it creates person/device keys, an initial device certificate, and a personal root without a hosted account
- **AND** new workspace ownership refers to that stable person ID
- **AND** no private key is present in CRDT documents or workspace bundles.

#### Scenario: Two tabs preserve one device and separate writers

- **GIVEN** two tabs open the same local profile
- **WHEN** each edits the same workspace
- **THEN** both changes identify the same person/device and different actor IDs
- **AND** both remain valid after synchronization.

### Requirement: Own-device enrollment is explicit and durable

The system SHALL authorize another own device through a one-time typed invitation and source-device approval, issue a device certificate bound to its newly generated key, and share the private root only after verification. It SHALL NOT copy the identity private key or merge an existing different identity automatically.

#### Scenario: Owner approves a second device

- **GIVEN** A's device J issues an enrollment invite and fresh device K opens it
- **WHEN** K requests connection and J approves the matching authentication code/device
- **THEN** K receives a certificate for person A and its own device key
- **AND** K gains the private root and complete-sync scope
- **AND** after reload K remains registered without another invitation.

#### Scenario: Enrollment is still awaiting approval

- **GIVEN** a new device has requested enrollment
- **WHEN** the source has not approved it
- **THEN** both screens show pending approval
- **AND** no private root, workspace names, or workspace bytes are released.

#### Scenario: Existing different identity is preserved

- **GIVEN** K already has another populated personal profile
- **WHEN** K opens A's device enrollment invitation
- **THEN** it receives identity_conflict with a clear explanation
- **AND** its keys, workspaces, and identity remain unchanged.

### Requirement: Workspace grants do not expose personal roots

The system SHALL require an owner-signed grant for editor access to one workspace. Grants SHALL preserve the recipient's identity and SHALL NOT imply enrollment, access to unrelated workspaces, or permission to issue grants.

#### Scenario: Person B joins A's workspace

- **GIVEN** A owns private workspace X and shared workspace Y
- **WHEN** B accepts A's invitation for Y
- **THEN** B retains B's identity and receives Y plus its history/public author proofs
- **AND** B receives neither A's root nor the ID/title/content of X
- **AND** B's edits are attributed to B's device.

#### Scenario: Editor cannot grant access

- **GIVEN** B has editor access to Y
- **WHEN** B attempts to issue an owner grant, enroll a device as A, or edit grant records through content commands
- **THEN** the operation fails permission validation before a trusted change is saved.

### Requirement: End-to-end authorship survives relay

The system SHALL verify genesis descriptors, certificate chains, actor bindings, membership, and per-change signatures before trusted merge. Proofs SHALL be retained with changes and exported as public evidence. Unverified content SHALL never acquire a verified author label.

#### Scenario: Tampered actor claim is rejected

- **GIVEN** a peer sends a change claiming another person's actor or alters signed bytes
- **WHEN** the receiving service validates it
- **THEN** the change remains outside the trusted document and no UI mutation is published
- **AND** a typed verification failure is shown.

#### Scenario: Missing proof is pending rather than committed

- **GIVEN** a valid-looking change arrives before its certificate/proof dependency
- **WHEN** the peer has not supplied that dependency
- **THEN** the receiver keeps bounded pending data and requests the proof
- **AND** no durable-success acknowledgement is sent for an unverified change.

### Requirement: Access lifecycle labels match implemented guarantees

The system SHALL support expiry/cancellation of unused invitations and local disconnection. It SHALL NOT advertise distributed grant revocation, remote erasure, or private-key recovery in this version.

#### Scenario: Local disconnect preserves remote data

- **GIVEN** two participants have synchronized a workspace
- **WHEN** one disconnects locally
- **THEN** its connection stops and both retained copies remain readable
- **AND** the UI does not claim the other's access or stored data was erased.
