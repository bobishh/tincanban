## ADDED Requirements

### Requirement: Common discoverable tiling control

The system SHALL show a tiling button on every visible application window when
more than one window is open in the current workspace scene, including chat,
cards, conversations and migrated application dialogs. With zero or one window
the button SHALL be absent. Hidden workspaces and duplicate content SHALL NOT
increase the count. The button SHALL sit immediately before maximize/restore;
on cards the order SHALL be Edit, History, Tile windows, Maximize/restore, Close.
All tiling buttons SHALL expose the same scene-level toggle, active state and
accessible action label. The graphic SHALL use the supplied multiple-window SVG.
The action SHALL be reachable by ordinary click and keyboard activation without
a right-click menu or separate window-selection workflow.

#### Scenario: One card gains a chat sibling

- **GIVEN** exactly one card window is open
- **WHEN** workspace chat opens
- **THEN** both title bars show Tile windows immediately left of maximize
- **AND** closing chat removes the button from the remaining card.

#### Scenario: Chat and two cards

- **GIVEN** chat and two distinct card windows are open
- **WHEN** their title bars render
- **THEN** all three have the same tiling action
- **AND** both card headers order Edit, History, Tile windows, Maximize/restore, Close.

#### Scenario: Duplicate open does not create a tile

- **GIVEN** a single card window is open
- **WHEN** the same card is opened again
- **THEN** the existing window receives focus and no tiling button appears.

### Requirement: Shared tile arrangement

Activating Tile windows SHALL arrange all currently visible windows in the scene
within the viewport work area used for maximize. Two windows SHALL use equal
left and right halves. Three SHALL use a full-height left half and two stacked
right-hand windows. Larger sets SHALL use a balanced grid. Tile placement order
SHALL remain stable across focus changes. Each window SHALL keep independent
scrolling and responsive content. If minimum usable sizes cannot fit, a
scrollable stacked/grid layout SHALL retain reachable headers and controls
without overlapping windows or page-level horizontal clipping.

#### Scenario: Two-window comparison

- **GIVEN** two floating windows have different positions and sizes
- **WHEN** Tile windows is activated in either header
- **THEN** they fill equal left and right halves, accounting for safe margins and a consistent gap
- **AND** both windows and their independent scrolling remain usable.

#### Scenario: Mixed three-window comparison

- **GIVEN** chat and two cards are open with content and drafts
- **WHEN** Tile windows is activated and another tile receives focus
- **THEN** all three are tiled, with the first window on the left and two on the right
- **AND** focusing does not reshuffle cells, recreate content or lose drafts/scroll positions.

#### Scenario: Portrait fallback

- **GIVEN** multiple windows are open in tile mode
- **WHEN** the viewport becomes too narrow for side-by-side minimum usable widths
- **THEN** the windows use a vertically stacked scrollable layout
- **AND** their tiling controls and content remain reachable.

### Requirement: Exact reversible presentation

Entering tile mode SHALL capture the pre-tile position, size and maximize/restore
state of each window once. Activating Restore window layout in any window SHALL
restore that captured presentation for surviving windows, clamped only as needed
for the current viewport. Tile geometry SHALL NOT overwrite normal local layout
storage. Layout changes SHALL preserve content identity, pending actions, failed
drafts and focus. Tile/restore state SHALL NOT enter replicated workspace data.

#### Scenario: Restore mixed floating and maximized windows

- **GIVEN** one window is maximized and another has custom floating bounds
- **WHEN** the user tiles them and activates Restore window layout from either window
- **THEN** the first is maximized with its original restore bounds and the second returns to its floating bounds
- **AND** the scene leaves tile mode.

#### Scenario: Open and close while tiled

- **GIVEN** several windows are tiled
- **WHEN** another window opens and one existing window closes
- **THEN** tile geometry adapts and the newly opened window's normal floating state is retained
- **AND** restoration restores surviving windows without reopening the closed window.

#### Scenario: Last remaining window

- **GIVEN** two windows are tiled
- **WHEN** one closes
- **THEN** the survivor returns to its saved presentation, tile mode ends and its tiling button disappears.

#### Scenario: Reload preserves floating layout

- **GIVEN** a temporary tile session is active
- **WHEN** the application reloads
- **THEN** normal floating layout persistence retains the pre-tile geometry rather than the temporary tile rectangles.

#### Scenario: Resize and maximize during tiling

- **GIVEN** a tile session is active
- **WHEN** the viewport resizes
- **THEN** cells reflow without replacing the captured floating presentation
- **AND** selecting maximize restores the scene first and then maximizes that window.

#### Scenario: Pending work survives layout changes

- **GIVEN** a form has a failed save or a chat message is pending
- **WHEN** the user tiles and restores the windows
- **THEN** the same error, draft and pending operation remain visible
- **AND** no save or message is submitted twice.
