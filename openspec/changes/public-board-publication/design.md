## Context

Reviewed current files on 2026-10-10. `WorkspaceDocumentV2.id` identifies a workspace; each board has a distinct entity UUID and descendants linked through `placement.parentId`. A workspace can contain multiple boards. The public URL identifies the board entity, never the workspace ID or an opaque Rusty scope.

Rusty currently serves encrypted immutable objects through `src/blind.rs`. Signed challenge enrollment pins a configured owner root and allowed controller devices. The service has no plaintext workspace, application grant or decryption key. `BlindStore::open` rejects unrecognized filesystem entries. Existing unrelated changes in sibling `src/keeper.rs`, `src/replication.rs` and `.sloposcope/` must be preserved.

Tincanban's `main.ts` currently mounts the private app for all routes. `workers/frontend/frontend.mjs` serves a static SPA. Public viewing must branch before importing private application startup. Existing diagnostics are configured at build time and write to the current ingestion service, not directly to ClickHouse.

## Goals / Non-Goals

Goals: stable public links; selected-board disclosure; authenticated publish/update/unpublish; offline-author availability; anonymous mobile read-only viewing of cards, discussions and attachments; no enrollment or mesh audience; content-free optional view analytics.

Non-goals: purchasing a domain, public editing/comments, a viewer account system, exposing private Rusty credentials, public access to the full workspace CRDT, automatic publication of private edits, search-engine indexing/SSR, deleting private Visitor authorization throughout MetaMesh, or production publication of the user's data without an explicit Publish action.

## Decisions

### 1. Publish a projection, not workspace history

The owner client builds a strictly validated, versioned JSON projection from the already-authorized document. Explicitly whitelist board title/schema, active columns, field definitions/options, active items including nested items, their card bodies and values referring only to published fields, and stable ordering. Remove archived entities and broken/cross-board references from display/configuration. Bound payload and collection sizes; reject malformed input rather than accepting arbitrary extra entity kinds.

Do not use JSON serialization of the whole document followed by deletion. Exclude workspace metadata, ownership records, profile records, member lists, global/unrelated chat, templates, unrelated documents/artifacts, private file references, automations, tokens, reading keys, change history and other boards. Markdown rendering must remain safe; public references cannot fetch private objects. The publish dialog states exactly what becomes public. A separate snapshot supports anonymous reads without possession of private decryption keys.

### 1a. Publish scoped discussions and complete file copies

Resolve stored discussion conversations against the current selected board and published card/field IDs. Include only valid threads anchored within that selection, with replies in their thread order. Exclude global chat, unrelated boards, archived-card threads and unresolved/invalid conversations. Strip private workspace scope, device/person IDs, signatures, certificates, mention identifiers and private quote/reference resolution. Resolve an author display label locally as published content; map message/reply/thread IDs to opaque publication IDs because source message IDs embed a device ID. Public reference/quote content must refer only to published entities; never expand a private reference to disclose its text. Discussion messages remain read-only.

Include active attached documents/artifacts belonging to the selected board or a published card. Export allowlisted display text/metadata and content bytes only; omit private local paths, file IDs, blob transport tickets, reading keys and template provenance. Fetch bytes with the existing authorized attachment reader, verify their digest, and stage separate public copies. If source bytes cannot be obtained, fail the publication with an actionable named-file error before any successful acknowledgement. Never claim a complete publication with broken attachment links. Render text safely; downloads use safe filenames, explicit content disposition and nosniff rather than executing arbitrary attached HTML/SVG.

Stage assets through authenticated, challenge-bound digest/size commands in a separate owned namespace. Uploads are idempotent by board/content digest; they are not anonymously readable until referenced by a confirmed manifest. Bind the publication command to the complete projection and manifest hash. Under one publication lock, validate every staged file exists and matches its digest/size before atomically activating snapshot, manifest and revision. Preserve the previous confirmed snapshot and asset access when staging or commit fails. Serve a file only when the requested active revision and current manifest authorize its digest; after update/withdrawal, old revision URLs and unreferenced assets fail closed. Stage cleanup must not delete current assets or race an in-flight upload/commit; bound stale staging retention and clean orphans safely. An interrupted publish can retry without changing the current public state. Existing private object caps remain unchanged; public file/request bounds must be explicit and documented, with actionable failure states.

