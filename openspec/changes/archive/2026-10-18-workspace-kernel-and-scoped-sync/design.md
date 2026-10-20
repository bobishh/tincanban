## Context and reading order

Read `proposal.md`, `contracts/model.ts`, `contracts/commands.md`, the six capability specs, then `tasks.md`. Normative behavior lives in the specs; exact shapes live in the contracts. This document resolves architectural choices. Do not invent another storage model while implementing an item.

Current source facts, inspected 2026-09-09:

- `src/types.ts` defines fixed `LeadStatus`, `statusLabels`, `statusOrder`, and four root arrays.
- `src/crdt.ts:updateWorkspaceDoc` replaces all four arrays on every change.
- `src/state.ts:commit` starts persistence without awaiting it and immediately notifies sync listeners.
- `src/domain/workspace.ts:deleteLead` physically removes the lead, documents, and artifacts.
- `src/storage.ts` stores one `default` workspace and imports a JSON-only file by constructing another document.
- `src/sync/session.ts` sends `workspace.getBytes()` on live updates. Pairing is one bearer-secret scope and lasts one live session.

## 1. Document boundaries

```text
Local profile (IndexedDB keys, private device key, selected workspace)
  -> PersonalRootDoc (private, shared only with this person's enrolled devices)
       -> public identity
       -> devices and workspace references
  -> WorkspaceDoc A (shared with members of A)
  -> WorkspaceDoc B (shared with members of B)
  -> verified change proofs and public authorization certificates
  -> content-addressed blobs + device-local file locations
```

One person may have N workspaces. A workspace has N boards. One board has its own columns and field definitions. Sync all eagerly replicates all workspace documents in the personal catalog, including future additions. Sync workspace admits another identity to exactly one workspace. These policies use the same document replication service.

The root is a logical catalog, not a giant document containing every workspace. Never merge different workspace IDs or root IDs. Never disclose a personal root or its private workspace names to another person. A document ID is not a permission. Same-origin tabs using the same local profile are replicas of the same documents.

`formatVersion` describes tincanban's persisted data format. Board columns and fields are data, not changes to that format. Renaming a column or changing a field label does not run a migration. Declarative UI documents and `uiSchema` are deliberately absent. `WorkspaceSettingsDraft` is a validated projection over existing typed records, not an authoritative second state object.

## 2. Typed records and hierarchy

Use the discriminated unions in `contracts/model.ts`; no EAV table and no generic unvalidated `Record<string, any>`. `entities[id]` contains boards, columns, items, field definitions, documents, templates, and artifacts. Only item `values[fieldId]` is user-defined data.

New application entities, workspace IDs, transaction IDs, and invitation IDs use UUIDv4. Person/device IDs use fingerprints of public keys. Actor IDs belong to Automerge writers and are separate from both. Legacy record IDs remain byte-for-byte unchanged, even when they are not UUIDs.

Allowed parent edges:

| Child kind | Parent kind |
| --- | --- |
| board | workspace root (`parentId: null`) |
| column | board |
| item | column or item |
| field | board |
| document | item |
| document_template | workspace root (`parentId: null`) |
| artifact | item |

Containment determines inherited visibility. Non-parent references, such as `artifact.templateId`, preserve provenance but do not propagate archive state. Items/subitems derive their board and column from ancestry; do not also store `status`, `stateId`, `columnId`, `boardId`, or child-ID arrays. Cross-board item moves and cross-workspace moves are rejected in this version; moving between columns or nesting under an item on the same board is supported.

### Parent and sibling order are one placement value

Store `placement: { parentId, rank }` and replace this small value as one semantic register when moving/reordering. Two independent scalar writes could merge a parent from one concurrent move with the rank from another. All other independent entity fields are updated in place. Do not replace whole entities, `entities`, or top-level maps.

Ranks are canonical reduced rational strings `n/d`, with signed integer numerator, positive denominator, and exact BigInt comparison. Initial ranks are `0/1`, `1/1`, ... . Between distinct ranks use the mediant; before/after endpoints subtract/add one. Equal concurrent ranks sort by entity ID using bytewise ASCII comparison. When a requested insertion is between equal ranks, renumber that sibling group to consecutive integers in current deterministic order inside the same transaction, then allocate the insertion rank. Never compare rational strings lexicographically or use wall-clock time for order. Concurrent reorders may produce a combined order, but no duplicate membership or vanished item.

