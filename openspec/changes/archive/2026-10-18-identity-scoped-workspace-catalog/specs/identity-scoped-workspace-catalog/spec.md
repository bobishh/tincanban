# Identity-scoped workspace catalog

## ADDED Requirements

### Requirement: Workspace catalogs follow personal-root entitlements
The system SHALL derive available and archived workspace entries from the active identity's non-forgotten personal-root references. A local document without such a reference SHALL remain stored but SHALL NOT appear in the catalog or become a startup fallback. Catalog visibility SHALL NOT grant workspace permissions or change ownership.

#### Scenario: Identity replacement hides an old bootstrap board
- **GIVEN** a local bootstrap board belongs to the previous identity and the enrolled identity has a different personal root
- **WHEN** enrollment adopts the new identity and refreshes the workspace catalog
- **THEN** the old board is absent from available and archived workspace lists
- **AND** its local document bytes remain stored without being rebound or re-owned.

#### Scenario: Explicit invitation remains visible
- **GIVEN** a validated visitor or editor invitation creates a workspace reference in the active personal root
- **WHEN** the workspace catalog reloads
- **THEN** that workspace remains available under the active identity
- **AND** its role continues to come from workspace authorization evidence.

#### Scenario: Repair only mismatched legacy genesis references
- **GIVEN** a personal root contains a genesis reference whose downloaded document has a different owner
- **WHEN** startup repairs legacy root pollution
- **THEN** startup removes that mismatched genesis reference
- **AND** preserves import references and references whose document is not downloaded.

#### Scenario: Peer presence does not grant access
- **GIVEN** a local document has peers but no active personal-root reference or valid workspace grant
- **WHEN** the catalog and role projection refresh
- **THEN** the document remains unavailable to the active identity
- **AND** peer presence does not change document ownership or grant write access.
