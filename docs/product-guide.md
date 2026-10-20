# Product and feature guide

This guide collects user-facing behavior and service boundaries. For a short introduction and first run, see the [README](../README.md) and [five-minute demo](demo.md). Contributor architecture and test evidence live in [architecture](architecture.md), [protocol and tools](protocol-and-tools.md), and [testing notes](testing/coverage-and-lint.md).

## Contents

- [Board and card behavior](#what-you-can-do)
  - [Card fields](#card-fields)
  - [Card aging](#card-aging)
- [Try sharing a board](#try-sharing-a-board)
  - [Public board links](#public-board-links)
- [Identity and access](#identity-and-access)
- [Settings and job-search workflow](#settings-scopes)
- [Recovery and verification](#recovery-and-verification)
- [Discussions and chat](#discuss-objects)
- [Availability and security limits](#what-to-expect)
- [Architecture and connected services](#how-it-is-built)
  - [Blind Rusty storage](#blind-rusty-storage)
  - [TinSink log sign-in](#tinsink-log-sign-in)

## What you can do

- Create a board; configure cards, columns, and fields.
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
  available after saved-state and access checks succeed. An unchanged locally
  admitted snapshot reuses its atomic admission checkpoint without replaying or
  rewriting history. New evidence or a different application build triggers
  reclassification; failed checks preserve the
  saved view and show a retry message.
- Share selected boards with an editor or a read-only visitor.
- The visitor-access design gives a selected board one read-only public URL for its
  existing ID, settings and visitor-visible content. Authorized owner/editor/
  automation changes are designed to reach readers automatically; rollout remains
  incomplete (see **Public board links** below).
- Inspect item history and restore an earlier version without erasing history.
- Cards with saved messages show a count on their permanent chat icon. Open the
  thread with the latest saved activity from the icon; empty cards offer a new
  discussion on hover/focus. Drag cards from their title or surface; a full card
  follows the grab point and a quiet gap shows the insertion position. Click a card
  to open its details, where text selection creates quoted discussions and
  right-clicking a field opens discussion actions. References
  return to their source. Reply opens a thread; workspace chat shows reply counts
  and collapsed read-only previews with Open controls. Item, discussion, and chat
  windows can move and resize together.
- Export a `.tincanban` workspace bundle. Identity secrets are not included.

**Settings → Identity → Recovery backup** creates an encrypted recovery file for
the identity root, profile, workspace references and private Rusty connections.
Keep its recovery words separately. Restoration validates the complete package
before atomically replacing local identity state; interrupted secondary projection
can resume after reload. Restoring the same identity keeps this device's key and
local replication progress. Older root-only recovery files remain readable, with
their limited scope shown before restoration. Board history and attachment bytes
still need a workspace backup or an available Rusty copy; credentials alone do
not guarantee that a remote copy exists. Production availability depends on the
Rusty service release and this app's client release, each verified by its own CI.

**Settings → Identity → Private recovery backup** serves the
selected workspace, whose name is shown beside its controls. Each export creates
fresh words for that file. Switching boards during export does not change its
captured workspace; the downloaded backup’s scope remains beside its words.
Inspection does not change identity or workspace.
Creation requires the identity root private key on this device. It encrypts original local evidence, retained archive sources
and reading keys, and available attachment bytes with separate recovery words.
A device that received its history directly from another device can back up that
archive without Rusty credentials; missing parts are requested over the authorized
device channel. Unavailable archive objects and attachments make the backup
explicitly incomplete. Inspection authenticates the whole file, recomputes peer
archive coverage from retained objects, and checks original signed workspace
history before offering restoration. Restoring uses the same identity, requires
explicit consent before replacing an existing workspace, preserves the previous
local journal, and resumes interrupted private-state projection before startup
opens that workspace. Production availability depends on the Rusty service and
app releases that carry these formats; each is verified by its owning CI.

tincanban is an experimental application. Keep an independent backup of important
work. Browser storage is a local copy, not a hosted backup service.

## Card fields

Cards use the board's configured fields on private and public routes. The default board structure is data in
`src/board-templates.json`; creation has no jobs template or template selector. Existing values are never inferred or migrated.

Text fields default to literal text. Set `format` to `markdown`, `json`, or `code`
on a text field for that presentation; JSON fields validate JSON when saved, and
code is displayed without execution. Names such as “Source text” have no special
meaning. Automation writes its supplied source text directly, without an envelope.

Optional `board.cardPresentation` references field IDs with `titleFieldIds`,
`summaryFieldIds`, and `narrativeFieldId`; `openAfterSave` controls opening details
after a save. Without presentation settings, cards use their normal title/body
and configured fields. Field labels, types, options and formats roundtrip through
workspace settings and public publication.

Priority uses explicit `weighted-rules-v1` configuration. Unsupported saved
evaluators leave stored card values and ordering unchanged. Workflow types,
parameters and field/column mappings are declared under `board.automation`;
extension settings belong under `board.settings`.

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
Enrollment preserves the identity photo and the approving device's certificate
chain. Confirmed devices of the same identity also exchange private Rusty
connections over their authenticated device channel, including connections added
later. Each device keeps its own replication cursor; removals retain a tombstone.
These credentials never enter shared boards, public copies, or another person's
session. Older Rusty connections may require **Sync → Rusty → Update device access**
once from a device already approved by that server. This updates Rusty's signed
permission policy and keeps device certificates, boards and private connection
credentials unchanged. Background setup reports the required action; it does not
silently migrate permissions. Afterward an online Rusty can deliver board and
photo changes with the other device closed.

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
See [keeper service](https://github.com/bobishh/rusty/blob/main/README.md) for setup and migration.

The [architecture diagram](../openspec/changes/unified-device-and-replica-architecture/design.md#current-working-tree-boundaries)
separates Rusty's HTTP storage, direct device sync, private identity state and the
authorized automation Worker. Each service records its own deployed revision and
artifact evidence; app, Worker, Rusty and TinSink releases do not share a release
coordinator or activation cohort.

The writer upgrade also coordinates existing automation Workers:
it checks maintenance support before changing Rusty policy, retains the confirmed
receipt through interrupted retries, and waits for signed Worker confirmations
as independent post-sync maintenance. A verified Rusty policy receipt activates
this device's matching storage policy and retained progress before automation
confirmation. An unavailable automation cannot block ordinary board replication;
destructive snapshot/history cleanup waits for maintenance to finish. This refresh
preserves each Worker's approval and pending work; it does not renew its permissions. Older Workers require a compatible
rollout, and untyped live grants require explicit route adoption or removal.

Compatible Rusty services advertise owner-authorized snapshot checkpoints. After
eight retained snapshots, a caught-up owner client replaces their storage prefix
with one freshly encrypted snapshot carrying complete admitted document history
and the current bounded chat export. The local raw journal must contain no pending
or quarantined changes, including dismissed or resolved review records. Ownership
changes and unfinished local writes prevent cleanup. Signed receipts bind the
replacement and exact previous sequence; concurrent writers force another pull.
Uncertain delivery retries keep the same ciphertext and authorization. Snapshot
outboxes also retain their admitted storage sequence; after a checkpoint, Rusty
refuses new writes prepared against its older storage prefix. Older
services retain ordinary append-only replication, and automation write tokens
cannot authorize checkpoint deletion.

### Public board links

The visitor-access contract gives owners control of public access for the existing
board under **Settings → Workspace → Public board**. Canonical links use
`/boards/<board-id>/<title-slug>`; the older `/boards/<board-id>` path remains
valid. The ID selects the board and the slug is descriptive. The shared visitor
presentation covers public and invited visitors, including archive visibility,
fields, collapse settings, discussions and files.
Public readers can search, read and download; they cannot edit, comment, enroll or
join the mesh. Owner, editor and approved automation changes follow the existing
board's authorized write path and are intended to update public readers
automatically. Disabling public access stops future reads; it cannot recall bytes
already downloaded.

The shared visitor-access implementation is present in source. Final integration
acceptance and production release remain pending; source changes and focused unit
tests do not establish production behavior. Public data remains in Rusty's
publication namespace, separate from encrypted workspace records.

Set `VITE_PUBLIC_BOARD_ORIGIN` to the Rusty HTTPS origin. Configure Rusty with its
existing `RUSTY_TRUSTED_OWNER` root and controller-device allowlist, plus the exact
frontend CORS origin. Missing config or publication capability disables public
access with a clear error. Public read storage
contains a board-scoped readable representation and file copies; private keys,
storage tokens, local paths and other boards stay outside that scope. Rusty cannot
inspect private workspace history or prove that a submitted projection matches
it. Honest clients and the Worker derive updates from locally admitted source;
signed source heads bind the writer's assertion but are not server-side proof of
private CRDT admission. Revocation applies when the signed checkpoint reaches a
writer. Frontend and Worker, Rusty, and TinSink/platform configuration use
separate CI and release paths. No release cohort is required; an unavailable
optional diagnostic exporter does not block board use. See the [Rusty service
operations guide](https://github.com/bobishh/rusty/blob/main/README.md).

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
`npm run test:rusty-management` separately exercises signed management status,
policy migration, enrollment, encrypted checkpoints and attachment client
restart/retry/cold-receiver recovery over real native HTTP,
without a browser. The archive case also runs the Native verifier against actual
Rusty receipts and recovered ciphertext, then binds a compact admitted-state basis
to that exact archived preparation. The same case signs an initial Owner proposal
through the JavaScript identity SDK and confirms it with Native policy. That case
exercises preparation; browser acceptance separately covers cold receiver
validation, atomic local baseline activation, archived revision reads and offline
recovery. Worker runtime checks cover freeze/activation. Build the current Rusty binary first,
then build `history_archive_verify` with
`cargo build -p meta-mesh-core --example history_archive_verify` from
`vendor/meta-mesh`. Set `TINCANBAN_RUSTY_BINARY` or
`TINCANBAN_HISTORY_VERIFY_BINARY` when either binary is outside its default debug
checkout. Ordinary unit tests do not require these binaries. This integration
adapter's JSON result is test evidence, not baseline activation authority.

Readable protocol 1 services are no longer configurable in the application UI.
Existing deployments and grants require explicit migration to a fresh storage
volume. Private keys and attachment replication are not automatically transferred
to the new service.

The [demo guide](demo.md) covers offline edits, attachments, and what to explain
when showing the project.

## Identity and access

- Enrolling into another identity requires explicit confirmation. The previous
  identity is backed up locally; enrollment does not merge people or their rights.
- Conflicting workspace IDs or owners stop the import without replacing the local
  board. A newer grant cannot be overwritten by an older network announcement.
- In **Sync**, an owner can select a visitor and choose **Make editor**.
- **Remove my device** records the exact device, eligible workspaces, and all configured Rusty origins before starting. Each signed workspace revocation and each server confirmation is retained. An offline server or denied authority leaves its exact reason and a retry action across reload; completed scopes are not rotated again. Newly configured servers require separate confirmation after the original removal finishes. Completed devices leave this browser’s active list and remain in Removed device records. The underlying additive identity catalog can still contain the device on other browsers; only the listed signed workspace and server revocations are confirmed. This does not invalidate its identity certificate globally or erase old copies. Generated device labels are names, not hardware identification; available browser/platform data and short device IDs distinguish records.
- **Remove device** for another participant asks whether to apply to this board or all eligible boards,
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
Hetzner/DNS configuration: see the separately maintained production architecture notes.

- **Identity:** photo and display name in one compact profile form, one Save profile action, the selected workspace’s complete private recovery flow, and separately labelled identity-only recovery.
- **Workspace:** ordinary .tincanban export/import, Archive older history maintenance, board save/sync status, owner-confirmed Public board switch, automation management, and diagnostic delivery. Diagnostic consent applies to this device across workspaces; support counters and device information are collapsed.
- **Document templates**, **Priority rules**, and **settings.json:** separate sections in a flat left-hand navigation. Priority and JSON save actions remain visible while content scrolls.
- **Sync:** one screen with participants, their devices, successor actions directly beside the selected participant, a separate persistent Rusty storage block supporting multiple servers, and Leave mesh. Live device channels reconnect automatically. Import as a new board is also available in the Workspaces list.

See [browser diagnostics](diagnostics.md) for exporter configuration, consent,
data limits, and the evidence boundary.

**Settings → Priority rules** supports job match priority: company recognition
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

Automatic priority changes calculation from saved assessments; it does not start or stop CLEF. Pause or resume the automation separately under Workspace.

Removing a participant explicitly revokes all their devices in that workspace.
Removing a single device remains a separate action. Both disclose their scope.
**Workspace → Automations** lets the owner add a supported Worker instance, pause,
resume or remove it. Desired state is shared through CRDT. Confirmed state requires
a signed Worker acknowledgement of those exact commands. Reading access applies
to the entire workspace; grants last 30 days. New UI instances support website
job intake; email routing still requires deployment configuration.

Existing instances are managed separately from initial enrollment. The owner can
inspect an expired approval without allowing the Worker to execute it. **Renew
approval**, **Adopt existing Worker**, enabling email and enabling vacancy evidence
show workspace-reading access and the new 30-day term before explicit confirmation.
Adoption retains the same executor, routing address, saved events and pending
replication; Retry connection does not silently renew an expired approval.

Automation settings show connection, approval and forwarding configuration. Retained
email events, matching decisions, bindings and retries belong to the signed automation
API; no processing history or manual email review queue is rendered in settings.

## Recovery and verification

The [durable mesh browser suite](../e2e/durable-mesh.spec.ts) exercises real Iroh
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
with [executable protocol models](../vendor/meta-mesh/formal/README.md). The runner
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

- **Availability:** new data needs a reachable device or a configured Rusty holding
  its encrypted copy. An attachment absent locally needs a reachable source or
  confirmed Rusty file coverage. Local saved data remains available offline.
- **Connectivity:** peers use Iroh discovery and relay infrastructure when needed;
  P2P does not mean infrastructure-free or guaranteed connectivity on every network.
- **Local startup:** Rust/WASM policy code loads before stored documents are opened.
  No network connection to another peer is needed, but local-first does not yet
  include a service worker guaranteeing a cold offline launch.
- **Permissions:** owner/editor/visitor checks run at command and replication
  boundaries as well as in the UI. Revocation reaches offline peers when they
  reconnect; it cannot erase copies they already hold.
- **Recovery:** encrypted identity recovery and private workspace recovery are
  separate flows with the scopes described above. Missing board/file copies cannot
  be reconstructed from recovery words alone. Restoring identity does not itself
  revoke a stolen device or rotate previously disclosed access. Ownership succession
  is a trusted-group feature, not Byzantine consensus.
- **Protocol updates:** refresh both peers when testing a new deployment.
- **Security:** signed changes and device certificates are implemented; the system
  has not received an independent security audit or Signal-equivalent guarantees.

## How it is built

Vue presents the board. Application modules coordinate commands, storage, and
collaboration. Automerge represents workspace history; IndexedDB stores local
snapshots and authorization records. MetaMesh supplies shared identity, protocol,
transport, and runtime primitives used by tincanban and Twang.

The [architecture notes](architecture.md) explain these boundaries and the
remaining compromises. The [protocol and WebMCP reference](protocol-and-tools.md)
contains the detailed feature and tool catalog.

### Blind Rusty storage

The standalone `../mesh-lighthouse` service runs protocol 2 opaque storage. In **Sync → Rusty**, a board owner supplies the HTTPS origin and approves access with the device's signature. The browser generates reading keys locally and replicates encrypted board history, authorization proofs, chat and attachment chunks. Rusty receives no readable board invitation or application grant. Receivers still enforce signed causal admission. Verified receipts for every manifest and chunk establish attachment coverage; a recipient can fetch verified files after the source device closes.

The owner configures Rusty for the board. Authorized participant sessions distribute an owner-signed, board-scoped connection automatically: editors receive reading and writing access, visitors reading access only. Participants can forward the original owner attestation and only access they already hold. Once received, Rusty delivery works with all owner devices offline. A device without any connection information still needs one reachable authorized participant for initial setup. Sync shows the received connection and its actual delivery status; only the owner can add or remove servers.

Private identity storage and management credentials are separate. Private Rusty settings travel between approved devices of the same identity through authenticated enrollment and encrypted identity replication; personal catalogs and unrelated connections never cross identities. Each device keeps its own cursor and upload progress. Participant connections do not enroll the recipient's private identity on the owner's Rusty service.

Signed admission and current membership checks continue to apply. Local disconnection does not revoke other storage credentials. Rusty protocol 2 uses bearer tokens: previously delivered tokens, keys and plaintext cannot be recalled by hiding a connection or removing a peer. Confidentiality of future content after removal requires the owner credential/key rotation workflow; this change does not add server-enforced per-person token revocation. Private access files contain reading keys and storage tokens and belong only on already authorized devices. Old plaintext Keeper volumes fail closed and require a fresh storage directory plus explicit client migration; old Keeper board grants must be revoked separately. Setup, quotas, storage-token revocation, and container configuration: [Rusty README](https://github.com/bobishh/rusty/blob/main/README.md).

Cloudflare Worker + Clef ingestion uses an independent identity and an exact owner-signed Automation grant. **Settings → Workspace → Automations** enrolls the Worker by owner signature and privately sends its activation packet; its workspace-wide reading scope is disclosed before approval. The real production Worker has created a synthetic Lead through live Clef and blind Rusty. Interview/Rejected transitions are verified locally; Gmail forwarding and a real received email are still pending. See [implementation evidence and rollout limits](../openspec/changes/blind-keeper-and-scoped-automation/implementation.md) and the [Worker setup](../workers/automation/README.md).

### TinSink log sign-in

TinSink opens `/service-login` for explicit approval of its exact service domain.
No project or workspace ID is entered before signing in. The deployment trusts a
native owner identity and controller devices, using Rusty's existing public trust
configuration shape. That owner enters the full console; signed native owner and
editor rights discover accessible boards for other identities. Visitors and
automation cannot read logs. A self-created unrelated scope cannot claim an
existing service's board logs. Board and project filters appear after sign-in.

Approval shares public certificates and rights proofs, plus local board labels;
no documents, transport secrets or private keys. Sessions last eight hours with
stored signed revocations rechecked on every request. Synchronize boards before
approval: this offline system cannot know a revocation not yet delivered to the
service. Owner-confirmation timers and manual workspace linking are removed.
