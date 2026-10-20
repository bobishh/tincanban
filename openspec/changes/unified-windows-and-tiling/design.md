# Design

## Current source and intended ownership

`src/components/SpatialWindow.vue` owns the common shell, title bar, dragging,
resizing, keyboard controls and per-window maximize state. It registers with
`src/ui/windowManager.ts`, which owns workspace-scoped identity, geometry,
focus, z-order and local geometry persistence. Cards, item editing, history,
workspace chat and discussion windows already use this system.

`ModalLayer.vue` still wraps new items, column editing, moving items, settings,
workspace management/creation, schema confirmation, synchronization (including
loading/failure UI), document previews, avatar cropping, identity recovery and
device-removal confirmation. These application surfaces will use the common
window shell. `MobileDrawer.vue` remains navigation rather than a tiled content
window. Browser and OS prompts remain owned by their platform.

Keep domain actions and each workflow's draft/async state with its existing
owner. The shell owns presentation and window controls. The manager owns the
visible window set and the layout session; individual cards must not enumerate
or reposition sibling windows. Consumers provide stable window identities,
titles and existing content/actions. Reopening the same identity raises it.

## Title-bar contract

The common title bar renders content-specific actions first, followed by Tile
windows, Maximize/restore and Close. For cards the visible order is Edit, History,
Tile windows, Maximize/restore, Close. Tile is immediately left of maximize on
every window. It appears when the visible window count is at least two, including
chat, cards, discussions, forms and app-level windows shown in the current scene.
Background workspaces, closed windows and duplicate render attempts do not count.

Every tiling button invokes the same manager command and reflects the same active
state. Use accessible labels `Tile windows` and `Restore window layout`, an
accurate pressed state, a tooltip and existing button focus/target sizing. Enter
and Space work through the ordinary button. No context menu, extra window picker,
dimming button or extra selection mode is introduced. Remove the static Item
eyebrow from card headers while keeping their actual titles and accessible names.

## One reversible layout session

Entering tile mode captures one snapshot for every participating window: its
floating bounds, maximize state and restore bounds. Capture the window ordering
once for tile placement; subsequent focus/z-order changes must not shuffle cells.
This requires moving maximize/restore coordination into the manager or giving
the manager an explicit per-window presentation contract; do not infer state
from DOM styles or keep competing copies of geometry.

Tile geometry is transient. Rendering, resize handlers and unregister/close paths
must not save tile rectangles as normal floating geometry. Keep the existing
local workspace/window layout keys compatible. A reload returns to the last
floating layout; this change does not add persisted tile sessions or replicated
layout data. Switching workspace restores/ends the old scene's tile session
before leaving it, with no cross-workspace leakage.

Restoration applies the captured state to surviving windows only, clamping bounds
to the current viewport if necessary. A window opened while tiled contributes its
normal initial/restored floating state to the snapshot before receiving a tile.
A closed window is removed from the session and is never reopened by restoration.
At one remaining window, restore it and leave tile mode automatically. Opening an
already-open item only raises its existing window; it adds no tile.

While tiled, free dragging and individual resize handles are inactive; the tile
button restores the floating layout. Maximizing one tiled window first restores
the scene, then applies the requested maximize action to that window. Existing
single-window maximize/restore behavior remains available in floating mode.

## Tile geometry and responsive content

Use the same viewport work area and safe-area margins as maximized windows,
with a small consistent gap. Two windows use equal left/right halves. Three use
a full-height left half with two equal right-hand rows. For four or more, use a
deterministic balanced grid, with the last occupied row sharing its full width.
The active window at entry takes the first cell; retain the resulting order for
the duration of that session.

Recompute cells on viewport or window-set changes without recapturing the saved
floating layout. Keep title bars, readable content and controls usable. If the
available width cannot accommodate multiple windows at supported minimum widths,
tile mode uses a vertically stacked scrollable scene. For larger sets, scroll the
layout rather than shrink controls below usable sizes. The tiling toggle remains
available on each window whenever multiple windows are open, including portrait.

Content adapts to its own window bounds, not only the browser viewport. Card
description, properties, note composer and actions must remain useful in narrow
tiles and expanded windows. Short content does not need artificial spacing to
fill the viewport. Each window retains its own scrolling; do not remount editors,
chat or previews to switch layouts.

## Workflow and focus preservation

Migrate application dialogs without losing validation, permissions, loading,
failure/retry state, draft protection or busy-close guards. Confirmation windows
still require an explicit confirm action. Because users can interact with other
windows while a confirmation is open, recheck the current target and authority
through the existing command boundary before applying it; stale targets display
an error rather than applying an unintended action. Focus stays with a reachable
control, and closing a window restores useful focus through the manager.

No backdrop dimming, opacity setting or separate dimming API is added. The window
shell stays usable alongside the board and other windows. This proposal does not
create a second legacy-modal rendering branch for confirmations.

## Icon

`assets/tile-windows.svg` contains three outlined tiles with transparent fill and
the existing 24 × 24, two-pixel, current-color visual language. Use the vector
directly or inline its trusted paths at implementation time, with the SVG hidden
from assistive technology inside the labeled button. The button supplies tooltip,
focus styling and active indication; the asset supplies only the graphic.

## Acceptance and implementation sequence

Write real-route outer acceptance scenarios before runtime implementation. Cover
two cards, chat plus two cards, restore from mixed floating/maximized state,
open/close while tiled, resize/portrait, duplicate opening, keyboard control and
pending/failure state retention. Add focused pure layout/restore tests where they
prove geometry and state invariants. Browser execution follows implementation in
an isolated context on an unused local port, preserving the user's open browser.
This document-only change needs OpenSpec, link and SVG structural checks.
