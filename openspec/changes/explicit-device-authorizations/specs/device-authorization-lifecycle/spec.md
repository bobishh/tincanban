## ADDED Requirements

### Requirement: Device identity and exact permissions have separate lifecycles
The SDK SHALL distinguish person, device key, authorization and board membership.
Each new explicit authorization SHALL carry a fresh signed ID and exact issuer,
subject, rights, resource and delegation power. Retries SHALL reuse their saved ID.
Withdrawal SHALL permanently target captured authorization IDs. Re-addition SHALL
issue new rights without restoring old ones or retargeting old jobs. Verification
SHALL select exact authorization provenance rather than first matching device key.
An Identity device certificate SHALL represent identity-wide device trust; it SHALL
NOT imply a particular application's role or application-scoped certificate
audience. Request origin and purpose MAY bind the enrollment consent ceremony, but
application permissions remain owned and checked by that application.
Issued descendant revocation scope SHALL be explicit; a withdrawn issuer SHALL NOT
mint accepted new descendants beyond its admitted frontier.

#### Scenario: Re-addition meets a delayed removal
- **GIVEN** authorization A was withdrawn and the same key later received B
- **WHEN** A's old removal job, approval or command arrives
- **THEN** A stays withdrawn, B is unaffected by the captured old job
- **AND** no operation originally signed under A acquires B's authority.

### Requirement: Person enrollment does not override resource governance
Board actions SHALL require valid person authorization, exact membership and
applicable board-device and owner/quorum rules. Self-device withdrawal SHALL NOT
require ownership of foreign boards. Enrollment/recovery SHALL NOT recreate removed
membership or bypass scoped device restrictions. Copied private keys SHALL NOT be
presented as distinguishable physical devices; compromise recovery SHALL require
fresh keys and reviewed affected authorizations.

#### Scenario: A member connects another device after board removal
- **GIVEN** a person was removed from a foreign board
- **WHEN** an authorized device or recovered root enrolls another device for that person
- **THEN** person enrollment can succeed without recreating board access
- **AND** the board owner's removal remains effective.

#### Scenario: Device enrollment does not grant application rights
- **GIVEN** a person approves a new device under their Identity
- **WHEN** that device presents its valid Identity certificate to an application
- **THEN** the certificate proves device membership under the person only
- **AND** the application separately checks its service and resource permissions.

### Requirement: Historical work retains its original causal authority
New commands SHALL bind exact actor authorization and membership evidence.
Historical admission SHALL retain original proofs/frontiers; renewed permission
SHALL NOT authorize rejected old signatures. Quarantined originals SHALL remain
available, and explicit reapplication SHALL create a new current command.

#### Scenario: Offline work arrives after rights change
- **GIVEN** a command under A lies outside its allowed causal frontier and B is current
- **WHEN** replicas converge
- **THEN** B does not admit that old command
- **AND** valid history and rejected original evidence remain retained.
