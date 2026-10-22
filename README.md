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

## Components

- [MetaMesh](https://github.com/bobishh/meta-mesh): identity, transport, and replication SDK.
- [Rusty](https://github.com/bobishh/rusty): optional storage for encrypted objects and signed receipts.

The project is experimental. Working offline requires the app to have loaded
first. Recovery words restore identity, not board history or attachments;
recovering those requires another copy.
