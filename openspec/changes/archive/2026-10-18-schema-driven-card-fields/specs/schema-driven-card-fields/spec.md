## ADDED Requirements

### Requirement: Cards follow explicit board configuration
The system SHALL render creation, editing, details, summaries and publication from configured fields and presentation references. It SHALL NOT select a job-specific interface or infer field meaning from a preset or label.

#### Scenario: Configured text with a misleading name
- **GIVEN** a board has an ordinary text field named Source text and a custom extra field
- **WHEN** an editor creates, opens, edits and reloads a card
- **THEN** both fields use configured labels and retain their exact text
- **AND** no Source snapshot, vacancy metadata or implicit JSON parser appears.

#### Scenario: Existing JSON-looking text
- **GIVEN** an existing plain text field contains a serialized object
- **WHEN** the card opens or priority is projected
- **THEN** the string is shown literally and is not parsed or rewritten.

### Requirement: Structured text requires an explicit format
Text fields SHALL default to plain text. JSON, Markdown and code presentation SHALL require explicit field metadata, remain editable through ordinary authorized card editing, and never execute code. The metadata SHALL roundtrip through configuration and public projection.

#### Scenario: Invalid explicitly declared JSON
- **GIVEN** a field is explicitly configured as JSON
- **WHEN** the editor submits malformed JSON
- **THEN** the form retains its draft with a field-specific error
- **AND** corrected JSON can save and survives reload.

### Requirement: No hidden source envelope
Automation SHALL store source text as supplied in the bound text field. The application SHALL NOT wrap text with provenance or decision metadata or parse that field as a vacancy assessment. Existing data SHALL NOT be migrated or automatically transformed.

#### Scenario: Automation writes plain source text
- **GIVEN** an authorized automation has a configured source-text binding
- **WHEN** it creates a card from source text and a decision
- **THEN** the field contains exactly the supplied source text, without an envelope.
