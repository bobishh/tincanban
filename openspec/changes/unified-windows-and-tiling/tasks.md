# Tasks

## 1. Outer acceptance

- [ ] 1.1 Author real-route scenarios for shared dialog windows and a card header without the redundant Item eyebrow.
- [ ] 1.2 Author mixed-window visibility/order scenarios: one card, card plus chat, and chat plus two cards; tile is immediately before maximize on every window.
- [ ] 1.3 Author two-window 50/50, three-window tile, and restore scenarios including original maximize state, drafts and independent scroll positions.
- [ ] 1.4 Author open/close/duplicate, viewport shrink, portrait stacking, keyboard and pending/failure scenarios before implementation.

## 2. Shared window presentation

- [x] 2.1 Inventory and migrate every application dialog listed in design.md, including sync loading/error and confirmation surfaces, to SpatialWindow and the common manager.
- [x] 2.2 Preserve stable identities, validation, permissions, explicit confirmations, draft/async lifetime, busy guards and useful focus restoration.
- [ ] 2.3 Remove the card Item eyebrow and preserve titles, actions and accessible names.
- [x] 2.4 Remove obsolete application ModalLayer branches and styling caused by migration; retain mobile navigation and platform prompts in their existing scope.

## 3. Reversible layouts

- [ ] 3.1 Make the manager own a coherent window/maximize state contract and a transient scene-level tile/restore snapshot.
- [ ] 3.2 Implement the 50/50, three-window and balanced-grid arrangements, responsive stacking and viewport clamping without overwriting floating layout storage.
- [ ] 3.3 Handle focus-stable ordering, new/closed windows, automatic exit at one window, workspace changes and reload semantics.
- [ ] 3.4 Add the supplied SVG control to every title bar when multiple windows are open, immediately before maximize; synchronize label, pressed state and toggle behavior.
- [ ] 3.5 Keep content responsive to window dimensions and preserve independent scrolling and editor/composer state across layouts.

## 4. Verification after implementation

- [x] 4.1 Execute authored acceptance scenarios in an isolated browser on an unused local port, covering happy path and pending/failure behavior.
- [ ] 4.2 Verify geometry/restore invariants, no duplicate content/actions, no floating-layout persistence pollution and unchanged command authorization.
- [ ] 4.3 Run focused required project checks and strict OpenSpec validation; record evidence before considering implementation complete.
- [ ] 4.4 Confirm no dimming controls or backdrops were introduced and title-bar order matches the corrected requirement.