### Archiving

`archivedAt` belongs to each mutable entity and the workspace header. It is `null` when active and an ISO timestamp when archived. Archive/restore changes only that record. Never walk descendants to rewrite them. Clearing a field uses `null`; archiving an option or field preserves item values. IDs and historical records are never reused.

`isVisible(id)` is true only if the workspace, entity, and every containment ancestor are active and the ancestry is structurally valid. Restore under an archived ancestor remains hidden and reports that ancestor. A recovery command can combine restore and move to an active valid parent. An individually archived descendant remains archived when its parent is restored.

The private catalog's `forgotten` flag stops listing and syncing a reference for this person; it does not change the shared workspace's `archivedAt`. Label this action "Leave on my devices". Personal identity and signed security proofs are not mutable content records: certificates and successful invitations are immutable facts, and revocation does not use archiving.

### Concurrent graph conflicts

Validate local parent edges and cycles against the proposed transaction result. After merge, never repair by last timestamp or automatically write a competing repair transaction. Derive `needsPlacement` for every entity whose ancestry hits a missing parent, invalid parent kind, or cycle. All such entities are excluded from normal board rendering and reachable in Needs placement, with original links retained. The computation is bounded by entity count and deterministic; it must terminate on any imported graph. A user fixes a placement through a normal transaction. Concurrent writes to the same register use Automerge's winner; expose conflicting placement candidates in recovery details. Same-field conflicts remain inspectable in native history.

## 3. Generic data with a job-search preset

Fresh workspace creation selects "Job search" or "Blank board". Both use the same entities and Vue renderer. Blank board seeds To do / Doing / Done, no company/role/CV requirements. Job search seeds Lead / Applied / Interview / Offer / Archive and board-owned fields for the existing lead data.

The Archive column has the explicit `archive: true` role. A board permits at most one. Its collapsed presentation is derived from that role; title and preset binding do not define behavior. The board editor creates it through the Add column checkbox, disabled while an Archive column exists. The Archive column projects items with `archivedAt` from the same board without moving them, including items archived before the column was enabled. Restore clears the timestamp. Commands reject creating or moving an active item directly into the Archive column. Archiving schema entities hides them and their descendants.

Document templates are generic workspace-root entities with title and Markdown. No template-kind enum is stored; use and generation behavior comes from the operation invoking a template. Job-specific PDF commands remain an adapter over generic items and document-template/artifact records. Do not build a plugin runtime. The preset copies data on creation; later preset updates never rewrite a user's board.

### Board editing and workspace settings

Normal mode drags cards within or across column stacks and persists exact `beforeId` order. Edit mode disables card dragging and enables column dragging from the column header only. Sortable placeholders remain inside the same flex board; failed durable writes rebuild DOM from committed CRDT state.

`Edit board` lives in the desktop header and mobile Settings group. Edit mode exposes inline add, double-click/edit column controls, and `Edit {entityName}` for the singular entity label and typed fields. Workspace Settings contains Document templates plus an advanced JSON view.

The JSON projection contains only `formatVersion`, workspace title, active board title/entity name/ordered columns/ordered fields, and ordered document templates. It excludes items, field values, personal identity, device keys/certificates, grants, invitations, proofs, sync state, and native log data. `get_workspace_settings` returns projection plus current heads. `apply_workspace_settings` validates stable IDs and applies the complete draft through one `updateWorkspaceSettings` Automerge transaction using optional expected heads. Missing columns, fields, options, or templates are archived; descendants and values remain.

## 4. Transactions, history, and durability

`WorkspaceStore.transact(command, context)` is the only write boundary. It validates permissions, shape, references, field values, and local graph invariants, then makes exactly one Automerge change. Metadata is a versioned JSON string in the native change `message`: transaction ID, command kind, affected entity IDs, person ID, device ID. Native dependencies and actor remain native metadata.

Do not maintain `transactions[]`, a replay reducer, and a second state object as parallel authorities. The user history UI projects native Automerge changes plus verified attribution. The command wrapper can return before/after heads and changed IDs for subscriptions. Item restore reads a native historical snapshot and emits one explicit compensating command; it never mutates or reorders signed changes.

Build changes on a private candidate. Persist change bytes and their proof atomically in IndexedDB before publishing the candidate as committed, notifying subscribers, or offering it to a peer. On write failure retain the previous committed document and show retryable failure; retry uses the same transaction ID and cannot duplicate a change. A UI may show an unsaved draft, but must label it pending. Do not save only JSON to a fallback and claim CRDT history was preserved.

