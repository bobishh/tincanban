## MODIFIED Requirements

### Requirement: Shared spatial window system

The system SHALL render all application content dialogs through the common spatial
window shell and manager, including item creation/editing, item details/history,
workspace chat, conversations, settings, workspace management, synchronization,
document previews, recovery, photo cropping and confirmation dialogs. Windows
SHALL share movable/resizable geometry and one bounded focus/z-order ring.
Opening identical content SHALL focus the existing window. Application windows
SHALL remain usable alongside the board without a dimmed backdrop or a separate
legacy modal renderer. Platform-owned prompts and mobile navigation drawers are
outside the content window set.

Confirmation windows SHALL preserve explicit confirmation, target/permission
validation and busy guards. Moving, tiling, focusing or closing a window SHALL
NOT confirm an action. Card window headings SHALL show the card title and actions
without a redundant Item type label.

#### Scenario: Keep discussion beside item

- **GIVEN** an item window is open
- **WHEN** the user opens its conversation and positions it beside the item
- **THEN** both windows remain usable alongside the board and participate in the same focus ring.

#### Scenario: Raise and cycle windows

- **GIVEN** item, chat, settings and conversation windows overlap
- **WHEN** the user focuses a background window or cycles windows by keyboard
- **THEN** the selected window rises and receives window-level shortcuts
- **AND** reopening that content creates no duplicate window.

#### Scenario: Confirmation uses the shared window shell

- **GIVEN** a destructive action needs confirmation while several windows are open
- **WHEN** its confirmation window opens
- **THEN** the same window shell and controls are used without a dimmed backdrop
- **AND** only an explicit valid confirmation applies the action
- **AND** dismissal restores focus to a reachable initiating control.

#### Scenario: Confirmation target changes in another window

- **GIVEN** a confirmation window is open for a target that changes or becomes unauthorized
- **WHEN** the user confirms the action
- **THEN** the existing command boundary revalidates the current target and authority
- **AND** an invalid action shows an error without affecting another target.

#### Scenario: Card title without a redundant type label

- **GIVEN** a card has a title
- **WHEN** its window opens in any layout
- **THEN** the header displays the title and available actions without an Item eyebrow
- **AND** the window retains an accessible name.

#### Scenario: Migrated form retains a failed save

- **GIVEN** a settings or creation window contains unsaved input
- **WHEN** saving fails or the user changes the window layout
- **THEN** its draft, validation and retry feedback remain available in the same window
- **AND** the layout operation does not submit or discard the form.

### Requirement: Local resilient layout

The system SHALL persist floating window geometry locally outside replicated
messages/workspace data, isolate layouts by workspace, and keep headers/actions
reachable after viewport changes. Temporary tile rectangles SHALL NOT replace
saved floating geometry. Keyboard alternatives SHALL exist for movement/resizing
in floating mode. Closing a window SHALL preserve committed messages and restore
useful focus.

Window controls SHALL use fixed-size SVG graphics for switch, tile/restore,
maximize/restore, close and resize, with accessible labels. Window headings SHALL
leave enough vertical space for the handwriting font without clipping its glyphs.

#### Scenario: Restore after viewport shrink

- **GIVEN** windows were positioned on a large viewport
- **WHEN** the user reloads with a smaller viewport
- **THEN** restored floating windows are clamped and their headers, close controls and composers remain reachable.

#### Scenario: Switch workspace and return

- **GIVEN** workspace A has positioned windows, possibly in a temporary tile session
- **WHEN** the user switches to workspace B and back to A
- **THEN** A's floating layout returns without leaking its content into B or persisting its temporary tile rectangles.

#### Scenario: Close discussion during pending send

- **GIVEN** a discussion contains a pending message
- **WHEN** its window closes and reopens
- **THEN** pending completion or failure remains observable, failed draft/context remains recoverable, and a committed message appears once.
