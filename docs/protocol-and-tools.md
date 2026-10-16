# Protocol and tool reference

Implementation details for contributors. Start with the [README](../README.md) for the product, demo, and setup. This is not a security audit.

This reference describes the implementation. Each service's owning CI verifies
its own artifact and deployment; source presence alone does not establish
production behavior or cross-service acceptance.

## Features

- **Generic Workspace Kernel**: Create independent workspaces (such as the default *Job search* pipeline or *Blank* boards) with custom columns, rational rank positioning, nested item hierarchies, workspace document templates, and typed fields (text, number, boolean, select, URL, date, datetime).
- **Preset Seeds**: The *Job search* preset creates an ordinary board, fields, and document templates. After creation it uses the same generic workspace model and commands as every other board.
- **Trash & Needs Placement Recovery**: Soft-deleted columns and cards can be restored safely. Items with missing parents or cyclic references are deterministically surfaced under *Needs placement* for recovery without destructive repair writes.
- **Local Automerge Durability & Restore**: All mutations are recorded as signed Automerge changes persisted atomically with change hashes, receipts, and public proofs in IndexedDB. Item history can restore any recorded version through a new compensating change; original evidence remains immutable. Focus changes and `BroadcastChannel` synchronize same-device tabs instantly without network pairing.
- **Two Scoped Connection Flows**:
  1. **Add my device**: Enrolls your own secondary device into your identity using its device key and a verified certificate chain. Both devices compare a code bound to the request; approval sends the current owned workspaces and durable mesh credentials. Success appears only after the recipient saves the data and acknowledges receipt. Enrollment certifies the receiving device rather than copying the root private key; ordinary workspace ownership belongs to the user, not to a primary device. This is not a participant invitation and has no role selector. Existing local boards are retained when enrolling a device; arbitrary identity merging is not supported. Future owned workspaces propagate automatically between enrolled owner devices; workspaces owned by someone else do not.
  2. **Sync workspaces**: Requests explicit owner approval and issues owner-signed *visitor* (default) or *editor* grants scoped exclusively to a designated fixed set of workspaces (one or multiple). Guests never receive or learn about unselected workspaces, titles, future workspaces, or your private root.
- **Incremental Mesh Replication & Blob Transfer**:
  - Employs native Automerge per-peer per-document sync states. Live updates exchange missing changes rather than always sending a full snapshot; transfer size depends on the document history and peer state.
  - Bounded framing limits physical frames to 1 MiB with reassembly up to 32 MiB.
  - Content-addressed blob storage with SHA-256 validation and resumable 256 KiB chunks.
  - Granular progress reporting separating document sync frontiers from pending file transfers.
