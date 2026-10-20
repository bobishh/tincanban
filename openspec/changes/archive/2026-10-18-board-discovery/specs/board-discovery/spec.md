## ADDED Requirements

### Requirement: Identify boards by title and owner
The application SHALL show each board's title and owner in the board picker. The board picker SHALL search board title, owner name when available, and owner identifier.

#### Scenario: Search boards
- **WHEN** a person enters text in board search
- **THEN** the picker shows boards whose title or owner matches, and allows switching to a result

### Requirement: Scope board discovery
The picker SHALL provide All boards, Mine, and Shared filters. Mine SHALL include boards owned by the current identity; Shared SHALL include other boards.

#### Scenario: Filter boards by ownership
- **WHEN** a person selects Mine or Shared
- **THEN** the picker limits results to boards matching that ownership scope

### Requirement: Revisit boards
The picker SHALL let a person pin boards, manually order pinned boards, and show up to five recently opened boards. These preferences SHALL remain local to the current identity.

#### Scenario: Keep favorite and recent boards handy
- **WHEN** a person pins and reorders boards or switches between boards
- **THEN** pinned order persists locally and up to five recent boards appear before the full list

### Requirement: Preserve card search
Board discovery search SHALL remain separate from card search and SHALL NOT change job-search board behavior.

#### Scenario: Search cards independently
- **WHEN** a person searches in the board picker
- **THEN** card search and visible cards remain unchanged after returning to the active board

### Requirement: Keep chat scrolling clear
The floating chat SHALL avoid unnecessary outer scroll space when content fits. The message list SHALL remain scrollable when conversation content exceeds its viewport.

#### Scenario: Keep chat content in its message scroller
- **WHEN** chat has no messages or a long conversation
- **THEN** empty content fits the floating window and long messages scroll inside the message list
