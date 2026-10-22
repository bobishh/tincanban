## ADDED Requirements

### Requirement: Local use precedes optional account onboarding
Tincanban SHALL keep local boards immediately usable without a portal, profile
form, recovery acknowledgement or network. SDK local signing state MAY be created
automatically. Optional sign-in and profile-creation actions SHALL be available
without delaying first use. Explicit profile creation SHALL retain the current
local person ID and board data, and enroll a new portal device under that person.
The portal SHALL NOT create a second root for the same flow. Profile creation
SHALL NOT publish board content or change a foreign board's ownership. Product
branding and final action wording are outside this contract.

#### Scenario: Local work becomes a portal-connected profile
- **GIVEN** a fresh local board with edits under its automatically created identity
- **WHEN** its user completes profile creation
- **THEN** the same person and original board data remain
- **AND** the portal adopts its own device key under that person without creating
  a new identity root.

### Requirement: New sharing waits for registration and authority checks
A new local identity without a portal-connected profile SHALL complete the
applicable same-person device enrollment before issuing new device or participant
invitations or starting first public publication. Cancellation or failure SHALL
retain local work and send no invitation, grant or public delivery. Success SHALL
resume only the captured action after rechecking current identity, board and
management authority. Participant invitations SHALL retain the recipient's
identity and issue only valid board rights. Local open/edit/save and existing
supported shared-board access and enrollment paths SHALL remain usable during
staged adoption.

#### Scenario: Device or participant addition starts from a local-only profile
- **GIVEN** an edited local board and no portal-connected profile
- **WHEN** its user chooses device/participant addition or first public sharing
- **THEN** same-person enrollment precedes the action and success resumes its
  explicit approval flow
- **AND** cancellation, changed board authority or failure issues no invitation,
  grant or publication.

#### Scenario: Sign-in returns a different person
- **GIVEN** the application holds local identity P and the portal holds identity Q
- **WHEN** the user starts sign-in and Q differs from P
- **THEN** the application shows Q's stable person ID, known affected local boards
  and the limits of that inventory
- **AND** replaces P only after explicit confirmation, preserves P's original
  profile bytes and local board storage, and offers `.tincanban` export/import
- **AND** identities and board histories are not merged.

### Requirement: Enrollment and ordinary login have separate authority
The SDK SHALL support two explicit request-bound device-enrollment directions.
For profile creation from a local identity, the application SHALL approve the
portal's exact device key under the existing person. For sign-in to the same
existing person, the portal SHALL approve the application's exact device key, and
the application SHALL adopt only the returned person and certificate for that
key after explicit consent. Each origin SHALL retain its own private device key.
A different-person result SHALL NOT merge or silently replace local identity.
Replacing the active local identity with a different approved person SHALL require
an explicit warning and user confirmation before adoption; cancellation SHALL
preserve the current identity and data.
The portal SHALL use its own saved profile and authority, never inspect another
origin's storage or depend on shared cookies/hidden iframe storage.

Ordinary session login SHALL verify exact origin, source window, request/challenge,
purpose and expiry. It SHALL return verified public identity data and a short-lived
proof only; it SHALL NOT issue a device certificate, transfer private keys, or
grant board or identity-management rights. The server application SHALL verify the
proof and own its session/access. Device enrollment remains a separate workflow
with explicit approver consent and certificate issuance.

#### Scenario: Session login does not enroll a device
- **GIVEN** a service sends a valid short-lived login request to the portal
- **WHEN** the user approves and the service verifies the response
- **THEN** the service receives a session proof bound to its origin and challenge
- **AND** no device authorization or board permission is created by that login.

#### Scenario: Portal is unavailable or another person is selected
- **GIVEN** enrollment cannot finish or the portal holds a different person
- **WHEN** Tincanban starts profile onboarding
- **THEN** local work and identity remain intact and the same person can retry
- **AND** switching person requires an explicit separate export/import choice.

### Requirement: Identity synchronization remains independent of application data
The personal Identity mesh SHALL synchronize signed profile and device authority
under its own membership and keys. Application meshes SHALL retain their separate
resource authority and only necessary identity proofs. Shared transports/engines
MAY be reused. Root private keys SHALL NOT be broadcast as ordinary mesh state.
Local board operations SHALL use retained verified authority without live Identity
status or portal-session refresh. Fresh browsers SHALL require device approval or
recovery; remote storage alone SHALL NOT identify or unlock the user.

#### Scenario: Identity replicas stop responding
- **GIVEN** a connected application has a locally available board and sufficient
  verified authority
- **WHEN** portal sessions expire and Identity peers or Rusty become unavailable
- **THEN** local open/edit/save/sign remains usable
- **AND** unknown remote revocations are learned through later signed
  synchronization, not invented checks.

### Requirement: Recovery and identity replacement preserve prior state
The person/root authority SHALL create 12 or 24 recovery words and an encrypted
identity recovery file using the existing random-root SDK format. Matching
words/file SHALL recover the same person and portable profile with a fresh device
key, not by copying an old device private key. A rootless delegated portal device
SHALL NOT generate new root-recovery words from its device key.

The user MAY separately approve transfer of the encrypted recovery file and
matching words during the secret-bound enrollment flow. That transfer grants full
root-recovery authority and SHALL require recipient consent signed into the
enrollment request plus explicit sender consent before disclosure, separate from
device enrollment. An opted-out request SHALL receive no recovery file or words.
After disclosure, full recovery authority cannot be recalled; later cancellation
cannot undo it. The portal MAY persist the encrypted file, but SHALL show the words
transiently and SHALL NOT persist them with the file, include them in Identity
mesh state, or log them. Enrollment SHALL NOT imply recovery transfer. Tincanban
SHALL retain `.tincanban` board files; identity recovery SHALL NOT invent board
membership or board bytes. A different-identity switch SHALL retain original
board data and require an explicit choice. Failed or cancelled imports SHALL
preserve prior identity and board data.

#### Scenario: Profile recovery and replacement
- **GIVEN** a valid encrypted profile file and matching words, plus an optional
  existing local identity
- **WHEN** recovery is explicitly confirmed
- **THEN** the saved person/profile returns with a fresh device key and without
  inventing board membership or board bytes
- **AND** wrong words, invalid files or cancelled replacement leave prior state
  unchanged.

#### Scenario: Recovery transfer is declined
- **GIVEN** a portal device is being enrolled under a local identity
- **WHEN** the receiving device declines separate full-root recovery transfer
- **THEN** device enrollment may complete without sending the recovery words/file
- **AND** the portal does not claim independent root recovery from its delegated
  device key.

#### Scenario: Recovery disclosure requires both parties' consent
- **GIVEN** an enrollment request includes signed consent to receive full recovery
- **WHEN** the issuer declines recovery transfer or the request lacks consent
- **THEN** the issuer sends no recovery file or words
- **AND** after both parties consent and the material is disclosed, cancellation
  does not claim to revoke the recipient's full recovery authority.
