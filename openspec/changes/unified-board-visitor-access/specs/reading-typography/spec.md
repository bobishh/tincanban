## ADDED Requirements

### Requirement: Compact shared prose scale
Card-detail descriptions/source text, chat messages and the chat composer SHALL share a Fira Sans reading token with a default 16 CSS px size, 1.5 line height and regular body weight at standard browser scale. It MUST NOT inherit the handwritten 20px root through an unadjusted `1rem`. Caveat board summaries, headings, navigation and controls MUST retain their current scale. Public and private visitor surfaces MUST use the same tokens.

#### Scenario: Dense description beside handwritten controls
- **GIVEN** a card contains a long description, URL and technical identifier
- **WHEN** its shared detail opens at desktop or 390px width
- **THEN** prose is visually subordinate to the heading and fits the content width without horizontal overflow
- **AND** board cards and stage controls retain their existing Caveat appearance

#### Scenario: Read and compose a long discussion
- **GIVEN** a discussion contains multiple paragraphs and a long link
- **WHEN** a user reads it or types in its composer
- **THEN** both use the same compact reading scale and appropriate wrapping/paragraph spacing
- **AND** technical values use the subordinate Fira Code style

### Requirement: Preserve accessible text scaling
Reading typography SHALL support browser zoom and accessibility text enlargement without clipped content, forced zoom resets or fixed-height text cropping.

#### Scenario: Enlarge text
- **WHEN** the user increases browser text/zoom scaling
- **THEN** descriptions and discussion content scale and remain readable within their shared scrolling windows
- **AND** controls and text do not overlap