- **Workspace Chat & Presence**: Each workspace has signed local-first chat, workspace-specific display names, ephemeral signed typing indicators, and live editor/device counts. Typing state expires and never enters durable chat history. Chat retains the newest 2,000 messages within a 4 MiB cap in a separate IndexedDB journal.
- **Export Guarantees**: Exported `.tincanban` bundles contain workspace metadata, item documents, retained Automerge bytes, and public cryptographic proofs (`proofs.json`). Private signing keys, personal root documents, and pairing secrets are strictly excluded. The separate encrypted private recovery backup includes available original archive/attachment evidence and required private reading keys; missing objects make coverage explicitly incomplete. An ordinary workspace export is not a claim of complete archived recovery coverage.
- **Browser Lifetime & Persistence**: A stable device identity, active transport credentials, and signed workspace authority persist in IndexedDB. Authority (owner history, grants, revocations, transfer and succession records) lives separately from disposable routes and transport secrets; leaving or rebuilding transport cannot turn an owner/editor into a visitor. Every tab owns an independent Iroh instance route; no tab is leader. Delivery targets the durable device through any live route, then sibling tabs reload committed state from IndexedDB. Connections and Automerge sync state are isolated per instance; direction and route-sequence tie-breaks only compare connections to the same instance. Trusted peers reconnect after every tab closes and reopens; peers introduced by a common owner can later sync directly without that owner online.
- **Workspace Roles**: Owner can edit everything, invite, and revoke. Editor can rename the workspace and edit items, attachments, and chat, but cannot change board structure, fields, templates, access, imports, or recovery. Visitor can view the workspace and chat; writes and dragging are disabled. UI controls, local commands, imports, chat admission, and signed incoming changes use the same capability policy in `permissions.ts`.
- **Write Authorization**: Shared document changes carry device signatures and owner-issued grants. Every network merge requires those authorizations; no raw document merge API is exposed. Forwarded changes retain their original authorization. An Owner-attested compact basis has a distinct Native admission path; it does not replace original authorship proofs. The active tail still requires signed causal admission. Reload tabs when the frontend's own compatibility check reports a stale client before sharing new writes.
- **Schema Architecture**: Entity schemas in `src/domain/entitySchemas.ts` define both runtime validation and inferred TypeScript types. `validation.ts` adapts schema errors and parent rules; `permissions.ts` owns role policy. Protocol types remain in `model.ts`.
- **Owner-Controlled Access**: Sync lists participants, trusted devices and presence. Only the workspace owner can invite or revoke. Signed revocations gossip through the mesh without consensus.
- **Trusted-Group Ownership Recovery**: Owner may name one editor successor or enable strict-majority editor recovery. One signed vote per editor and epoch-bound claims prevent ordinary double election. Conflicting valid claims pause writes instead of silently selecting divergent owners; tincanban does not claim Byzantine consensus.
- **Workspace Catalog Recovery**: Catalog entries are stored independently per workspace. Startup recovers entries from orphaned Automerge snapshots. The retired shared catalog is no longer read. Deletion markers prevent stale tabs from bringing deleted entries back. Browser write errors are surfaced rather than treated as successful saves.
- **Confirmed Ownership Transfer**: Both peers must support durable ownership receipts. The recipient saves the workspace, proofs, and ownership catalog before acknowledging the exact payload. The sender reports success only after a matching receipt. A missing receipt means an unknown outcome; retries reuse the same signed proposal rather than appointing a competing successor. The new owner must explicitly configure their recovery policy.
- **Shared Device Identity**: Identity keys and device certificates come from the vendored `@meta-uber/mesh-identity` package. tincanban has no local identity fork; browser profiles remain compatible with existing installations.
- **Current Schema**: Clients are expected to use the current document format. Loading and saving snapshots never adds CRDT changes; legacy workspace and preset migrations have been removed.
- **Explicit Limitations**: No application-hosted account database, permanent workspace replica, or server-side secret recovery. Iroh connectivity still uses discovery and relay infrastructure when needed. Revocation is eventually consistent while peers are offline: a partitioned peer rejects revoked access only after receiving the owner's signed tombstone from an up-to-date peer.

## Public visitor access

The target public-access model is a read-only mode for the existing board. It keeps
the board's IDs, settings and visitor-visible content; it does not create an editable
publication copy or require a manual update action. Public and invited visitors
share the same board, card, detail, discussion, file and responsive-window
presentation. Archive visibility, collapse capability, preset bindings and
effective card values come from the admitted board state. Caveat remains on the
handwritten board and controls; long detail and chat prose uses compact Fira Sans.

Canonical routes use `/boards/<board-id>/<title-slug>`. The stable ID resolves the
board; the title slug is descriptive, and legacy `/boards/<board-id>` links remain
valid. A private route hint may locate a candidate workspace, but it never grants
access. Opening a private address still checks the active identity, saved workspace
and current role. A fresh anonymous public read must not create an identity or
initialize private workspace storage.

Authorized owner/editor changes, admitted peer updates and approved automation
changes are intended to update the public read representation automatically.
Clients and Workers must use the normal signed causal-admission policy and current
accepted grant snapshot; they must not trust a server storage token as board-write
authority. An offline writer learns a revocation when the signed authoritative
checkpoint reaches it. Rusty stores the readable board-scoped response but cannot
inspect private workspace history to prove the source change's author or authority.

