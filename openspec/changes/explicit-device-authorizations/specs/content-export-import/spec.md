## ADDED Requirements

### Requirement: Board content can be copied into a fresh profile
Users SHALL be able to export `.tincanban` board content, create a fresh profile
and import the files as new boards. Import SHALL preserve the source files and
SHALL NOT claim to retain old person or board IDs, memberships, public URLs,
storage policies or complete signed-history continuity. New service/operator
rights, board connections and publication SHALL be configured explicitly. Login
or import SHALL NOT transfer those permissions.

#### Scenario: Existing user chooses a fresh profile and content import
- **GIVEN** the user has exported `.tincanban` board files under local identity P
- **WHEN** the user creates profile Q and imports those files
- **THEN** the imported boards have new board identities under Q
- **AND** the source files and existing local boards remain intact
- **AND** existing memberships, public links and Rusty rights are not reassigned.

### Requirement: Same-person recovery remains a separate identity flow
Same-person recovery SHALL use the Identity recovery format and explicit device
enrollment. It SHALL retain available identity data without inventing board bytes
or membership. Recovery SHALL NOT activate saved resource permissions. Missing
data or required authority SHALL remain explicit and pending.

#### Scenario: Recovery has no live peer or resource approver
- **GIVEN** valid identity recovery material and a board reference
- **WHEN** recovery proceeds without a live peer or required board approver
- **THEN** identity data and the reference may be retained
- **AND** missing board content or resource permission is not fabricated.
