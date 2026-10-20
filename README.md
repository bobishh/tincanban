# tincanban

tincanban is a local-first board for work, notes, files, and conversation. Create
boards in a browser, keep working offline after the app loads, and share selected
boards with other people or devices. Job search is one use case; the board and
chat model is general-purpose.

Rusty connection recovery on a device talks directly to Rusty. It requires the
signed replacement policy, confirmation of the exact original pending upload,
and a fresh snapshot receipt. Reflux availability and automation credential
rotation do not gate this flow. Earlier automation proofs remain in the retained
recovery journal; automation credentials require separate maintenance after a
device replaces conflicting credentials.

If Rusty rejects a fresh upload because its storage checkpoint advanced, board
and profile sync admit the newer checkpoint before replacing that exact rejected
request. Uncertain uploads retain their original ciphertext and request identity;
successful uploads still require a signed receipt.

A board for keeping track of work, with cards, documents, and chat. Your data lives
in your browser. You can share a board with someone else or connect your own
second device and keep working across both.

Illustrative local build with synthetic data.

The deployed [HTTPS demo](https://match.meta-uber-engineer.dev/) is the fastest
way to try it. Follow the [five-minute demo](docs/demo.md) with two disposable
browser profiles. It covers editing, sharing, offline changes, attachments, and
history.

## Run locally

Requirements: Git and Node.js 22.12 or newer (Node.js 22, 24, or 26+ for
Vitest). Rust is not needed for the app; the pinned MetaMesh submodule includes
its browser JavaScript and WebAssembly.

```sh
git clone --recurse-submodules https://github.com/bobishh/tincanban.git
cd tincanban
npm ci
npm run dev
```

Open the local URL printed by Vite. A second physical device needs a secure
browser context for cryptographic APIs; use the HTTPS demo or configure local
HTTPS. See [contributor checks](#contributor-checks) before submitting changes.

## How the pieces fit

| Component | Repository | Role |
| --- | --- | --- |
| tincanban | This repository | Board, chat, attachments, access rules, local storage, and product workflows |
| MetaMesh | [MetaMesh repository](https://github.com/bobishh/meta-mesh) | Reusable identity, protocol, transport, and replication SDK; consumed here as a pinned submodule |
| Rusty | [Rusty repository](https://github.com/bobishh/rusty) | Optional HTTP storage for opaque encrypted objects and signed receipts; it does not join board Automerge/CRDT replication or act as an editor |

See [ecosystem roles and boundaries](docs/ecosystem.md) for the fuller map,
including source, acceptance, and deployment responsibilities.

## What to expect

- Boards save to browser storage first. Other copies depend on a reachable peer
  or a configured Rusty store; there is no hosted account service.
- Offline edits synchronize after devices reconnect. The app does not guarantee
  a cold offline launch before its application files have loaded.
- Signed changes and device certificates enforce access. Revocation reaches
  offline devices when they reconnect; it cannot erase data or keys already held.
- Identity recovery and board-history recovery are separate. Recovery words do
  not contain board history or attachment bytes.
- The project is experimental and has not had an independent security audit.

These limits and the demo's exact coverage are described in the
[demo guide](docs/demo.md) and [architecture notes](docs/architecture.md).

## Contributor checks

```sh
npm run verify:meta-mesh
npm run quality
npm test
npx playwright install chromium
npx playwright test --project=core
```

See the [contributor setup and checks](docs/contributor-checks.md) for the
existing-checkout setup, browser matrix, coverage reports, and CI boundaries.
The
[protocol and tool reference](docs/protocol-and-tools.md) and
[architecture notes](docs/architecture.md) hold implementation detail. See
[browser diagnostics](docs/diagnostics.md) for exporter configuration and limits.
User-facing behavior is in the [product guide](docs/product-guide.md).