**Evidence status (2026-10-16):** source now includes native public delivery and
automation Worker integration, with focused protocol and retry coverage. Final
browser acceptance remains pending; no production deployment is established by
this source evidence. Frontend, automation and Rusty release through their own
service pipelines.

## WebMCP Tools

When opened in an environment exposing WebMCP (`document.modelContext` or `navigator.modelContext`), tincanban registers generic workspace commands. Commands target the workspace currently open in tincanban.

### Generic Commands
- `list_workspaces` — list available workspaces.
- `switch_workspace` — open an available workspace by stable ID; later commands target it.
- `create_workspace` — create and open a Blank or Job search workspace.
- `rename_workspace` — rename the current workspace.
- `get_workspace` — read the current workspace and active board summary.
- `get_workspace_settings` — read the complete editable configuration and CRDT heads.
- `apply_workspace_settings` — validate and atomically apply workspace title, board, columns, fields, and document templates.
- `list_items` — list visible items with optional parent and search filters.
- `get_entity` — read one typed entity by stable UUID.
- `create_item` — create an item under a column or another item.
- `patch_item` — update item title, body, or typed field values.
- `move_entity` — move or reorder an entity under a column or item.
- `rename_entity` — rename an entity without changing placement.
- `set_item_archived` — archive or restore an item.
- `restore_and_move` — restore an entity under a valid parent in one transaction.
- `list_archived_items` — list archived items on the active board.
- `list_placement_issues` — inspect missing-parent and cyclic ancestry problems.
- `create_column` — create a column under a board.
- `send_chat_message` — send to current workspace chat only when explicitly requested by the user.
- `get_sync_trace` — read this browser's bounded diagnostic trace without changing connections.

Complete settings writes should preserve returned entity IDs and pass returned heads as `expectedHeads`. Omitted columns, fields, and document templates are soft-deleted while their descendants and stored values remain intact. Unknown fields, stale heads, and field type changes are rejected without partial mutation.

## History maintenance and recovery

Opaque storage checkpoints replace redundant Rusty snapshots after eight retained
objects; they keep the inner document history. Separate history maintenance starts
at 512 admitted active changes or 4 MiB of active history. Native policy captures
original evidence, verifies storage coverage, and confirms the current Owner's
compact-state attestation. Atomic local activation retains originals in archival
stores. Archives and current content still consume disk; compaction does not
authorize deleting either.

The signed automation management actions `prepare-history-baseline` and
`activate-history-baseline` coordinate Worker writers. Prepare durably flushes and
freezes authoring and returns signed source heads. The Owner drains those heads,
archives and publishes the covered basis, then activates that exact transition and
baseline. The Worker independently verifies Native baseline/tail evidence and
frozen-head coverage before atomic activation and unfreezing. These actions retain
the existing grant, expiry, definition and pending events; they do not grant an
Automation identity Owner authority. See
[the management client](../src/app/automationInstanceClient.ts) and
[the transition coordinator](../src/sync/historyBaselineTransition.ts).

Direct authenticated workspace peers relay bounded, content-addressed plaintext
archive proof/data without Rusty keys or tokens. Native independently verifies the
Owner attestation and signed scope anchor. This mode authenticates public storage
receipts but does not claim encrypted-storage correspondence. Encrypted Rusty
receivers verify that correspondence separately. Stored evidence is reverified on
startup, rather than trusting a serialized admission flag.

Item History loads earlier revisions only on explicit request. Selected-version
reads verify original bytes, dependency closure and provenance; restoration emits
a fresh current-policy command. Private recovery inspects the authenticated file
and original signed history before replacement. An active history transition or
concurrent target-journal change blocks replacement, preserving frozen writers and
the local source. See the [history contract](../openspec/changes/unified-device-and-replica-architecture/history-archive-contract.md)
for trust boundaries and acceptance gates.