Serialize local transactions through a per-document async queue. Remote merges enter the same publication queue; independent tabs retain their own queues and reconcile append-only durable chunks. Do not let two same-tab candidates both overwrite the published reference from a stale starting state. Rebase only by merging native changes, never by silently replaying a possibly non-idempotent business command.

Use append-by-change-hash storage keys and occasional binary snapshots. Independent tabs must not overwrite unseen writes to one singleton key. A snapshot records its included heads; delete only storage chunks covered by that snapshot, without removing logical history. Reopen/reconcile unions all durable chunks. The JSON representation is a disposable export/read cache.

Signing requires per-change proof records outside the change being signed. Atomically store the proof with the signed bytes; never attempt to put the signature/hash of a change inside its own message. A proof store is authenticated metadata, not a second state reducer or sync engine.

Use RFC 8785 JSON Canonicalization Scheme through a maintained implementation for every signed envelope payload. Signature input is UTF-8 `MATCH/1/` + payload kind + a zero byte + canonical payload bytes. Sign the complete `ChangeProof.payload`, including document ID, native change hash, and actor-binding hash. Hash public envelopes with SHA-256 over the canonical complete envelope; hashes in native Automerge metadata retain the native encoding. Reject non-finite numbers and unsupported versions before canonicalization. Do not invent independent serialization formats in each service.

## 5. Legacy migration and portable workspaces

Detailed mapping and failure behavior are specified in `contracts/commands.md` and `workspace-portability/spec.md`.

Migration is coordinated once per legacy lineage. Before writing, save the original Automerge bytes and JSON snapshot locally and allocate a durable migration plan containing source heads, new workspace ID, seed IDs, transaction ID, and original record IDs. Apply migration to a clone of the source document, retaining the four old arrays untouched as legacy data and adding the v2 root fields. New readers use v2 only; old writers must not sync into v2.

An already-migrated device enrolls other devices or exports its canonical v2 lineage. Do not independently reconstruct the same workspace on every device from UUID guesses. Reapplying the durable migration plan returns the same resulting document; a prepared result is persisted once. Two independently migrated copies are separate workspaces and are detected as a migration conflict on attempted reconciliation; neither is silently overwritten or merged. Surface export/keep-both recovery. Supporting automatic reconciliation of those competing migrations is deferred.

Native `.tincanban` v2 includes manifest, canonical Automerge bytes, readable snapshot, public proofs, and selected content-addressed blobs. It never includes identity private keys, a personal root, invitation secrets, or machine-local paths as portable files. Legacy local paths are retained in local location records; missing files appear as unavailable on another device. A same-workspace import merges the original lineage; different workspace IDs remain separate catalog entries. JSON-only import creates a new workspace and clearly lacks history. Unsigned legacy content is labeled legacy/imported, not falsely attributed to the importing person as its original author.

## 6. Identity and collaboration authority

Use Web Crypto Ed25519 signatures and SHA-256 fingerprints of canonical raw public key bytes. Check support before enrollment; show unsupported-device failure rather than silently substituting an algorithm. No password/account backend is required. Keep private CryptoKeys in a dedicated local IndexedDB store, outside all replicated documents and exports.

First run creates an identity authority key, a device key, a root-signed certificate for that device, and a private root. The authority private key stays on the creating installation; enrolled devices use device keys, never copied private authority material. All own enrolled devices may enroll another own device through signed certificate delegation. Each certificate binds person ID, subject device ID/key, issuer ID, and enrollment capability. Verify the complete chain to the identity public key, reject cycles, and cap delegation depth at 32. Do not treat a self-asserted person ID in a CRDT record as enrollment.

Concurrent first-open tabs must claim the local profile atomically in IndexedDB; only one bootstrap identity/device/root is published. Losing candidates discard their unregistered keys and load the winning profile. Browser capability failure leaves existing data intact.

Each writable tab/document replica gets a distinct Automerge actor. A device signs a binding of person ID, device ID, document ID, and actor ID. Each new change receives the canonical signed proof described in section 4. Validate the certificate chain, actor binding, change hash, and membership before incorporating bytes into a trusted document. Forward the original proofs so a relaying peer is never reported as the author. Display names are presentation data; history resolves stable IDs and distinguishes unknown legacy authors.

