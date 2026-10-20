# workspace-creation-config Specification

## Purpose
TBD - created by archiving change configure-board-on-create. Update Purpose after archive.
## Requirements
### Requirement: Progressive configuration before workspace creation

The system SHALL expose workspace title and preset immediately and SHALL offer an initially collapsed, keyboard-accessible board configuration section. Its summary SHALL show item name, column count, and field count. Users SHALL be able to configure item name, ordered columns, field names and types, required flags, and select options before creating the workspace.

#### Scenario: Custom board created from a preset
- **GIVEN** workspace creation is open with a preset selected
- **WHEN** the user expands customization, changes the item name and columns, adds a required select field with options, and creates the workspace
- **THEN** the created board reflects that structure immediately
- **AND** its item form uses the configured item name, field, and select options
- **AND** reload preserves the configuration.

#### Scenario: Quick preset creation
- **GIVEN** workspace creation is open with customization collapsed
- **WHEN** the user provides a title and creates the workspace
- **THEN** the selected preset creates normally without another configuration step.

### Requirement: Preset changes preserve manual configuration

The system SHALL NOT silently discard manual configuration when the selected preset changes. Replacing an edited draft with preset defaults SHALL require an explicit reset action.

#### Scenario: Preset changed after customization
- **GIVEN** the user has edited item name, columns, or fields
- **WHEN** they select another preset
- **THEN** their manual configuration remains available
- **AND** reset to the selected preset is a separate explicit action.

### Requirement: Validated durable creation with recoverable failure

The system SHALL validate the final configuration before persistence and SHALL authorize and persist the configured genesis document before publishing the workspace. Invalid input or failed persistence SHALL retain the modal and draft, expose an error, and allow retry. While creation is pending, the system SHALL prevent duplicate submission.

#### Scenario: Invalid configuration corrected
- **GIVEN** customization contains an invalid column or field
- **WHEN** the user submits creation
- **THEN** validation explains the invalid setting without creating a workspace
- **AND** correcting it allows creation without reentering the rest of the draft.

#### Scenario: Initial save fails
- **GIVEN** a valid configured draft and unavailable storage
- **WHEN** the user submits creation
- **THEN** the failure appears and the draft remains open
- **AND** retry after storage recovers creates the configured workspace once.

#### Scenario: Creation remains pending
- **GIVEN** a valid configured draft whose save has not completed
- **WHEN** the user attempts another submission
- **THEN** creation remains pending and no duplicate submission starts.

### Requirement: Usable desktop and phone creation layout

The system SHALL keep expanded configuration within the viewport on desktop and phone, with one content scroll area and stable creation actions.

#### Scenario: Expanded configuration on a phone
- **GIVEN** workspace creation on a narrow phone viewport
- **WHEN** the user expands customization and edits fields and options
- **THEN** controls remain reachable without horizontal page overflow
- **AND** creation actions remain accessible.

### Requirement: Explicit card presentation and text formats
Board configuration SHALL retain optional card presentation field references and explicit text formats. Runtime behavior SHALL depend on that configuration rather than the selected template name.

#### Scenario: Template-neutral configuration
- **GIVEN** two boards with identical field and presentation configurations and different template names
- **WHEN** cards are created and opened
- **THEN** both boards use the same card behavior.

