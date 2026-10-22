## ADDED Requirements

### Requirement: Products share mechanisms without sharing resource authority
The ecosystem SHALL separate Identity, application resources and replica hosting.
Identity SHALL own person/device/profile/recovery rules through the shared MetaMesh
SDK. The independent portal SHALL consume that SDK. Tincanban SHALL own boards,
membership and publication; other applications SHALL own their service permissions.
Rusty SHALL own storage access and durable confirmations. No identity login SHALL
grant board ownership, service administration or access to unrelated private meshes.
Ordinary service login SHALL issue only a short-lived, origin-bound session proof.
Identity device certificates SHALL be identity-wide; each application SHALL decide
its own permissions and SHALL NOT infer app roles from certificate validity.
Product naming and a new visual design SHALL NOT be prerequisites for these contracts.

#### Scenario: A person enters another application
- **GIVEN** the person can authenticate through the portal
- **WHEN** they first enter TinSink or Reflux
- **THEN** the application verifies identity and separately checks its own permissions
- **AND** no board role or operator privilege follows solely from person identity.

#### Scenario: Device enrollment is separate from service login
- **GIVEN** an application verifies an ordinary session-only login proof
- **WHEN** the session is established
- **THEN** no device certificate, board grant or identity-management permission is
  created by that login
- **AND** separate explicit device enrollment and application authorization remain required.

### Requirement: Facts retain one owner and appropriate consistency scope
Domain modules SHALL own their valid transitions. Other modules MAY retain verified
proofs or projections without acquiring authority to mutate those facts. Shared CRDT
storage SHALL NOT make profile recovery, board membership and Rusty activation one
mandatory transaction. Job stages and application-source policy SHALL remain
product-owned while all consumers retain equivalent enforcement. Local forgetting,
archive, lost replica, revoked permission and public withdrawal SHALL remain distinct.

#### Scenario: Recovery encounters unavailable storage
- **GIVEN** recoverable identity or board data and unconfirmed Rusty access
- **WHEN** recovery validates and retains the available material
- **THEN** storage activation can remain pending without blocking data retention
- **AND** missing storage does not delete a board reference or withdraw a publication.
