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

#### Scenario: Read export status without changing collection
- **GIVEN** the local trace contains incidents whose durable export is uncertain
- **WHEN** the agent reads the existing WebMCP sync trace
- **THEN** the response includes export state, queued/dropped counts and the last confirmed send time
- **AND** the read changes neither connection state nor consent and exposes no collector credentials

#### Scenario: Device opts out or disables verbose detail
- **GIVEN** diagnostics consent is disabled or a queued verbose-only export is disabled before dispatch
- **WHEN** further mesh events occur
- **THEN** disabled collection/detail is not exported and local application writes remain independent

### Requirement: Diagnostic requests fit the intake contract
The client SHALL split standard OTLP log and trace batches using their serialized
UTF-8 body size so each request fits TinSink's 65536-byte limit. Record count
alone SHALL NOT be treated as a byte limit. Exception text SHALL retain bounded,
redacted context without breaking multibyte characters. Diagnostic delivery SHALL
remain independent of board/chat durability.

#### Scenario: Burst of long connection failures
- **GIVEN** fifty failures with long exception stacks and correlated spans
- **WHEN** diagnostics flush through an intake enforcing the deployed byte limit
- **THEN** each body fits the limit and all records/spans reach an available intake
- **AND** chat still saves and survives reload

#### Scenario: Failed delivery and opt-out during a split export
- **GIVEN** a bounded number of split requests are already in flight
- **WHEN** the device opts out
- **THEN** no unsent body starts and only unsent records count as dropped
- **AND** a transport failure releases the unsent tail without counting previously successful requests as dropped
