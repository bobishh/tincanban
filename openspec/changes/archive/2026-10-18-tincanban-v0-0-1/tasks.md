## 1. Product surface

- [x] 1.1 Create standalone Vue 3 + TypeScript + Vite app under `match/`.
- [x] 1.2 Render five Trello-equivalent columns: Lead, Applied, Interview, Offer, Archive.
- [x] 1.3 Add flat lead creation form with duplicate detection.
- [x] 1.4 Add selected-card detail panel with status controls.
- [x] 1.5 Add document attachment flow and visible document badges.
- [x] 1.6 Add IndexedDB persistence and JSON fallback export.
- [x] 1.7 Store workspace as Automerge bytes and export `.tincanban` bundle.

## 2. WebMCP

- [x] 2.1 Register flat imperative tools after first browser preview.
- [x] 2.2 Validate valid create/move/document tool calls against visible state.
- [x] 2.3 Validate invalid field and nested-payload failures without state corruption.

## 3. Merge and sync boundary

- [x] 3.1 Persist Automerge workspace document rather than JSON snapshots.
- [x] 3.2 Keep separate card/document IDs and include change state in export.
- [x] 3.3 Keep transport outside the Automerge merge boundary.
- [x] 3.4 Add browser iroh WebRTC/WASM adapter spike behind explicit experimental capability.
- [x] 3.5 Add QR invite, manual scan/paste, and app-layer peer authorization.
- [x] 3.6 Split `SyncTransport`, session protocol, and Vue flow; QR starts acceptance and the scanning browser joins after Connect to mesh.
- [x] 3.7 Retry transient browser bootstrap failures without a second user action.
- [x] 3.8 Keep the authenticated peer connection open and replicate later local commits in both directions.
- [x] 3.9 Reconcile IndexedDB through same-browser tab notifications and on tab focus.

## 4. Verification

- [x] 4.1 Add Playwright happy-path board/card/document flow.
- [x] 4.2 Add validation failure flow for missing company/role and duplicate URL.
- [x] 4.3 Add reload persistence check.
- [x] 4.4 Add responsive board/detail-panel check.
- [x] 4.5 Add protocol/session tests and isolated-profile QR pairing BDD coverage.
- [x] 4.6 Add isolated-profile BDD coverage for a post-pair card change.
- [x] 4.7 Add 390-by-844 BDD coverage for collapsed filters and snap-sized pipeline columns.
- [x] 4.8 Add same-profile two-tab IndexedDB reconciliation BDD coverage.

## 5. Mobile board

- [x] 5.1 Add a mobile-only filter disclosure, closed by default.
- [x] 5.2 Make pipeline columns snap one full portrait viewport at a time.
- [x] 5.3 Keep top actions horizontally reachable without wrapping the header.

## 6. Control layout

- [x] 6.1 Make TINCANBAN brand uppercase and lay out mid-size desktop filters without clipping.
- [x] 6.2 Add 1024-pixel BDD coverage for complete controls.
