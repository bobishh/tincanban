## ADDED Requirements

### Requirement: Directory layout follows its window
Board discovery SHALL preserve readable board identity, compact actions, content spacing and scrolling in default, maximized and independently narrowed windows. Actions SHALL remain operable and validation failures SHALL preserve input.

#### Scenario: Resize and rename a board
- **GIVEN** pinned, recent and active boards in the directory
- **WHEN** a user resizes or maximizes the window and attempts an empty rename before a valid rename
- **THEN** the board list and actions remain usable, the invalid input stays editable, and the valid rename persists

### Requirement: Desktop participant details use available width
Desktop Sync SHALL present participant selection beside the selected participant's devices/details when its window is wide enough and stack them when narrow, retaining independent scrolling and storage/recovery actions.

#### Scenario: Select and inspect devices across window sizes
- **GIVEN** multiple participants and a long selected-device list
- **WHEN** the user selects participants and resizes Sync
- **THEN** selection, readable details and scrolling remain usable without stretching every participant across the full desktop width or locking the board

### Requirement: Search typing remains responsive
Board search SHALL update its input immediately and coalesce result matching,
field revelation and excerpts after 60 milliseconds without another text change.
Clearing search or changing a nontext filter SHALL apply immediately. Workspace
switching or view disposal SHALL discard pending search presentation.

#### Scenario: Type, clear and switch boards
- **GIVEN** a populated board with searchable card fields
- **WHEN** a user types several keys, clears search or switches workspaces before results update
- **THEN** typing remains within the existing 200-millisecond response budget and only the latest query for the active workspace is presented
- **AND** clearing restores unfiltered results immediately without reviving pending text
