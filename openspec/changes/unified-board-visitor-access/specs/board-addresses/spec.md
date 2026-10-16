## ADDED Requirements

### Requirement: Stable readable addresses for every board
Every public and private board SHALL have a browser URL `/boards/<board-id>/<title-slug>`. The ID MUST establish board identity, while the slug MUST be descriptive only. Existing `/boards/<board-id>` links and stale title slugs MUST continue resolving the same board. Renaming MUST NOT change board identity or invalidate links.

#### Scenario: Switch private boards
- **GIVEN** two locally available private boards
- **WHEN** the user switches between them
- **THEN** the address identifies the selected board and includes its readable title slug
- **AND** neither board's visibility or membership changes

#### Scenario: Reload and browser history
- **GIVEN** the user navigated between board URLs
- **WHEN** they reload or use Back/Forward
- **THEN** the addressed board opens with normal authorization checks
- **AND** the app does not silently display an unrelated last-used board

#### Scenario: Rename with a message target
- **GIVEN** an old board URL includes a message query/hash target
- **WHEN** its board has been renamed and the link is opened
- **THEN** the same board and message target resolve
- **AND** the readable slug can normalize without changing the ID or losing the target

### Requirement: Addresses do not grant access
Route resolution SHALL use existing identity, board discovery and access checks. Local routing hints, slugs and history state MUST NOT grant rights, enroll identities, publish private boards or create a substitute workspace when a target is inaccessible. Anonymous public access MUST remain independent of private startup.

#### Scenario: A private link on an unauthorized device
- **WHEN** someone opens a private board URL without eligible saved access
- **THEN** the app shows an access-required or unavailable state
- **AND** no private content is disclosed and no duplicate board is created

#### Scenario: A public link in a fresh profile
- **WHEN** a reader without identity opens an existing public board's slugged URL
- **THEN** the shared visitor UI opens without enrollment or private runtime startup
