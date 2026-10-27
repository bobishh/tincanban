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
```

Architecture checks run within `npm run quality`: dependency direction and cycle
rules include executable allowed/forbidden import fixtures; pattern rules reject
imports of SDK implementation files. `npm run quality:replica` separately checks
the headless product and automation boundaries. These checks enforce structural
contracts; domain ownership and client/server compatibility also require review
and behavior tests. See [architecture guidance](AGENTS.md).

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

When `VITE_PUBLIC_BOARD_ORIGIN` is configured, sign-in discovers that Rusty service
and includes its exact address and key for approval in Identity. This lets an
older enrolled Identity profile find an existing catalog while its other devices
are closed. Identity retains the approved service pin in its signed profile;
discovery alone grants no access and does not connect a board to storage.

## Existing owner devices

A participant retaining a board can open **Sync → Connect owner device** to show
an expiring QR code and link. Open that link on a device already signed in to the
board's owner Identity and confirm the connection. The verified copy keeps its
workspace ID, ownership and participant roles, and joins the owner's catalog.
The source needs its retained board history and signed participant access.
A configured Rusty connection is transferred with its current owner proof; a
board without Rusty can reconnect directly between devices.

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
