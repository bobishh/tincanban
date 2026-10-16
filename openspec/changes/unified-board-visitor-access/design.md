## Verified starting point

Source inspected on 2026-10-16:

- `src/main.ts` selects a separate public startup for `/boards/<id>`.
- `src/public/PublicBoardContent.vue` reuses `BoardItemCard`, but owns different column, card-detail, chat and file presentation. Reusing a card component alone does not establish UI parity.
- `src/components/PublicBoardControls.vue` lives inside Settings and exposes `Update public copy`. Its current contract leaves subsequent edits private.
- Rusty stores acknowledged public data separately from private encrypted workspace objects. It cannot derive readable board updates from ciphertext or authorize them from a storage token alone.
- The actual public response for board `9931dca2-2644-403e-9c4b-502ad75ee212`, revision 1, contains no `board.presentation` and no column collapse/color metadata. A frontend rewrite cannot recover those missing source settings by guessing.
- The previous publication contract excludes archive content. The replacement must follow the board's visitor visibility rules instead of preserving that separate exclusion policy.
- `src/styles/design-system/tokens.css` sets the root to 20px. `reading-fonts.css` uses `1rem` for Fira prose, carrying the handwritten UI's 20px base into dense descriptions/chat.
- `src/domain/history.ts` currently constructs `authorLabel` as `personId / deviceId`; `ItemHistoryPanel.vue` renders that string without resolving a person's name. The screenshot's author line is an identity/device pair, not a person's name or an ordinary SHA checksum. History also exposes internal operation names such as `migrateWorkspaceFormat`.
- `SpatialWindow.vue` adds borders to property grids, source text and the quick-note wrapper; `ScrollFrame.vue` adds another outer content border, and history rows have their own boxes. `primitive.css` decorates several of those surfaces again. These independent rules explain the stacked outlines; they do not encode a consistent section hierarchy.

## Product contract

A public board is the existing board viewed with visitor capabilities. Public/private is access state, not a command to create, edit or refresh another board. All authorized source changes and board settings belong to that same board and are delivered to its readers automatically.

The public-access switch explains that enabling it exposes the board's visitor-visible content and subsequent changes. Disabling it stops subsequent anonymous reads. Previously downloaded bytes cannot be recalled. Other boards, workspace-wide private chat, identity secrets and private transport credentials remain outside the board's public read scope.

## Shared rendering boundary

Introduce one display contract consumed by the actual shared board surface and its existing visitor detail/chat/file components. Private and anonymous data adapters may differ; templates, layout rules, setting interpretation, filtering and responsive windows must not fork by access origin. Components receive data, availability and capabilities rather than a `public` flag selecting a second layout.

Retain existing private visitor behavior and mutation checks. Anonymous visitor capability cannot create a participant, grant or identity, start private sync, or write to the board. The shared UI can display missing/unavailable data through the same state components; it must not fabricate history, authorship or successful file availability. Type compatibility must not be obtained by inventing a private workspace document or write authority.

Delete `PublicBoardColumns.vue`, `PublicBoardChat.vue`, `PublicFiles.vue` and the custom public detail template once replaced. A route/controller adapter can remain to fetch and validate public data, manage retry and feed the shared view.

## Settings and data

Use the existing board/card/column/field IDs. The authoritative board defines preset bindings, column colors, archive destination, independent collapse capability, stage controls, aging and computed card summaries. Both adapters use shared pure presentation helpers. Public transport carries the allowed board settings and effective displayed values; it must not reconstruct a different domain from titles or raw field values.

`Column.collapsible` is shared board configuration. Whether an individual viewer has currently folded an allowed column remains their local preference, using the same defaults and filter overrides as other visitors. Do not synchronize everyone's open/closed state or turn every column collapsible. Archive/lifecycle visibility follows the same visitor rules, including any archive surface visible to that visitor.

## Automatic public delivery

Keep one canonical board write/admission path. Public read delivery is a derived serving representation of that board, bound to its ID and admitted source state; it has no independent title, settings, edits, content-selection controls or user-managed version. A server read representation is an implementation necessity for anonymous reads while source devices are offline, not a second product object.

Persist public access state and its generation at the existing board/access authority boundary. Every authorized writer path that can change a public board must integrate with durable public delivery: owner/editor devices, received/admitted peer updates and approved automation. Reuse existing causal admission and resource/device management authority; a blind storage write token is not application write authority. Enabling/disabling public access remains owner-only.

For a committed source change, durably record pending public delivery bound to board ID, source state and access generation. Coalesce updates only when the newest admitted state contains the pending changes. Retry the same uncertain delivery, verify durable acknowledgement, and resume after process/browser/Worker restart. Local save success and public delivery confirmation remain distinct observations; public delivery must not block offline local edits.

Rusty must enforce the current resource/device authorization, exact source binding, public-access generation and conditional update before accepting readable data. After a conflict, the writer admits current board state through normal sync and recomputes; it must not blindly overwrite a newer serving state. Preserve one coherent content/settings/file manifest per acknowledged state. Unavailable files produce an explicit pending/error state rather than a falsely complete new revision.

Public readers subscribe to change notifications or perform bounded revalidation, reuse unchanged data and update in place. A five-second visible-page revalidation interval is the initial fallback; focus/reconnect triggers an immediate check. Preserve search, local collapse choices and open windows whose objects still exist. Withdrawal clears board content and open windows when its response is received; transient network failures preserve the last confirmed view with current retry status.

