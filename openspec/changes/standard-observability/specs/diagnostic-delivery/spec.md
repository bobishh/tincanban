## ADDED Requirements

### Requirement: Standard OpenTelemetry delivery
When diagnostic export is configured and enabled, the application SHALL export
diagnostic logs and operation spans using official OpenTelemetry SDKs and standard
OTLP/HTTP through authenticated ingress to the private Collector and ClickHouse.
Missing optional endpoint or credentials SHALL disable export without blocking
application work. Grafana installation SHALL remain out of scope.

#### Scenario: Actual exception survives delivery
- **GIVEN** an enabled producer encounters an exception with message, stack and cause
- **WHEN** its operation reports failure through OpenTelemetry
- **THEN** ClickHouse contains the original bounded exception diagnostics, operation and source revision
- **AND** signing keys, authorization tokens and request bodies are absent
- **AND** the event is queryable through TinSink with existing reader authorization

### Requirement: Preserve first failure and context
The system SHALL retain the original exception at the failing operation boundary,
use valid distinct OTel trace/span identifiers and correlate related operations
with W3C Trace Context.

#### Scenario: WASM module becomes terminated
- **GIVEN** a WASM operation throws and later calls report Module terminated
- **WHEN** diagnostics are delivered
- **THEN** the first exception and its operation are retained separately from subsequent failures
- **AND** Module terminated alone is not labeled as a proven root cause

### Requirement: Authenticated bounded ingestion
Ingress SHALL enforce existing project, source, browser-origin and quota policy
and inject authenticated tenant metadata before private Collector forwarding.

#### Scenario: Collector is unavailable
- **GIVEN** valid producer diagnostics and an unavailable Collector
- **WHEN** ingestion is attempted
- **THEN** no false success is returned and bounded retry remains possible
- **AND** board editing and synchronization remain independent

#### Scenario: Export is not configured
- **GIVEN** a product deployment has no diagnostic endpoint or write credential
- **WHEN** the application starts or performs board work
- **THEN** external export stays disabled without an application error
- **AND** local persistence, editing, synchronization and service release continue

#### Scenario: Browser attempts server-source spoofing
- **GIVEN** a public browser key and untrusted resource or tenant attributes
- **WHEN** it submits an OTLP batch claiming a server project or source
- **THEN** ingress rejects the unauthorized source or assigns only its authenticated browser scope
- **AND** the caller acquires no read privileges

### Requirement: Respect diagnostic consent
The browser SHALL stop diagnostic collection and pending exports after opt-out.

#### Scenario: Opt out during queued delivery
- **GIVEN** browser diagnostics are queued
- **WHEN** the user disables diagnostics
- **THEN** pending application diagnostic exports stop
- **AND** local board persistence continues
