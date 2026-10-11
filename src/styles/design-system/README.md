# tincanban shared design system

Rusty imports `index.css` in full from a pinned tincanban revision. Match imports the shared modules directly and leaves out `keeper.css`, because Match has no `.keeper-admin` surface. tincanban owns these modules; do not copy styles into consumers. Font overrides are the only local styling exception for Rusty.

- `tokens.css`: palette, spacing and sizes.
- `reset.css`: box sizing, viewport bounds, thin paper-colored scrollbars and reduced-motion behavior.
- `typography.css`: Original tincanban typography: Caveat for content, controls and headings; Fira Code for technical text. Rusty sets its font overrides in its own typography.css.
- `controls.css`: shared buttons and fields. Single-value selects use paper menus through
  `appearance: base-select` where supported; other browsers keep a system picker
  with the shared field styling. Multiple/listbox selects keep native behavior.
  Links, disclosure summaries and custom keyboard targets use the same green
  focus color rather than browser-default blue outlines. Window frames stay ink
  colored; messages opened by local links use a soft paper highlight.
- `layout.css`: shared shell, forms and dialogs, including native dialog backdrop.
- `chrome.css`: header and responsive chrome.
- Header uses `--paper`, matching the page background; its border supplies separation without an extra neutral color.
- `keeper.css`: shared keeper presentation, navigation and list hooks, scoped to `.keeper-admin`.
- `icons.css`: shared Rusty mark sizing.
- `/assets/primitive.css`: nine-slice hand-drawn frames, fills and focus contours for shared surfaces and controls.

Application styles describe their own content structure. Reuse shared classes for controls and surface appearance. Verify real routes at desktop and mobile widths, including a failure or pending state.