Membership alone is insufficient: check incoming operations against the same immutable/protected-field rules as local commands. Content editors cannot change workspace ID, owner identity, record ID/kind/creation time, legacy inputs, or formatVersion, physically remove records, or replace initialized root maps. Owner-authored format migrations use an explicit supported migration validator. Signed but structurally inconsistent concurrent placement/field edits are retained and projected as issues; never reject a valid concurrent edit merely because its remote context differs from the current local view.

A workspace is created with an owner-signed genesis descriptor binding workspace ID, owner person ID, and initial heads. Owner devices may issue signed workspace grants to another person as `editor`. Editors can edit all content, including structure, but cannot enroll the owner's devices or issue grants. Initial role set is `owner | editor`; no pretend read-only enforcement. New invited members receive existing workspace history, including archived content. Private root access requires own-device enrollment, not workspace membership.

Security changes are verified certificate/grant facts, not ordinary editable workspace fields. Public member entries are a display projection of verified grants. Grant/certificate blobs are persisted for verification and portability. This version supports cancellation/expiry of unused invitations and local disconnect; it does not claim distributed revocation of a grant already issued. A later revocation protocol must explicitly decide offline changes and accepted-history frontiers before shipping a Revoke action.

## 7. Invitations and service boundaries

Two discriminated invitations: `device-enrollment` and `workspace-join`. Both carry protocol version, invitation UUID, issuer public identity/device proof, endpoint, expiry, and a 256-bit random one-time secret in the URL fragment. Workspace invitations bind a fixed set of designated workspace items (`workspaces: WorkspaceItem[]`) and `editor` role (with backward-compatibility fields `workspaceId` and `workspaceTitle` for single-workspace invitations); device invitations do not accept workspace role fields. Invitations are signed and validated against their kind. Parsing the wrong kind fails before transport startup.

Issuer remains online to redeem an invitation. Default expiry is ten minutes. Persist invitation status locally (`pending`, `redeeming`, `consumed`, `cancelled`); use IndexedDB compare-and-set transactions to allow only one redemption. Retry by the same authenticated target resumes the same redemption; another target fails. Only the issuing device redeems that invitation. Opening a link never automatically joins.

Device enrollment: new installation generates its own device key; both screens show a short authentication code derived from a transcript binding invitation hash, both device public keys, and fresh random challenges signed by each device. The issuing device approves the displayed target device; only then sign its certificate and release private-root data. Parse `/pair` before ordinary fresh-profile bootstrap: an enrollment recipient creates a device key but no competing personal identity. Workspace-join recipients follow normal personal-identity bootstrap. An installation with a different existing profile receives `identity_conflict`; do not merge, replace, or discard that identity. Named multi-profile switching is deferred.

Workspace join: recipient retains its own identity, explicitly accepts the designated workspace set (displaying all invited workspace names), and receives owner-signed editor grants for every workspace in that set. Never expose unselected or future workspace names/metadata while negotiating. Legacy v0 invitation links receive an upgrade message; there is no downgrade to unscoped bearer-secret sync.

Local services:

- `IdentityService`: local keys, chains, actor bindings, and verified authorship.
- `WorkspaceRepository`: load/create documents, transaction persistence, public proof and blob stores.
- `InvitationService`: typed invitation creation/redemption and durable trust.
- `ReplicationService`: allowed document set, per-peer/per-document Automerge sync state, batching/backpressure, reconnect, and progress.
- Existing `SyncTransport`: nodes/connections/streams only; iroh remains an adapter.
- Vue Sync modal: subscribes to service state; never implements cryptographic or merge rules itself.

This is browser-local service code. A page can reconnect while alive or on reopening. It cannot promise to sync after being closed. "Disconnect" stops this device's connection; "Leave on my devices" forgets a catalog reference; neither promises to erase remote data.

## 8. Incremental replication and file transfer

Authenticate session before advertising document IDs. For each authorized document, maintain its own Automerge `SyncState` and use native sync messages, not whole saved documents on every edit. Only verified changes may enter the trusted repository. Validate incoming messages in an isolated candidate and persist proof-complete changes before acknowledging durable receipt. Keep candidate sync-state advancement isolated as well; do not send an acknowledgement generated from unverified candidate heads. Dependencies without proofs remain pending and cannot leak into UI. Reconnect negotiates heads and transfers missing changes; it does not replay domain commands.

