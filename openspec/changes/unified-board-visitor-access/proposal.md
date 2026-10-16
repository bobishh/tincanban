## Why

Public access currently creates a manually refreshed publication and uses separate detail, column, discussion and file templates. This contradicts the product: one board, its existing settings, and the same visitor interface for anonymous and invited readers. Private boards also lack recognizable persistent URLs, and the reading font inherits the oversized handwritten UI scale.

## What Changes

- Replace the separate publication lifecycle with public visitor access to the existing board. One stable board ID, one set of content and settings, one shared rendering path.
- **BREAKING behavior:** remove `Update public copy`, publication comparisons and the promise that edits to a public board remain private. The owner enables or disables public access; subsequent authorized board changes synchronize automatically.
- Use the existing visitor board, card details, discussions, files, responsive windows and filters. Delete public-specific presentation templates and CSS rather than keeping parallel implementations aligned.
- Preserve actual presentation settings, including each column's `collapsible` value, accents, archive behavior, preset bindings, stage controls, effective priority/fit and aging. Do not guess missing settings from column names.
- Integrate public delivery with ordinary board writes and sync, including editor and automation writes. An owner keeping Settings or a browser tab open is not an acceptable synchronization dependency.
- Give every board a readable stable URL, including private boards; include a title slug without using it as identity or authority.
- Give Fira prose in card details and chat its own compact reading scale. Keep Caveat on board cards, headings and controls.
- Apply typography and framing by semantic role: resolve history authors to names, translate operation names to readable actions, render technical identifiers in Fira Code on demand, and use spacing/headings instead of redundant nested borders.

This change supersedes the snapshot/update and separate-renderer decisions in [public-board-publication](../public-board-publication/proposal.md). Existing publication files are migration input, not another editable board. No implementation task is marked complete by this proposal; partial uncommitted implementation predates this planning checkpoint and requires review against this contract.

## Capabilities

### New Capabilities

- `unified-board-access`: One board identity, shared visitor presentation, matching settings, continuous public delivery, withdrawal and migration from manual publications.
- `board-addresses`: Stable readable board URLs, private access resolution and navigation history.
- `reading-typography`: Consistent compact prose in details and chat without changing the handwritten board.
- `semantic-ui-presentation`: Meaning-based typography, readable history authors/actions, restrained section boundaries and focus indication.

### Modified Capabilities

None in the canonical `openspec/specs` tree. The unarchived public-publication change is explicitly superseded where it conflicts with these requirements.

## Impact

App routing/controllers, shared board/detail/chat/file components, public data adapters, existing writer and automation synchronization paths, Rusty public access management/read delivery, URL handling, reading-font tokens, documentation and focused acceptance tests. Preserve private encrypted workspace storage and existing board/card IDs. Rusty, frontend and automation Worker changes use their respective service pipelines; an implementation dependency does not create a shared deployment cohort or cross-service build-SHA gate. This planning step performs no commit, push or deployment.
