# tincanban

A board for keeping track of work, with cards, documents, and chat. Your data lives
in your browser. You can share a board with someone else or connect your own
second device and keep working across both.

[Try tincanban](https://match.meta-uber-engineer.dev/) · [Five-minute demo](docs/demo.md) · [Architecture](docs/architecture.md)

## What you can do

- Create a blank board or a job-search pipeline; edit cards, columns, and fields.
- Columns receive distinct default accent colors, stable across reordering and
  filtering. Set `board.columns[].color` to a six-digit hex value (for example
  `"#66b3ff"`) in Workspace settings JSON to override; omit it to restore defaults.
  Explicit colors may repeat.
- Attach documents, preview supported files, and download attachments.
- Render Markdown in card bodies, notes, chat, documents, and template previews.
  Task lists use `- [ ]` / `- [x]`. Editors can toggle tasks in cards, notes,
  editable documents, and template drafts; visitors and immutable chat/file
  previews remain read-only.
- Work locally, then synchronize with another online device.
- On reload, a full-screen loader stays visible until the saved board and fonts
  have rendered. The board then fades into view-only mode while local checks run.
  The same three dots appear in sequence on the startup screen and beside the
  compact floating notification. The notification shows the current stage
  without reserving space on the board, and fades away after checks finish. Editing becomes
  available after history and access checks succeed; failed checks preserve the
  saved view and show a retry message.
- Share selected boards with an editor or a read-only visitor.
- Publish a selected board as a read-only public link. Public copies include active
  cards, fields, selected-board/card discussions and attached files; viewers need no
  account or workspace invitation. Updates and withdrawal are explicit.
- Inspect item history and restore an earlier version without erasing history.
- Cards with saved messages show a count on their permanent chat icon. Open the
  thread with the latest saved activity from the icon; empty cards offer a new
  discussion on hover/focus. Select text for a quoted
  discussion, or right-click a card/field for the app's context menu. References
  return to their source. Reply opens a thread; workspace chat shows reply counts
  and collapsed read-only previews with Open controls. Item, discussion, and chat
  windows can move and resize together.
- Export a `.tincanban` workspace bundle. Identity secrets are not included.

tincanban is an experimental application. Keep an independent backup of important
work. Browser storage is a local copy, not a hosted backup service.

## Card aging

Inactive cards gradually turn olive and then brown after 7, 14, and 30 days.
Owners can change these thresholds under **Edit board → Edit item/lead**.
Editing a card, adding a note, or moving it to another column restarts its
activity clock. Reordering within a column does not.
Archived cards and columns named Done, Complete, or Completed are excluded.
The display calculates age locally; the passage of time does not write to the
shared document.

## Try sharing a board

1. Open tincanban in two browsers or browser profiles. Give each profile a different
   display name so it is easy to tell them apart.
2. In the first browser, create a board and a card.
3. Open **Sync → Add someone**, choose the board and role, and generate a link.
4. Open that link in the second browser, request access, and approve it in the first.
5. Edit a card as an editor and watch the other browser update. Reload the second
   browser to check that its access and data persist.

**Add my device** is a separate flow: it enrolls another device as the same user.
Compare the authentication codes and approve on the existing device. Use a fresh
profile for a demo so you do not enroll someone else's browser into your identity.

The header and tab icon follow the active board's confirmed connections. Green
means a live device channel or a successful Rusty replication pass within 45
seconds. Yellow means checking, catching up, or no configured connections; red
means configured connections are unavailable or their confirmation is overdue.
The header tooltip reports devices and Rusty separately. **Sync → Rusty** shows
each server's actual state and last successful sync in this tab. Saved settings
alone never count as connected. Reduced motion disables reconnecting animation.

Standalone Rusty now uses **Sync → Rusty** and protocol 2 encrypted object
storage. Its service key signs storage receipts; it receives no readable board
invitation, content key, or Editor/Visitor application grant. Board history and
chat are encrypted by clients, which still verify authorizations before merging.
See [keeper service](../mesh-lighthouse/README.md) for setup and migration.

### Public board links

Owners can open **Settings → Workspace → Publish board** to review and publish
that board's public copy. The public link is `/boards/<board-id>`. It shows active
columns, fields and cards, selected-board/card discussion messages with display
labels, and board/card attachments. Viewers can search, read and download; they
cannot edit, comment, enroll, or join the mesh. A public copy is a separate snapshot:
private edits do not change it until the owner chooses **Update**. **Unpublish**
blocks new snapshot and file reads; it cannot recall copies already downloaded.

Set the public frontend build variable `VITE_PUBLIC_BOARD_ORIGIN` to the compatible
Rusty HTTPS origin. Configure Rusty with its existing `RUSTY_TRUSTED_OWNER` root and
controller-device allowlist, plus the exact frontend CORS origin. Missing config or
Keeper capability disables publication with a clear error. Publication sends the
selected projection and separate file copies to Rusty; it never sends private access
keys, storage tokens, local file paths, or other boards. The Rusty service can
authorize its configured publication controller, but cannot inspect the encrypted
workspace to independently prove current board ownership. Workspace owners should
publish only through a client that confirms current owner rights. Rusty publication
storage and its binary require a separate compatible service rollout; frontend CI
does not deploy Rusty.

Optional public-view events use the existing diagnostics endpoint and consent. They
contain an ephemeral page session and public board entity ID, with viewer device and
workspace identifiers empty. No board title, card, discussion, field or file content
is sent. Leave `VITE_PUBLIC_BOARD_ORIGIN` empty to disable public board service calls.

Run `npm run test:e2e:public-board` for the isolated Chromium and WebKit flow against
a temporary local Rusty, including restart, file download and withdrawal. Run
`TINCANBAN_PUBLIC_E2E_PREVIEW=1 node scripts/public-board-e2e.mjs` to build with an
isolated loopback public origin and exercise the compiled anonymous-reader mock
scenarios in both browsers. The real owner-to-Rusty integration uses Vite's local
development server because its fixture reads private app state. Run
`cargo test --locked` from `../mesh-lighthouse` for native protocol and storage tests.

Readable protocol 1 services are no longer configurable in the application UI.
Existing deployments and grants require explicit migration to a fresh storage
volume. Private keys and attachment replication are not automatically transferred
to the new service.

The [demo guide](docs/demo.md) covers offline edits, attachments, and what to explain
when showing the project.

## Identity and access

- Enrolling into another identity requires explicit confirmation. The previous
  identity is backed up locally; enrollment does not merge people or their rights.
- Conflicting workspace IDs or owners stop the import without replacing the local
  board. A newer grant cannot be overwritten by an older network announcement.
- In **Sync**, an owner can select a visitor and choose **Make editor**.
- **Remove device** asks whether to apply to this board or all eligible boards,
  listing the affected boards. Editors can remove their own other devices; owners
  can remove other participants' devices only from boards they own. Removal is
  signed and survives reconnects. Reusing a removed device requires a new device
  identity; old local copies cannot be remotely erased. After opening a new member
  invitation, **Confirm reconnection** renews its device key under the same locally
  held identity root, then requests one owner approval for the new key. The owner
  rejects revoked keys before asking for approval. If the local removal record is
  missing, **Reconnect this device** opens confirmation after that rejection.
  This recovery action requires the locally held identity root. Enrolled devices
  without it require a fresh device identity issued by an authorized device.
- **Leave mesh** leaves the participant's membership on all their devices for that
  board, while preserving the identity and other boards. Owners must transfer
  ownership first. A peer must be connected to deliver the departure; the local
  copy remains read-only, and returning requires a new invitation.

Reload tincanban on both sides after this protocol update. Older clients cannot join
sessions until they support device removals and membership departures.

## Settings scopes

Deployment topology, source locations, infrastructure ownership and import-first
Hetzner/DNS configuration: [production architecture](../hetzner_playground/docs/architecture.md).

- **Identity:** display name, one profile photo across workspaces, encrypted identity recovery, device diagnostic consent.
- **Workspace:** shared document templates,
  priority rules and `employee_profile` for the named board, and a separate Advanced configuration tab for JSON.
- **Connections:** shortcuts to the single Participants/devices, Rusty storage and
  Backups views. Ownership succession and connection diagnostics belong to Sync → Advanced; workspace import
  and export belong to Backups.

**Workspace → Priority rules** supports job match priority: company recognition
20%, company stability 20%, stack match 30%, and work profile match 30%. Each
criterion contributes 10 for strong evidence, 5 for partial evidence, or 0 for
an explicit mismatch; missing or uncertain evidence earns no points. Default
bands are P0 ≥ 8, P1 ≥ 6, P2 ≥ 3, P3 otherwise; thresholds and card order remain
editable. Remote work alone adds no bonus.

Enter your stack and work profile, or import a JSON file containing
`{"employee_profile":{"stack":"…","work_profile":"…"}}`, then save. This profile
is shared with board participants and approved automations. Clef compares incoming
website vacancies with the latest admitted board profile and saves the assessment
in Source text. The board and intake use the same formula and configured bands.
Changing either profile field invalidates earlier stack/work comparisons while
retaining company scores. Existing/manual cards without assessments start at 0;
there is no automatic reclassification of historical cards. Existing weighted
rules stay active until **Use job match priority** is selected and saved.

Removing a participant explicitly revokes all their devices in that workspace.
Removing a single device remains a separate action. Both disclose their scope.
**Connections → Automations** lets the owner add a supported Worker instance, pause,
resume or remove it. Desired state is shared through CRDT. Confirmed state requires
a signed Worker acknowledgement of those exact commands. Reading access applies
to the entire workspace; grants last 30 days. New UI instances support website
job intake; email routing still requires deployment configuration.

## Run locally

Requirements: Git and Node.js 22 or newer. Rust is **not** needed to run tincanban:
the pinned MetaMesh dependency contains its prebuilt browser JavaScript and WASM.
Automerge also ships its compiled WASM in its npm package.

```sh
git clone --recurse-submodules https://github.com/bobishh/tincanban.git
cd tincanban
npm ci
npm run dev
```

For an existing checkout:

```sh
git submodule sync --recursive
git submodule update --init --recursive
npm ci
```

Open the local URL printed by Vite. A phone accessing a development server needs
a secure browser context for the cryptographic/browser APIs; use the HTTPS demo
for a two-device trial unless you have configured local HTTPS.

```sh
npm run build            # type-check and create dist/
npm run preview          # serve the production build locally
```

External sync diagnostics require a collector configured once per deployment.
Set the public frontend build values listed in [.env.example](.env.example): intake
URL, project, browser write key, level, sample rate and batch size. Both URL and key
are required; invalid values disable sending. Use `.env` locally or Cloudflare build
variables in production. These values become public browser assets; backend/desktop
secret write keys belong only in backend runtime secrets.

**Settings → Identity** contains only **Send diagnostics from this device** when a
collector is configured. The consent choice applies to this browser across
workspaces and survives reload. Old local collector URLs and keys are ignored;
explicit old opt-out survives. **Settings → Connections → Diagnostic delivery**
shows queued/dropped events, last confirmed send and delivery failures. The
collector must accept the [version 2 contract](openspec/changes/configurable-telemetry/design.md).
Local diagnostic snapshots remain available when external sending is disabled.
No message/card contents or raw errors are sent. IDs are complete and numeric
attributes retain their types. Chat/change events share an entity correlation
trace across devices; this does not measure precise cross-device network latency.

[MetaMesh](https://github.com/bobishh/meta-mesh) is a public repository pinned as a
Git submodule. No GitHub credentials or deploy key are required to fetch it. Its
packages are consumed from source; they are not currently published to npm.
Only contributors changing the Rust runtime need its [WASM build instructions](vendor/meta-mesh/scripts/build-wasm.sh).

## Verify changes

```sh
npm run verify:meta-mesh
npm run quality
npm test
npm run test:coverage    # unit HTML/JSON/LCOV report and regression floors
npx playwright install chromium
npx playwright test --project=core
```

The core browser suite exercises local UI and persistence. Network suites use real
Iroh connectivity and are separate so connectivity failures are visible:

```sh
npx playwright test --project=scoped-enrollment
npx playwright test --project=workspace-roles
npx playwright test --project=workspace-sync-data
npx playwright test --project=durable-mesh
```

[Coverage and typed lint](docs/testing/coverage-and-lint.md) explains report commands,
current regression floors, and existing lint debt. The [scenario audit](docs/testing/test-suite-audit.md)
records reduction candidates and the risks each surviving browser scenario must protect.
The complete [description inventory](docs/testing/test-description-inventory.tsv)
covers browser declarations, application/Worker units, meta-mesh package units,
and Rust test identifiers. Regenerate it with
`npm run --silent test:inventory > docs/testing/test-description-inventory.tsv`.
Parameterized declarations are marked; they are not expanded execution counts.

See [playwright.config.ts](playwright.config.ts) for all projects. CI runs the static
checks, unit tests, bundle budgets, dependency audit, and browser suites. Historical
measurements in [CODE_QUALITY_AUDIT.md](CODE_QUALITY_AUDIT.md) are dated snapshots,
not a substitute for the current CI result.
The verification jobs start independently: browser suites do not wait for the
unit/formal/UI jobs. The complete network project matrix remains automatic;
manual dispatch runs the same checks. Browser processes remain isolated per
network project, with three independent projects allowed concurrently. Core
shards still divide the retained UI suite; they are not a reduction in coverage.
Root Vitest runs vendored package tests once; native CI also runs Rust core rules.
Dedicated blind Rusty verification uses `playwright.rusty.config.ts` and requires
the matching binary from the sibling `mesh-lighthouse` checkout. The removed old
CI lifecycle job targeted a deleted project and a protocol-1 fixture; it cannot
verify the current blind-storage protocol. Publishing a pinned protocol-2 fixture
is still required before that dedicated check can run on GitHub.

## Recovery and verification

The [durable mesh browser suite](e2e/durable-mesh.spec.ts) exercises real Iroh
connections and browser storage, including:

- Unexpected transport-node closure: create a replacement node, reconnect, and
  synchronize edits in both directions without reloading or pairing again.
- Failed receive persistence: leave the saved document and journal unchanged,
  send no saved-state acknowledgement, then replay and acknowledge after storage
  recovers and the connection is re-established.
- Repeated disconnections with two tabs of one device: converge on edits, retain
  roles, and check that nodes, sessions, and timers do not accumulate. Each tab
  has an independent channel; opening a tab does not create another device.

An ownership handoff keeps its pending proposal separate from accepted authority.
While confirmation is pending, local document writes are blocked. Retrying uses
that same proposal; accepting the handoff stores the resulting ownership and
scope authority together.

MetaMesh also checks ownership/revocation, session generations, and batch delivery
with [executable protocol models](vendor/meta-mesh/formal/README.md). The runner
compares transitions against production Rust, explores bounded concrete states,
and requires deliberately broken implementations to fail. This is bounded
conformance testing, not a proof for every possible execution. Browser transport,
storage failures, and adapter wiring are tested separately by the scenarios above.
Recovery requires the peer, network, and storage to become available again.

Continuous workspace document synchronization runs its Rust/WASM scope state in
one dedicated browser worker. Scope effects still await storage before sending a
saved-state acknowledgement. Worker failures reject synchronization; they do not
retry the same computation on the UI thread. History admission and access checks
run sequentially in one shared policy worker, reusing its Rust/WASM instance.
Transport and lightweight lifecycle bookkeeping remain
in the browser's main context.

## Discuss objects

Use **Discuss** on an item or field, or select text and choose **Discuss selection**.
Messages keep signed references to their source. Item discussions and reply views
show the same records as workspace chat; replies quote their immediate target.
Select participants through **Invite @participant** to attach stable identity
mentions. Mentions retain workspace visibility and do not create private messages.

Item, chat, and discussion windows share movement, resizing, and focus order.
Windows and changed panels fade in; maximize and restore animate without slowing
dragging or keyboard movement. On phones, lead details use one compact heading,
a single scrolling row of stages with arrow hints for hidden buttons, and framed
content with a persistent scroll indicator. Reduced motion follows the device preference.
Mobile chat opens at viewport size without a maximize button. Its compact composer
keeps references and mentions behind **+**, leaving more room for messages.
Typing reuses saved message rows. Mobile boards use swipe navigation without a
separate column-switching toolbar.
Drag the title bar or resize handle; focused controls support arrow keys and
Shift for larger steps. **Next window** cycles views, including on narrow screens.
Window geometry stays local to each workspace. Native content zoom remains available.
Default illustrated avatars derive from participant identity and survive renames;
no image service or avatar upload is required.

**Copy message link** targets a committed message. Receiving devices must already
have workspace access; links do not download or join workspaces. Missing history,
unknown workspaces, loading failures, and revoked access have separate feedback.
Contextual messages require current, connected peer capability negotiation;
older peers must upgrade before rich messages can be sent. Existing plain chat
messages remain readable. The chat journal still retains at most 2,000 messages
or 4 MiB per scope.

## What to expect

- **Availability:** another device must be reachable to receive new data or fetch
  an attachment that is not stored locally. There is no permanent hosted replica.
- **Connectivity:** peers use Iroh discovery and relay infrastructure when needed;
  P2P does not mean infrastructure-free or guaranteed connectivity on every network.
- **Local startup:** Rust/WASM policy code loads before stored documents are opened.
  No network connection to another peer is needed, but local-first does not yet
  include a service worker guaranteeing a cold offline launch.
- **Permissions:** owner/editor/visitor checks run at command and replication
  boundaries as well as in the UI. Revocation reaches offline peers when they
  reconnect; it cannot erase copies they already hold.
- **Recovery:** ownership succession is a trusted-group feature, not Byzantine
  consensus. tincanban has no complete account recovery or stolen-device recovery UI.
  MetaMesh's recovery primitives alone do not supply that product flow.
- **Protocol updates:** refresh both peers when testing a new deployment.
- **Security:** signed changes and device certificates are implemented; the system
  has not received an independent security audit or Signal-equivalent guarantees.

## How it is built

Vue presents the board. Application modules coordinate commands, storage, and
collaboration. Automerge represents workspace history; IndexedDB stores local
snapshots and authorization records. MetaMesh supplies shared identity, protocol,
transport, and runtime primitives used by tincanban and Twang.

The [architecture notes](docs/architecture.md) explain these boundaries and the
remaining compromises. The [protocol and WebMCP reference](docs/protocol-and-tools.md)
contains the detailed feature and tool catalog.

### Blind Rusty storage

The standalone `../mesh-lighthouse` service now runs protocol 2 opaque storage. In **Sync → Rusty**, a board owner supplies the HTTPS origin and operator token. The browser generates the reading key locally and replicates encrypted board history, authorization proofs, and chat. Rusty receives no readable board invitation or application grant. Receivers still enforce signed causal admission. Attachments use existing device sync.

Private access files contain reading keys and storage tokens; transfer them privately to devices already authorized for the board. Settings are local to the identity on this device. Local disconnection does not revoke other storage credentials. Old plaintext Keeper volumes fail closed and require a fresh storage directory plus explicit client migration; old Keeper board grants must be revoked separately. Setup, quotas, storage-token revocation, and container configuration: [Rusty README](../mesh-lighthouse/README.md).

Cloudflare Worker + Clef ingestion uses an independent identity and an exact owner-signed Automation grant. **Settings → Connections → Automations** enrolls the Worker by owner signature and privately sends its activation packet; its workspace-wide reading scope is disclosed before approval. The real production Worker has created a synthetic Lead through live Clef and blind Rusty. Interview/Rejected transitions are verified locally; Gmail forwarding and a real received email are still pending. See [implementation evidence and rollout limits](openspec/changes/blind-keeper-and-scoped-automation/implementation.md) and the [Worker setup](workers/automation/README.md).

### TinSink log sign-in

TinSink can open `/service-login` to request explicit identity approval for one
project and workspace. The approval page shows the service origin and requested
scope before signing. Only a device with locally saved signed workspace authority
can approve; the server independently checks its certificate chain and role.
Owners and editors can read logs; visitors and automation cannot. Approval shares
public rights proofs, never documents, transport secrets or private keys. Global
TinSink administration and event write keys remain separate. Owners synchronize
the workspace before approving; editor access needs fresh owner confirmation in
TinSink and expires after 15 minutes without renewal.
