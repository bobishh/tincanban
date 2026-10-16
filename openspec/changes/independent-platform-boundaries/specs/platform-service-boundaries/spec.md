## ADDED Requirements

### Requirement: Independent service releases
Each service repository SHALL test/build/publish immutable artifacts and MAY
deploy only its own components. Production credentials SHALL be limited to those
components. Standard releases SHALL preserve API compatibility and SHALL NOT
require paired deployments, a central repository or matching SDK revisions.

#### Scenario: Product-only change
- **GIVEN** compatible platform APIs and a checked tincanban frontend/executor build
- **WHEN** tincanban is deployed or rolled back
- **THEN** only the selected component changes; all other versions and volumes remain unchanged

#### Scenario: Different SDK provenance
- **GIVEN** Rusty and tincanban use different SDK commits with supported protocol capabilities
- **WHEN** the product is released or uses a supported operation
- **THEN** the different commits do not reject the release or write

### Requirement: Preserve local-first and Rusty-only backend
The application SHALL retain local admitted CRDT as source and Rusty as its only
backend. Existing automation SHALL remain an executor. This change SHALL NOT add
a public-board Worker API, alternate board datastore or Durable Object namespace.

#### Scenario: Existing private and public boards
- **GIVEN** existing boards, identities, URLs and writer grants
- **WHEN** independent deployment ownership is introduced
- **THEN** those data and authorities remain valid without migration or manual republishing

#### Scenario: Constrained automation remains constrained
- **GIVEN** an active owner-signed automation scope
- **WHEN** automation proposes a public update
- **THEN** existing action/field constraints and coherent file manifests remain enforced

### Requirement: Optional independent observability
Products SHALL export standard OTel independently of observability deployment.
Missing credentials, ingress outage and exporter failures SHALL NOT fail
application work or require platform deployment from product CI.

#### Scenario: Diagnostics unavailable
- **GIVEN** no diagnostic key or an unavailable OTLP endpoint
- **WHEN** a card is saved or a checked product release is activated
- **THEN** its result is unaffected and diagnostic failure remains separately observable

#### Scenario: Frontend changes without automation changes
- **GIVEN** a checked frontend artifact and an already compatible automation executor
- **WHEN** the frontend is deployed or rolled back
- **THEN** the executor is not rebuilt, restarted or redeployed
