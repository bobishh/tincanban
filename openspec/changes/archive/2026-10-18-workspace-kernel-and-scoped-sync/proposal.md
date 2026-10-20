## Why

tincanban currently couples one local workspace to a fixed job-search pipeline. A second use case requires changing application code, and device pairing cannot distinguish another device of the same person from another person joining one workspace. The next foundation must support reusable boards, preserved relationships, complete personal replication, and scoped collaboration without adding a second state or synchronization engine.

## What Changes

- **BREAKING** Replace lead/status storage with typed entities identified by stable IDs. Columns are entities; items reference parents. Job search becomes a seeded board with custom fields.
- **BREAKING** Use reversible `archivedAt` state and inherited visibility. Preserve all relationships and historical changes.
- Introduce a private personal-root document containing public identity, registered devices, and workspace references. Each workspace is a separate Automerge document and sharing boundary.
- Route UI and WebMCP writes through one validated, durable transaction API. Automerge remains the canonical history, materialized state, and merge engine.
- Add safe legacy migration and versioned `.tincanban` workspace bundles. Preserve existing IDs, documents, writing templates, artifacts, and old Automerge history.
- **BREAKING** Split Sync all / Add my device from Sync workspace / Invite person. Invitations have distinct types and scopes; successful enrollment persists across reloads.
- Authenticate person/device attribution, transmit incremental changes, and keep files addressable separately from document history.
- Deliver a native Vue generic board, column editing, nested items, recovery views, and generic commands. No declarative interface language is included.
- Add inline Trello-style board editing plus one advanced workspace-settings JSON projection shared by people and WebMCP agents.

## Capabilities

### New Capabilities

- `workspace-model`: Typed workspace entities, configurable fields, parent relationships, ordering, archiving, and job-search seed.
- `workspace-transactions`: Atomic commands, native change history, durable persistence, conflict projection, and shared UI/agent boundary.
- `workspace-portability`: Legacy migration, independent workspace identity, and versioned import/export.
- `personal-identity`: Private root, separate person/device/actor identities, enrollment, signed attribution, and scoped membership.
- `scoped-sync`: Separate complete-device and workspace flows, durable trust, document-level incremental replication, and transfer states.
- `generic-workspace-ui`: Native Vue board and settings, nested items, field controls, Archive/recovery, and reusable non-job workflow.

### Modified Capabilities

None are archived under `openspec/specs` yet. The pending `tincanban-v0-0-1` change is the legacy baseline. On implementation/archive, reconcile its overlapping requirements using the precedence table in `design.md`; do not silently retain contradictory fixed-status or ephemeral-pairing requirements.

## Non-Goals

- Declarative UI DSL, arbitrary renderer/layout JSON, renderer plugins, remote code, visual app builder, formulas, automation engine, or Datalog/EAV. The workspace-settings JSON edits the typed domain configuration only.
- A separate business-event replay engine, a second authoritative JSON snapshot, or global ACID transactions across offline replicas.
- Hosted account service, mandatory backend, blockchain, tokens, or application use while every copy is offline and unavailable.
- Background browser synchronization after the page closes.
- Workspace subsets shared at board/card level, cross-workspace parent links, and independent subitem workflow status.
- Distributed membership revocation/key rotation, identity recovery, and merging two existing personal identities. Initial collaboration supports signed owner/editor grants; future revocation needs its own explicit protocol, not a mutable CRDT boolean.

## Impact

Primary seams: `src/types.ts`, `src/domain/workspace.ts`, `src/crdt.ts`, `src/state.ts`, `src/storage.ts`, `src/webmcp.ts`, `src/filters.ts`, `src/sync/*`, `src/components/SyncDialog.vue`, `src/App.vue`, and Playwright suites. Keep Vue 3, TypeScript, static hosting, Automerge, and the `SyncTransport` / iroh boundary.

This change is implementation-ready planning. Its reference types are contracts, not an installed runtime. Complete gates in `tasks.md` in order; the data foundation and a second local workflow must work before adding enrollment and collaboration.
