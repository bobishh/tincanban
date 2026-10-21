## ADDED Requirements

### Requirement: Ordinary connection incidents reach the collector
Under existing deployment configuration, device consent, level and sampling, the client SHALL export bounded connection failures and selected lifecycle events without requiring verbose sync logging. Per-packet detail SHALL remain opt-in. Exported evidence SHALL preserve safe correlation and error cause while excluding content and credentials.

#### Scenario: Ordinary browsing observes a failed connection
- **GIVEN** diagnostics are enabled and verbose sync logging is off
- **WHEN** a mesh session fails, closes and reconnects
- **THEN** correlated incident/lifecycle evidence is exported while routine gossip remains local

#### Scenario: Repeated failure is bounded
- **GIVEN** a burst of repeated connection failures
- **WHEN** the incident export budget is exhausted
- **THEN** local bounded snapshots retain events and external export stays bounded with suppression evidence
- **AND** a later time window admits fresh incident evidence

#### Scenario: Device opts out or disables verbose detail
- **GIVEN** diagnostics consent is disabled or a queued verbose-only export is disabled before dispatch
- **WHEN** further mesh events occur
- **THEN** disabled collection/detail is not exported and local application writes remain independent
