# Unified windows and reversible tiling

## Why

Tincanban currently uses spatial windows for cards, history, chat and discussions,
and a separate modal renderer for creation, settings, synchronization and other
dialogs. Two presentation systems make related workflows behave differently.
Users also need to compare several open windows without manually positioning
them or losing their previous arrangement.

This proposal expands the board issue **Drop modals in favor of windows** with
the user's subsequent decisions from 19 October 2026. It specifies future work;
the application behavior is not implemented by this document.

## What Changes

- Use the existing spatial window shell and manager for every application dialog,
  including create/edit forms, settings, workspace management, synchronization,
  document previews, recovery, photo cropping and confirmations. Preserve their
  validation, explicit confirmation, pending operations and recoverable drafts.
- Add a reversible tiled layout for all windows visible in the current workspace,
  including mixed content such as one chat and two card windows.
- Show the same tiling control on **every window when more than one window is
  open**. Hide it when zero or one window is open. Count windows, not cards.
- Place the control immediately **before maximize/restore**, never between
  maximize and close. A card's order is **Edit → History → Tile windows →
  Maximize/restore → Close**. Windows without Edit or History still use
  **Tile windows → Maximize/restore → Close**.
- Draw the control with the supplied three-window SVG, matching the existing
  maximize and close graphics. No right-click menu or selection mode is required.
- Clicking the control in any window tiles the entire visible window set.
  Clicking it again in any window restores the previous arrangement.
- Two windows occupy equal left and right halves of the same available area as
  maximize. Three windows use a full-height left half and two stacked windows on
  the right. Larger sets use a balanced grid. Each window scrolls independently.
- Restore each surviving window's previous position, size and maximize/restore
  state. Tiling must not overwrite saved floating geometry or recreate content.
- Remove the redundant **Item** label above a card title. Keep the actual title,
  accessible name and actions.
- Make content respond to its window's width in floating, maximized and tiled
  layouts, with reachable controls and no horizontal clipping.

## Explicit Scope Decisions

There is **no background dimming** in this change: no dimmed backdrop, dimming
button, opacity preference or preparatory dimming API. The earlier suggestion
to put the tiling button between maximize and close is superseded by the order
above. This is a specification and icon change, not authorization to implement
or publish the application changes.

Application confirmation dialogs use the same window shell and keep explicit
confirmation actions and busy guards. Merely opening, moving, tiling or closing a
window never confirms an action. Mobile navigation drawers and browser/OS-owned
prompts are not application content dialogs and are not migrated into the window
ring by this proposal.

## Acceptance Examples

1. Open one card: no tiling button is present; its header has its title without
   an Item eyebrow. Open chat: the button appears in both title bars immediately
   to the left of maximize. Open another card: it appears on all three windows.
2. With two windows, click either tiling button: both fill equal left/right
   halves of the available viewport. Click either button again: both return to
   their previous positions and sizes, including an originally maximized state.
3. With chat and two cards, click any tiling button: all three participate, their
   drafts and scroll positions survive, and clicking or typing does not reorder
   their tiles. Any tiling button can restore the prior arrangement.
4. Open or close a window while tiled: the layout adapts. Restoration never
   resurrects a closed window. If only one remains, restore its floating state
   and hide the tiling button.
5. Resize the viewport or use a narrow portrait screen: title bars, controls and
   content remain reachable. If side-by-side tiles cannot fit, use a vertically
   stacked scrollable presentation without clipping or overlapping windows.
6. Save fails or a message is pending during a layout change: the same window
   content retains the error, draft and pending operation; no duplicate action
   or message is submitted.

## SVG

The supplied icon is [assets/tile-windows.svg](assets/tile-windows.svg). It uses
a transparent 24 × 24 view box, `currentColor` and the same two-pixel stroke as
the existing title-bar controls. It depicts three tiled windows. The enclosing
button provides its accessible name and pressed state; the embedded SVG is
decorative. The same graphic is used for Tile windows and Restore window layout,
with the active state and accessible label conveying the current action.

## Capabilities

### New Capabilities

- `window-tiling`: A shared, reversible arrangement of visible windows, including
  control visibility, accessible operation and responsive layout.

### Modified Capabilities

- `conversation-windows`: Extend the shared shell to all application dialogs,
  preserve confirmation safety without a second modal renderer, remove the
  redundant card-type label and keep floating geometry separate from tiling.
- `generic-workspace-ui`: Present scoped synchronization in a shared window
  while preserving its existing truthful status and history behavior.

## Impact

Implementation will primarily touch `SpatialWindow.vue`, `ui/windowManager.ts`,
their existing consumers and remaining `ModalLayer.vue` consumers. Existing
workspace data, commands, permissions and WebMCP tools do not need a migration.
Window layout stays local to this browser and outside replicated workspace data.
The detailed [design](design.md), [requirements](specs/window-tiling/spec.md) and
[implementation tasks](tasks.md) accompany this proposal.
