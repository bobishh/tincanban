## ADDED Requirements

### Requirement: Domain effects retain exact intent and verified durable outcomes
Each domain operation SHALL persist immutable intent, stable operation ID, exact
request/ciphertext, target and authority/version preconditions before sending.
Retries SHALL reuse saved values. Server success SHALL follow durable effect/result
persistence. Confirmation SHALL bind the exact request, subject and applicable
generation/revision. Local activation SHALL commit verified effects/progress with
current-state CAS. Uncertain effects SHALL remain pending through restart; attempt
renewal SHALL preserve logical intent and deduplication. Authenticated result lookup
SHALL precede renewed execution when a previous outcome is unknown.

#### Scenario: A reply is lost before local activation
- **GIVEN** a saved operation may have committed remotely
- **WHEN** restart retries or verified local activation fails
- **THEN** the same effect can be confirmed once without generating replacement rights or ciphertext
- **AND** original local state and unresolved evidence survive.

### Requirement: Independent resource effects remain independently accountable
Domain owners SHALL decide permissions, valid conflicts and completion. Shared
mechanics SHALL NOT select authority or become a universal recovery manager.
Multi-resource operations SHALL retain each child outcome and unresolved original
target. Repositories SHALL NOT inspect other domains' private journals or silently
claim distributed atomicity. Deduplication evidence SHALL remain while corresponding
retries are admissible.

#### Scenario: A multi-resource withdrawal partially completes
- **GIVEN** one target confirmed and another remains unavailable
- **WHEN** execution restarts or current authority changes
- **THEN** confirmed outcomes remain durable and unresolved targets stay pending
- **AND** no global success, remote cancellation or authority bypass is inferred.
