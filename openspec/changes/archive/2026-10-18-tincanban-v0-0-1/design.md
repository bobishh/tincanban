## Context

tincanban must feel like the existing Trello workflow, not like a CRM. The agent should be able to add a vacancy with one flat payload, then attach documents with separate simple commands. The browser renders the same state the agent mutates.

## Decisions

### 1. Card is the domain unit

`Lead` contains company and role strings directly. `Organization`, `Application`, and `ActivityEvent` are not v0.0.1 entities.

```ts
type Lead = {
  id: string
  company: string
  role: string
  url?: string
  location?: string
  workMode?: "remote" | "hybrid" | "onsite" | "unknown"
  status: "lead" | "applied" | "interview" | "offer" | "archived"
  priority?: "p0" | "p1" | "p2" | "p3"
  fitScore?: number
  description?: string
  notes?: string
  sourceText?: string
  createdAt: string
  updatedAt: string
}
```

### 2. Documents attach by id

Documents are separate records with `leadId`. The card detail view joins them locally and shows document badges on the card. MCP create/update calls remain flat and small.

```ts
type Document = {
  id: string
  leadId: string
  kind: "cv" | "cover_letter" | "note" | "attachment"
  title: string
  format: "markdown" | "html" | "pdf" | "path"
  content?: string
  localPath?: string
  createdAt: string
  updatedAt: string
}
```

### 3. One command surface

Visible UI and WebMCP use the generic workspace command boundary. Job-search cards are ordinary items with seeded typed fields. WebMCP exposes workspace, item, entity, settings, recovery, and chat commands; it does not expose preset-specific aliases. Schemas reject unknown fields, and no nested CRDT payload crosses the boundary.

### 4. Duplicate handling

The app checks exact normalized source URL first, then company + role. It returns a possible duplicate for agent/user review instead of silently creating a second card or forcing an organization setup flow.

### 5. Local storage and sync

IndexedDB stores the serialized Automerge workspace document in v0.0.1. A `.tincanban` export contains a manifest, readable card/document JSON, and the Automerge bytes. `updatedAt` is display metadata, never conflict resolution. No LWW policy is part of the domain model.

Device sync has a transport boundary:

- Automerge owns document state and merge.
- `SyncTransport` is a port. `iroh-webrtc-transport` browser/WASM is the current experimental adapter.
- `SyncSession` owns authenticated request/response/ack sequencing; an adapter exposes only nodes, connections, and streams. Vue invokes the session through `useDeviceSync`.
- The QR invite carries protocol version, remote endpoint id, and a random bearer secret.
- The first stream frame carries the same secret. The receiver rejects a missing or mismatched secret before calling Automerge merge.
- Opening Sync starts the acceptor and QR generation immediately. Opening or pasting the link prepares the scanning browser; one Connect to mesh action starts joining. There are no initiator/responder controls in the UI.
- Browser address publication can lag node startup. The join session retries a transient bootstrap failure while the pairing dialogs remain open; retry does not alter Automerge or UI state.
- After the authenticated snapshot handshake, the connection remains open. Each local Automerge commit sends an authenticated update frame to the paired peer; remote merges do not echo back. Live sync lasts only while both tabs keep the peer connection open, not across reloads.
- Same-profile browser tabs announce completed IndexedDB writes through `BroadcastChannel`; receiving tabs re-read and merge the persisted Automerge document. Returning focus also reconciles IndexedDB, covering background tabs that missed an announcement.

The browser adapter comes from canonical `@meta-uber/mesh-transport/wasm`. Its browser-only dependency remains isolated in meta-mesh because the upstream crate is alpha and main-thread-only. UI must show failure rather than claim connection before a peer and ALPN `match/sync/0` stream exist; implementation names stay out of the product flow.

Long documents and file payloads remain separate addressable objects. A future `.tincanban` export may package manifest, cards, documents, and blobs without making one monolithic sync payload.

### 6. Visual direction

Dense operational board: dark navy surfaces, thin slate borders, mint active accent, four active columns plus a compact Archive bin on desktop, right-side detail panel, modal creation flow. Board is first viewport. No marketing hero.

On phones, portrait is the primary board mode. The filter form is a closed disclosure until requested. Pipeline columns do not shrink into a multi-column mosaic: each column is one snap-sized viewport page inside a native horizontal scroller. The top action row scrolls horizontally rather than wrapping into an uncontrolled header. Orientation is never forced.

## Open Questions

- QR invite generation and scan/paste authorization are in v0.0.1. In-app camera scanning and peer-secret revocation remain future work.
- Finder reveal remains outside static web v0.0.1; local paths are shown and copied/opened on a best-effort basis.