**Rejected shortcuts:** a timer mounted in Settings; automatic republishing only from the owner's active tab; changing `Update public copy` into a hidden automatic click; loading the private app to reuse its UI; giving anonymous readers private decryption keys; making a public data adapter guess absent settings.

## Addressing

Canonical browser path: `/boards/<board-id>/<title-slug>` for public and private boards. Keep `/boards/<board-id>` valid. The board ID resolves the object; the optional slug only makes it readable. Normalize a stale slug to the same ID after the authorized title is known. Preserve query/hash message targets. Back/Forward changes the active board, reload reopens the addressed board, and renamed boards retain their ID and old links.

Private navigation may use a non-authoritative local route index to find the containing workspace, then applies normal identity, storage and role checks. A hint or URL cannot grant access. If the board is not available locally, resolve public visitor access or show the ordinary access-required/unavailable state. Do not silently open the last-used unrelated board, enroll a user, or mark a private board public. Fresh anonymous public navigation still creates no identity/workspace and starts no private storage, policy or mesh runtime.

## Reading typography

Keep the existing Caveat scale for board summaries, headings, navigation and controls. Define a separate Fira Sans prose token: 16 CSS px at the default browser scale, line-height 1.5, regular weight; use the same token for detail bodies, source text, chat messages and the chat composer. Do not inherit the 20px handwritten root through `1rem`. Relative units may use an equivalent explicit conversion, while browser zoom and accessibility text enlargement continue to work.

Long URLs wrap inside content width. Technical identifiers use the existing Fira Code style with a subordinate scale. Avoid oversized paragraph spacing, fixed-height text containers and global font/root changes. Verify prose, labels and controls together at desktop and 390px, with a long description, link, identifier and multi-paragraph discussion.

## Semantic presentation

| Content role | Presentation |
| --- | --- |
| Product identity, navigation, section headings, short labels and board summaries | Existing Caveat treatment |
| Descriptions, messages, quick-note/composer input, long help and explanatory/error text | Compact Fira Sans reading tokens |
| Names of people/devices, readable history actions and timestamps | Shared concise metadata styles; do not inherit prose size or technical-ID treatment |
| Hashes, keys, actor/person/device IDs and other machine values | Subordinate Fira Code technical token, safely wrapped and fully available to copy |
| Ordinary source link | Readable link label in the appropriate surrounding text style; the full URL remains available without forcing every link into a technical block |

Give shared components explicit semantic classes/tokens. Do not infer typography from matching a hex-looking string, its nesting depth, whether a route is public, or incidental selectors such as `strong`/`p`. A SHA-looking value in user prose is not automatically rewritten. Technical metadata supplied by the application is explicitly marked as technical. Headings embedded in prose retain the reading hierarchy instead of switching the entire message to the UI font. Empty/pending/error explanations follow the same semantic rules as nonempty content.

History resolves a stable person ID to an available verified member/profile display name, with the relevant device label as secondary information when useful. Display names are labels, never authority. Keep the original IDs and provenance intact under expandable details with copy controls. For unavailable identities, show a neutral unknown-author label; imported, system-maintenance and archived/unverified attribution remain distinguishable. Never invent a name or promote an unverified author claim into a verified person. A known operation uses a human action label (for example, a workspace format migration); its raw operation key belongs with technical details. Preserve the order, hash, signed evidence and restore behavior.

One outline identifies a window. Inputs and buttons keep their interactive boundaries. Description, properties, documents, history and quick-note sections use clear headings, consistent spacing and at most one needed separator between peers. A quick-note form must not add a frame around an already framed textarea merely because it is a form. History uses readable rows rather than a stack of framed cards inside another framed scroller. At wide layouts, use spacing or one inspector divider; at narrow layouts, remove the now-meaningless vertical divider. Scroll indicators are functional controls/indicators, not additional section borders. Keep keyboard focus visible on the focused interactive target without outlining unrelated ancestor regions.

The Rusty screenshot also contains `Module terminated` and missing profile delivery. Those are runtime/connection observations, not font defects. Preserve the actual failure for diagnosis and provide a readable status and available recovery action; typography cleanup must not turn the connection green, hide the failure or claim its cause has been established.

## Migration and verification

Preserve existing board IDs/links and confirmed public access. Hydrate legacy serving records from the actual admitted source board, through authorized automatic delivery; do not require the owner to republish or manufacture missing metadata. Until source data is available, do not claim settings have been synchronized. Migrate existing access/management records without creating a duplicate board or making a private board public. Preserve files and old confirmed data through interrupted migration.

First author acceptance contracts; finish the rendering, delivery, addressing and typography blocks before running browser acceptance. Confirm focused non-browser regressions red before implementation; use the cheapest sufficient checks afterward. Product scenarios must include an editor/automation update while owner devices and Settings are closed: a passing mock reader refresh is insufficient evidence for automatic delivery.

Final release requires required checks and artifact evidence from each owning service pipeline. Rusty, frontend and automation Worker release independently; there is no shared cohort or cross-service build-SHA gate. Fix any failing asset verification in the pipeline that owns that artifact. Do not substitute a ready health endpoint for successful release completion or claim the user's phone was checked.