### 2. Explicit publication authority on the existing Keeper

Add a public-publication API and durable namespace next to blind object storage. Reuse the service's pinned trusted-owner root and controller-device verification, short-lived signed challenges, canonical payload hashes and replay protection. Commands bind service/origin, board ID, action, exact projection hash, expected revision and expiration. A publication records its controller root; a different controller cannot overwrite or withdraw it. Existing service provisioning trust is a prerequisite, not an unrestricted anonymous upload endpoint.

The private client offers publication only after its current Rust policy confirms owner rights for the source board. Server authorization is the explicit publication-controller capability supplied by its existing trust configuration; do not falsely claim that a blind server can revalidate private workspace history it never receives. Publication authority and source workspace ownership are distinct: transferring a private workspace does not silently transfer a previously published copy's management authority. Document this boundary and require explicit publication withdrawal/management transfer where needed. Preserve internal Visitor/deny-write defaults.

Persist confirmed projection, revision and withdrawal tombstone atomically before acknowledging. Expected-revision checks prevent stale updates or resurrecting a withdrawn publication. Verify signed receipts before the client claims success. Crash/restart must preserve a last acknowledged version. Extend storage-directory validation only for the exact owned publication namespace; continue rejecting unknown/legacy files. Keep ciphertext endpoints and credentials unchanged.

### 3. Stable anonymous read path

Use `/boards/<board-entity-id>` on the frontend and a versioned anonymous GET on the configured Keeper publication origin. Expose that origin as public deployment configuration, never the private access export. A standalone public app resolves and validates the snapshot before rendering. It does not create a local profile/workspace, connect peers, evaluate private workspace access, or load Automerge/transport WASM.

Read-only cards retain search, field presentation and safe card-body inspection. No editing, drag/drop mutation, invites, discussion posting, Visitor badge or identity enrollment. Read published discussion threads in their board/card/field context and download published attachments. Include distinct loading, unavailable/unpublished, malformed-publication and retry states. At minimum support fresh navigation and reload at phone/desktop widths. Cache validation must make later withdrawal visible; do not claim previously downloaded copies can be erased.

### 4. Updates are acknowledged snapshots

Publish uploads the current projection. Update publishes a newer explicit snapshot; unpublish withdraws anonymous serving. Show which revision is confirmed and whether local content differs. The initial release uses explicit Update so private edits cannot silently disclose new content. Latest content remains readable while an update is pending or fails; no UI success before durable acknowledgement. This is a consequential choice to keep publication scope explicit, not CRDT replication to an anonymous audience.

### 5. Optional view measurement

After a successful public render, emit at most one public-view event per navigation through the existing deployment-configured ingestion endpoint. Respect existing opt-out/configuration and keep viewer device/person/workspace identifiers empty; an ephemeral page session and published board entity ID suffice. Send no title, body, field values, private IDs, URL secrets or raw errors. No click-by-click instrumentation, invented project quota or mesh audience records. Requests are fire-and-forget; a disabled/unavailable collector changes no viewing behavior.

## Risks / Trade-offs

- Explicit publication discloses selected card, discussion and file content to Keeper and everyone reading the link → disclosure in Publish, strict projection and sentinel privacy tests.
- Private workspace ownership cannot be independently inferred from an opaque storage scope → existing configured publication-controller trust, exact signatures and separate documented authority boundary.
- Explicit updates can be stale → show confirmed revision and Update action; no promise of live mesh updates while authors are offline.
- A public path can return old cached content after withdrawal → revalidation/no-store semantics and unpublish-after-read acceptance tests; downloaded copies remain outside revocation guarantees.
- Multi-repository rollout → implement compatible server first, then public-origin config/frontend; do not auto-deploy sibling infrastructure.

## Migration Plan

Add publication APIs without altering existing ciphertext policies or volumes. Verify current blind-storage regression tests. Deploy the Keeper binary/config through its established release mechanism separately, then configure the frontend's public publication origin and deploy via CI. Feature controls report missing server capability/configuration instead of publishing through old endpoints. No existing board becomes public automatically. Rollback of frontend must not erase stored publications; rollback of Keeper requires a compatible reader or explicit preservation of the new namespace.

## Resolved Scope

User confirmed private Visitor invitations stay. Selected-board discussions and attachments are required in the first public version. Domain choice and search-engine indexing remain separate work.
