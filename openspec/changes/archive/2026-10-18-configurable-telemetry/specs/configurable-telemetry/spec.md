## ADDED Requirements

### Requirement: Application configuration and device consent
tincanban SHALL collect externally only with valid deployment configuration and enabled device consent. Endpoint, project, public browser key, event level, sampling and batching SHALL come from the build. The user interface SHALL expose no operator configuration fields.

#### Scenario: Disabled collection
- **GIVEN** no valid deployed collector or this device has opted out
- **WHEN** a user saves and reloads a chat message
- **THEN** the message persists and no external telemetry request occurs, including on the production hostname

#### Scenario: Persisted consent
- **GIVEN** a valid deployed collector
- **WHEN** the user disables diagnostics and reloads
- **THEN** one device-local consent boolean persists across workspaces
- **AND** collector configuration stays unchanged

#### Scenario: Invalid deployment configuration
- **GIVEN** an invalid endpoint, project, key, event level, sample rate or batch limit
- **WHEN** the client loads
- **THEN** external collection stays disabled and device consent cannot supply or override collector credentials

#### Scenario: Authenticated browser delivery
- **GIVEN** a configured public browser write key
- **WHEN** the client sends a version 2 batch
- **THEN** the key appears only in the Authorization header and is absent from event payloads
- **AND** a missing key prevents enabling collection, while 401 suspends retries

#### Scenario: Legacy device configuration migration
- **GIVEN** old preferences contain a different collector or an explicit opt-out
- **WHEN** the updated client loads
- **THEN** only explicit opt-out is preserved and events use the deployment collector

### Requirement: Correlated content-free events
Telemetry SHALL preserve full identifiers, a versioned envelope and declared typed attributes, excluding application content and secret fields.

#### Scenario: Cross-device entity correlation
- **GIVEN** two devices observe the same verified chat message ID
- **WHEN** each records chat persistence or DOM events
- **THEN** events share the entity ID and derived trace ID while carrying their own session/device IDs
- **AND** message bodies and unknown detail fields are absent

### Requirement: Bounded resilient delivery
Delivery SHALL remain independent from application writes and bound memory, retries and request size.

#### Scenario: Temporary failure
- **GIVEN** intake returns 503
- **WHEN** a user sends a chat message
- **THEN** local persistence succeeds, pending delivery is visible and retries preserve event IDs

#### Scenario: Permanent rejection and opt-out
- **GIVEN** intake returns 404 or another permanent rejection
- **WHEN** delivery fails
- **THEN** retries stop and the user sees the rejection
- **AND** opting out cancels old requests and clears old queued events

### Requirement: Separate server admission and storage
The Roc sink SHALL keep telemetry independently configured and disabled per project until enabled, and route accepted telemetry to operator-selected storage with separate credentials.

#### Scenario: Confirmed telemetry write
- **GIVEN** a registered project, permitted Origin, enabled telemetry and configured storage
- **WHEN** a valid version 2 event batch arrives
- **THEN** the sink validates typed fields, applies project limits and acknowledges only after ClickHouse confirms insertion into telemetry storage

#### Scenario: Forbidden or unavailable stream
- **GIVEN** telemetry is disabled, Origin is forbidden, event is disallowed, or storage is unavailable
- **WHEN** a telemetry batch arrives
- **THEN** the sink returns an explicit rejection or 503 and does not fall back to analytics storage
- **AND** version 1 website analytics remains operational

### Requirement: Owner configuration and correlation reports
The sink SHALL expose authenticated telemetry configuration and report APIs without leaking credentials or raw application content. The concurrent sink UI rewrite integrates these APIs independently.

#### Scenario: Owner enables telemetry and inspects events
- **GIVEN** an authenticated owner and registered tincanban project
- **WHEN** the owner enables telemetry through the owner API and requests the correlation report
- **THEN** persisted settings and report records contain complete entity/trace IDs and delivery timestamps

#### Scenario: Empty or failed report
- **GIVEN** no matching telemetry events or a ClickHouse failure
- **WHEN** the owner requests a report
- **THEN** the API returns an explicit empty result or structured error suitable for the new panel
