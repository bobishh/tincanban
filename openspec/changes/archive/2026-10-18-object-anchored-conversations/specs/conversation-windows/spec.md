## ADDED Requirements

### Requirement: Shared spatial window system

The system SHALL render item, workspace-chat, and conversation content through a common window manager with movable/resizable geometry and one bounded focus/z-order ring. Windows SHALL be nonmodal; true confirmation dialogs SHALL remain above them. Opening identical content SHALL focus the existing window.

#### Scenario: Keep discussion beside item
- **GIVEN** an item window is open
- **WHEN** the user opens its conversation and positions it beside the item
- **THEN** both windows remain usable alongside the board and participate in the same focus ring.

#### Scenario: Raise and cycle windows
- **GIVEN** item, chat, and conversation windows overlap
- **WHEN** the user focuses a background window or cycles windows by keyboard
- **THEN** the selected window rises and receives window-level shortcuts
- **AND** reopening that content creates no duplicate window.

#### Scenario: Confirmation above windows
- **GIVEN** several nonmodal windows are open
- **WHEN** a destructive action opens a confirmation dialog
- **THEN** modal focus behavior applies to that dialog above the window ring
- **AND** dismissal restores focus to a reachable initiating control.

### Requirement: Local resilient layout

The system SHALL persist window geometry locally outside replicated messages/workspace data, isolate layouts by workspace, and keep headers/actions reachable after viewport changes. Keyboard alternatives SHALL exist for movement/resizing. Closing a window SHALL preserve committed messages and restore useful focus.

Window controls SHALL use fixed-size SVG graphics for switch, maximize/restore, close, and resize, with accessible labels. Window headings SHALL leave enough vertical space for the handwriting font without clipping its glyphs.

#### Scenario: Restore after viewport shrink
- **GIVEN** windows were positioned on a large viewport
- **WHEN** the user reloads with a smaller viewport
- **THEN** restored windows are clamped and their headers, close controls, and composers remain reachable.

#### Scenario: Switch workspace and return
- **GIVEN** workspace A has positioned item and conversation windows
- **WHEN** the user switches to workspace B and back to A
- **THEN** A's layout returns without leaking its content into B.

#### Scenario: Close discussion during pending send
- **GIVEN** a discussion contains a pending message
- **WHEN** its window closes and reopens
- **THEN** pending completion or failure remains observable, failed draft/context remains recoverable, and a committed message appears once.

### Requirement: Responsive conversation access

The system SHALL provide a reachable single-view or stacked presentation on narrow/touch screens with explicit return navigation. It SHALL preserve conversation identity and message data across viewport modes without requiring spatial dragging.

#### Scenario: Narrow portrait discussion
- **GIVEN** the application is open at 390 by 844 CSS pixels
- **WHEN** the user opens an item discussion, replies, and returns to the item
- **THEN** composer, messages, and navigation remain reachable without page-level horizontal clipping
- **AND** the reply exists once in the same workspace log.