Sync all follows the live personal catalog, including workspaces later joined from another own device. Workspace sync offers only the authorized workspace and its referenced blobs. A sender must itself have authority for each offered document. A mesh connection is transport reachability, not global access.

Control frames carry `protocolVersion`, `kind`, `sessionId`, `documentId` where applicable, and bounded payload length. Protocol v1 limits a physical frame to 1 MiB; larger logical sync messages are chunked with message ID, index, count, and total size, with a 32 MiB reassembly limit. Reject oversized/inconsistent frames before allocation; larger legitimate histories use batches. Blobs use 256 KiB chunks, SHA-256 content hashes, resumable ranges, and at most four outstanding chunks per peer. Check final hash before publishing a blob as available.

Document readiness and file readiness are separate: "Workspace ready; 3 files pending" is valid. "Everything synced" requires all selected document frontiers acknowledged and all locally available referenced blobs transferred; unavailable source-local paths are reported separately, never counted as transferred bytes. A moving frontier updates progress rather than producing a false permanent completion.

## 9. Native UI and responsive behavior

Use the existing Vue stack and real application routes. Route contract: `/` selects/restores the last workspace; `/w/:workspaceId/b/:boardId` opens a board; `/pair#...` opens the typed invitation flow. Static hosting must serve the app for deep links. Keep existing mobile snap columns, 1024px controls, template/artifact workflows, and keyboard-accessible item movement.

Sync modal opens directly with workspace selection checkboxes, with the active workspace preselected, and a single "Generate link" action on the same screen (empty selection disables generation). "Add my device" ("Sync all") is provided as a distinct secondary action for personal identity enrollment. No invitation or transport starts merely from opening the dialog. Flows run Scope -> Invitation -> Approval/Acceptance -> Transfer -> Connected, with waiting, retry, cancelled, expired, and failed states. Persist peers; after reload a live known peer can reconnect without another QR. Selecting a mesh member expands their known devices with presence, shortened device ID, last-seen time, signed self-reported device name and user agent, and a clearly best-effort browser/OS description. Device metadata never grants identity, membership, or authority; missing metadata from an older peer renders as unknown.

### Legacy requirement precedence

| Old pending `match` requirement | New source of truth |
| --- | --- |
| Fixed lead pipeline / status enum | `workspace-model`, job-search preset only |
| Flat lead cards / mandatory company and role | Generic items and typed fields seeded by the Job search preset; no preset-specific MCP surface |
| Physical removal / cascading removal | `workspace-model` archiving |
| One default workspace / import merge into it | `workspace-portability` and private catalog |
| Automatic QR on opening Sync / Connect to mesh | `scoped-sync` typed chooser and explicit acceptance |
| Pairing lasts one connection | `personal-identity` durable enrollment/grants |
| Full-document live updates | `scoped-sync` native incremental exchange |
| Mobile, template/artifact, agent-visible mutation behavior | Preserve, translated to generic IDs/fields |

## 10. Delivery gates and evidence

Gate A is local identity/signing bootstrap, the reusable model, native board, durability, and legacy import. Gate B completes private-root lifecycle and verification of remote authority/changes. Gate C adds device enrollment and scoped collaboration. Gate D proves incremental transport, files, and three-party isolation. Do not enable a half-built sharing flow during Gate A/B.

Each UI slice starts with an outer Given/When/Then Playwright scenario on real routes. Finish with happy path and a failure/pending case. Use isolated browser profiles for people/devices and separate tabs for actors. Use a free alternate port; the existing configuration is 4244 and must not stop a user's server. Unit tests exercise CRDT races and injected persistence failures; browser tests prove visible behavior.

## References

- [Automerge data modeling and migration pitfalls](https://automerge.org/docs/cookbook/modeling-data/)
- [Native changes, causal history, and incremental sync](https://automerge.org/docs/reference/glossary/)
- [Automerge storage chunks and snapshots](https://automerge.org/docs/reference/under-the-hood/storage/)
- [Change metadata](https://automerge.org/automerge/api-docs/js/types/ChangeMetadata.html)
- [Per-peer sync messages](https://automerge.org/automerge/api-docs/js/functions/generateSyncMessage.html)

Declarative UI investigation is a separate research note under `openspec/research/`; it is not a requirement, dependency, or implementation gate of this change.
