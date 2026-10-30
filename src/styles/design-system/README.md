# tincanban shared design system

Rusty imports `index.css` in full from a pinned tincanban revision. Match imports the shared modules directly and leaves out `keeper.css`, because Match has no `.keeper-admin` surface. tincanban owns these modules; do not copy styles into consumers. Font overrides are the only local styling exception for Rusty.

- `tokens.css`: palette and an import of `/assets/layout-tokens.css`, the single
  spacing and control-size source shared with the standalone agent guide.
- `reset.css`: box sizing, viewport bounds, thin paper-colored scrollbars and reduced-motion behavior.
- `typography.css`: preserve existing Caveat board/card/chrome typography. Fira Sans reading prose uses a 14px/1.65 scale because its larger x-height appears optically bigger beside Caveat; helper text follows the same size. Editable fields remain 16px to avoid mobile focus zoom, while Fira Code stays scoped to code and `settings.json`. `reading-fonts.css` owns the board card, detail description/note and discussion/chat prose rules plus local Fira Sans WOFF2 subsets (weights 400, 600 and 700); it loads with the app so board previews can use the bundled face and provides reading-size defaults as fallbacks. Detail titles step up to 1.5rem (1.35rem on mobile), and rich-text headings use a 1.3/1.15/1.05rem ladder while board headings retain their established scale. This follows Gonzo-yuppie's Fira Sans reading rhythm (`.9rem/1.7`) with a scale tuned for tincanban's 20px root and Caveat title face. The subsets come from Google Fonts' official `google/fonts/ofl/firasans` family. The matching SIL Open Font License is `public/assets/OFL-FiraSans.txt`. Latin, Latin Extended, Cyrillic and Cyrillic Extended coverage is bundled locally; runtime CDN requests are not used.
- `controls.css`: shared buttons and fields. Single-value selects use paper menus through
  `appearance: base-select` where supported; other browsers keep a system picker
  with the shared field styling. Multiple/listbox selects keep native behavior.
  Every keyboard target uses the shared `ink-focus` SVG contour. Native checkboxes
  and radios retain their check marks, with the contour around their label.
  Window frames stay ink colored; messages opened by local links use a soft paper highlight.
- `layout.css`: shared shell, forms and dialogs, including native dialog backdrop.
- `chrome.css`: header and responsive chrome.
- Header uses `--paper`, matching the page background; its border supplies separation without an extra neutral color.
- `keeper.css`: shared keeper presentation, navigation and list hooks, scoped to `.keeper-admin`.
- `icons.css`: shared Rusty mark sizing.
- `/assets/primitive.css`: nine-slice hand-drawn frames, fills and focus contours for shared surfaces and controls.

Application styles describe their own content structure. Reuse shared classes for controls and surface appearance. Verify real routes at desktop and mobile widths, including a failure or pending state.

## Layout contract

- Use `--space-1` through `--space-11` for physical spacing: 4, 8, 12, 16, 24,
  32, 48, 64, 80, 96 and 128 px. Text-relative `em` spacing belongs to prose;
  border strokes, paint offsets, icon artwork and window coordinates are geometry.
- Page chrome, board controls, board content and the public reader use
  `--site-gutter`. Dialogs use `--surface-padding`; sections, labels and action rows
  use `--section-gap`, `--field-gap` and `--action-gap`. Reserve `--focus-room`
  inside scrolling forms so the ink focus contour is not cut off.
- `ui-stack`, `ui-grid` and `ui-actions` provide section flow, automatic field
  columns and wrapping action rows. Domain layouts may compose their own tracks;
  they still consume shared spacing and allow children to shrink.
- Standard controls are at least `--control-size` (48 px); compact controls use
  `--control-size-compact` (40 px), icon tools use `--icon-size` (44 px).
  Multiline content may increase height. Do not locally invent a standard height.
- `form-grid` has two columns and collapses below a 480 px **container** width.
  Wide fields span all tracks. A resized editor follows its own width, even on a
  wide desktop. Settings uses side navigation on desktop and a horizontally
  scrolling tab row on phones, with matching keyboard orientation.
- Item editing uses `SpatialWindow`, preserving movement, resizing, focus order
  and workspace geometry. Its fields scroll separately from the save/error area.
  Creation and short confirmations retain modal behavior. Saving disables closing.
- Ink contours decorate rectangular layout boxes. Button hover and press do not
  rotate the boxes. Existing reading typography is independent of layout.
- Detail/history/document composition loads with its owning window rather than
  adding those styles to every page's initial CSS. Keep lazy surface styles local;
  shared tokens, controls and layout primitives remain in the common modules.

`npm run quality:layout` checks all authored application CSS and component style
blocks plus `/agent`. It rejects literal pixel/rem spacing and locally hardcoded
standard control minima. The `-1px` screen-reader-only box is a mechanical exception.

## Surface and verification map

| Surface | Layout owner | Browser evidence |
| --- | --- | --- |
| Board, filters, archive, header | `chrome.css`, `style.css`, shared gutters | `component-layout`, `brand-layout`, `filtered-board-layout`, `archive-layout` |
| Identity, Workspace, templates, priority, JSON | `SchemaEditorDialog.css`, section components | `shared-layout`, `settings-scope`, `settings-layout`, `ui-screen-audit` |
| Sync, Rusty, backup, recovery, invitations | `SyncDialog.css`, panel components | `shared-layout`, `sync-tabs`, `sync-layout` |
| Workspace list and creation, board/column schema | `WorkspacesDialog`, `CreateWorkspaceDialog`, `SchemaEditorDialog` | `shared-layout`, `component-layout`, `workspace-create-layout` |
| Item creation, editing and details, attachments | `form-grid`, `ItemFormDialog`, `SpatialWindow`, `ItemDocuments` | `shared-layout`, `window-presentation`, `conversation-windows`, `card-discuss-layout` |
| Chat, discussions, references | `WorkspaceChat.css`, shared window/actions | `shared-layout`, `conversation-windows`, `mobile-chat-composer`, `root-message-links` |
| Anonymous public reader and resource errors | `PublicBoardApp` and shared gutters | `public-board` |
| TinSink approval and standalone agent guide | shared stack/actions, layout tokens | `shared-layout` |

`shared-layout` inspects 320, 390, 768 and 1280 px viewports, validation recovery,
nonmodal editing and container resizing. Other surface suites exercise domain
content and pending/error states. External Markdown resources use a new tab;
relative and same-origin navigation stays local, and downloads keep their behavior.
