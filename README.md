# Tincanban

Tincanban is a local-first board for cards, documents, files, and chat. Data saves
in your browser. Share selected boards with other people or connect your own
devices; offline edits synchronize when a peer or configured Rusty store becomes
reachable. Rusty stores encrypted copies without access to their contents.

Try the [web app](https://tincanban.meta-uber-engineer.dev/). The previous
[Match address](https://match.meta-uber-engineer.dev/) serves the same app. Browser
data is stored separately for each address; existing Match boards remain at the
Match address.

## Run locally

Requires Git and Node.js 22.12 or newer on the Node 22, 24, or 26+ lines. The
pinned MetaMesh submodule includes browser JavaScript and WebAssembly.

```sh
git clone --recurse-submodules https://github.com/bobishh/tincanban.git
cd tincanban
npm ci
npm run dev
```

Open the local URL printed by Vite. Other devices require HTTPS for browser
cryptographic APIs.

## Checks

```sh
npm run verify:meta-mesh
npm run quality
npm test
npx playwright install chromium
npx playwright test --project=core
sh scripts/check-sdk-core.sh
npx playwright test --project=quiet-peer-typing
```

Required CI runs Chromium on Ubuntu, with a 15-minute limit per job. WebKit
projects remain available for explicit browser-specific checks and do not block
ordinary releases.

Architecture checks run within `npm run quality`: dependency direction and cycle
rules include executable allowed/forbidden import fixtures; pattern rules reject
imports of SDK implementation files. `npm run quality:replica` separately checks
the headless product and automation boundaries. These checks enforce structural
contracts; domain ownership and client/server compatibility also require review
and behavior tests. See [architecture guidance](AGENTS.md).

The SDK core check generates fresh TLC graphs and includes every Rust library test,
including the large signed-history regression. Native SDK/service interoperability
runs in `npm run test:rusty-management`; build Rusty, `history_archive_verify` and
`verify_service_login` first. Missing binaries fail setup. Identity browser scenarios
run with `playwright.identity-bootstrap.config.ts` and an isolated Identity provider,
rather than being silently skipped by the core browser suite.

## Components

- [MetaMesh](https://github.com/bobishh/meta-mesh): identity, transport, and replication SDK.
- [Rusty](https://github.com/bobishh/rusty): optional storage for encrypted objects and signed receipts.

## Sign in and restore boards

Sign in saves the approved app device independently of board loading. The app then
loads the approved Identity catalog and existing board copies from its configured
Rusty services. The private catalog also discovers open devices of the same
Identity. If a board has no available Rusty copy, an approved device can receive
its signed history directly from an open owner device. This does not require
connecting that board to Rusty. Catalog discovery still needs an available
Identity catalog or a previously received peer address. Another copy must exist;
Identity alone does not contain board history or attachments. If loading is interrupted, the app stays signed in;
select **Retry loading boards**. Installed catalog access resumes after reload
without another sign-in. If Identity could not deliver catalog access, retry asks
Identity for a fresh catalog approval; the saved device approval remains valid.
An untouched
`Untitled` starter does not replace a restored board as the selected board.
Edited starters remain available and keep their current selection.

Retained boards open before network recovery. Once the catalog has arrived, a
resumed request with every catalogued board retained finishes locally. Missing
copies and their retry control appear in **Workspaces**, without covering an
available board. When saved connections contain different transport keys, the
app probes verified peer routes before selecting a connection; failed probes do
not replace local credentials or board history. A fresh device still needs a
verified board copy before this handshake can check its workspace authority.

Private Identity recovery state also retains signed workspace contacts and the
workspace transport credential. A restored device checks that evidence against
workspace authority before reconnecting to participants. A saved address is a
bootstrap contact, not proof that a device is online. The optional contact component
uses bounded compression while retaining support for earlier JSON snapshots;
decompressed data still passes the same signature and authority checks.
Direct peer delivery does
not wait for Rusty access registration; unavailable storage retries independently.
Legacy participant storage settings stay pending until the owner supplies current
signed access, preserving local edits in the meantime.

Identity supplies its approved Rusty services during sign-in. The optional
`VITE_PUBLIC_BOARD_ORIGIN` hint remains supported for older Identity profiles
that have not approved their catalog service yet and for reading original public
board addresses. It does not select or enable a board's publication server.

Board delivery stores full encrypted snapshots and, between them, document changes
with their signed write evidence. Browsers and automation use the same payload
reader; neither Rusty nor a storage receipt grants editing authority. History
baselines travel through owner checkpoints. Chat, access-policy and attachment
changes still send a full snapshot. Missing change dependencies pause that object
without advancing its cursor. Visible pages poll every two seconds; hidden pages
use a fifteen-second fallback and sync when visibility changes. A browser open
before the document-changes release needs a page reload. Rollback must retain
workspace snapshot reader version 3.

Identity delivery replaces redundant encrypted snapshots after eight retained
copies, once every stored state has been verified and merged. The replacement
preserves signed profile history, recovery evidence, and unknown optional
components. An incomplete or rejected state prevents replacement.

## Leave a workspace

**Leave mesh** ends local participation immediately, without another device online
or another owner approval. Choose whether to keep a read-only copy. Removing the
copy hides the board immediately; a durable local delivery queue retains its final
snapshot, signed history and locally available files. Delivery retries while the
app is open and resumes after reload. New local edits and chat messages are blocked.

A verified participant must confirm durable receipt of the final snapshot and
files before the hidden copy is cleaned up. The mesh propagates that received copy
to other participants. The sender then publishes its signed departure and retains
that proof separately to answer returning peers. Data still referenced by another
local identity is preserved. Owners must transfer ownership before leaving.

The frontend declares the `workspaceDeparture@1` reader contract. Clients that
observe this contract must support pending departures before continuing writes;
older tabs reload through the existing release compatibility check.

If an owned board's saved connections use different keys, **Sync** offers
**Create new connection**. This explicit owner action preserves the local board,
cards and signed authority, then creates a fresh connection key. Existing
participants and Rusty need new invitations. The installed key survives reload;
conflicting recovery evidence is never selected arbitrarily.

## Diagnostics

Browser diagnostics use the configured TinSink endpoint. The default `errors`
level retains error/fatal messages, failure events and failed operation/HTTP spans;
successful operation spans are discarded before export. Set
`VITE_SYNC_TELEMETRY_LEVEL=all` only for an explicit debugging session, then restore
`errors` and rebuild. `VITE_STARTUP_DIAGNOSTICS` normally stays `0`. Deployment
configuration does not override a device's saved diagnostics opt-out.
Cloudflare Workers Logs are disabled for the static frontend; TinSink diagnostics
remain independent of that setting.

## Public boards

Connect Rusty to a board in **Sync**, then enable **Public board** in
**Settings → Workspace**. The owner approves readable publication of that board's
visitor-visible content and attached files; private workspace history and keys
remain encrypted. The connected Rusty must advertise public-board publication.
With several connections, choose a publication server explicitly. Its address is
saved in the owner-signed board state so other authorized devices and automations
update the same public copy.

Copy the board address from the browser. Its publication location is included
automatically; visitors need no Identity or local board data. Existing devices
retain normal verified editing access at the same address. Original addresses
without a server parameter remain readable through the configured publication
server. Local navigation hints never deny an available public copy.

Changes reach the public copy while an authorized client or automation is running.
Disconnecting Rusty pauses delivery; the last published copy stays public until
the owner disables public access. Reconnect the same server to resume updates.
Disable public access before choosing another publication server. Withdrawal
stops anonymous reads; copies already downloaded cannot be recalled.

## Existing owner devices

A participant retaining a board can open **Sync → Connect owner device** to show
an expiring QR code and link. Open that link on a device already signed in to the
board's owner Identity and confirm the connection. The verified copy keeps its
workspace ID, ownership and participant roles, and joins the owner's catalog.
The source needs its retained board history and signed participant access.
A configured Rusty connection is transferred with its current owner proof; a
board without Rusty can reconnect directly between devices.
Existing owner copies with missing peer routes also reconnect through another
connected board of that Identity, merging both devices' retained edits.

## Workflow connections

Start **Connect board** from a Reflux Job search workflow. Tincanban lets the same
Identity choose an existing board and review the workflow's access before returning
to Reflux. The approval shows website and email intake, permitted columns and
fields, and its lifetime. Reading includes the entire workspace and its documents;
card writes follow the approved automation scope. The board needs a connected
Rusty writer. Interrupted delivery resumes the retained approval.

The project is experimental. Working offline requires the app to have loaded
first. Recovery words restore identity, not board history or attachments;
recovering those requires another copy.
