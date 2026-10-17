## ADDED Requirements

### Requirement: Explicit card presentation and text formats
Board configuration SHALL retain optional card presentation field references and explicit text formats. Runtime behavior SHALL depend on that configuration rather than the selected template name.

#### Scenario: Template-neutral configuration
- **GIVEN** two boards with identical field and presentation configurations and different template names
- **WHEN** cards are created and opened
- **THEN** both boards use the same card behavior.
