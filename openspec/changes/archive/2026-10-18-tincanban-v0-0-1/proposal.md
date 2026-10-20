## Why

Job-search work currently lives across Trello cards, local CV/cover-letter folders, and agent conversations. tincanban provides one visible board where a lead, its next pipeline status, and its documents stay together. The app remains local-first and deployable as a static web app.

## What Changes

- Add a standalone Vue 3 + TypeScript tincanban app under `match/`.
- Render the exact pipeline used by the Trello board: Lead, Applied, Interview, Offer, Archive.
- Represent each vacancy as one flat card. Do not require organization records, application records, or setup flows.
- Attach CVs, cover letters, notes, and file references directly to cards.
- Persist local workspace data in IndexedDB as an Automerge document and export a `.tincanban` bundle.
- Include an experimental browser iroh/WASM adapter for device transport, surfaced as an explicit sync action.
- Pair devices through a QR invite containing the iroh endpoint and a random app-layer authorization secret.
- Expose a flat WebMCP command surface over the same visible mutations.
- Keep Automerge as the merge/storage boundary and iroh as the experimental device transport; do not expose CRDT payloads to the UI or agent.

## Non-Goals

- Accounts, backend database, hosted source of truth, or server-side auth.
- Trello API synchronization.
- Organization/company entity management.
- Activity/event timeline.
- Automatic internet crawling inside the app.
- Finder integration requiring a native shell.

## Impact

- New `match/` frontend project.
- New local workspace schema for flat lead cards and attached documents.
- Future sync can exchange document changes without changing WebMCP or UI commands.
