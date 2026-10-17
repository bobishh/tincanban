## ADDED Requirements

### Requirement: Product service boundaries
Tincanban SHALL retain board editing, generic participant/access approval and Rusty storage. Automation/Reflux workflow management and TinSink operational controls SHALL live in their respective services.

#### Scenario: Opening board settings
- **GIVEN** a board and unreachable external automation/log services
- **WHEN** settings opens
- **THEN** board status and local editing remain usable, with no Automation, diagnostics-export or log-console panels
- **AND** Rusty remains available through Sync

### Requirement: Identity login does not imply service access
A valid identity or board membership SHALL NOT implicitly grant log-reader, project-discovery or service-operator permissions. Services SHALL enforce explicit resource-scoped permissions separately from authentication.

#### Scenario: Unrelated identity creates a board
- **GIVEN** an unrelated identity owning a newly created board
- **WHEN** it signs into TinSink or another service
- **THEN** it receives no operator authority, unrelated project metadata or unrelated logs

#### Scenario: Editor has no log-service grant
- **GIVEN** a board Editor without an explicit log-read grant
- **WHEN** requesting project discovery or logs
- **THEN** the service denies that access independently of board-editing rights
