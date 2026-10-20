## Execution rules

This is an unchecked implementation plan. Reference contracts in this change are documentation, not completed runtime work. Work top to bottom; each gate must pass before exposing the next capability. Do not start by rewriting `App.vue` or implementing all services in one file.

For every UI slice: write the outer real-route Playwright Given/When/Then scenario first, implement the smallest vertical slice, then run its happy path plus failure/pending case. Do not substitute component snapshots or store mocks for outer BDD. Pure concurrency/crypto/storage cases belong in focused unit/integration tests. Keep user servers running and use a free alternate port.

Each numbered item is a bounded handoff: implement it, run its listed evidence, report changed files and results, then continue. Preserve unrelated dirty files. Do not mark a checkbox complete from code inspection alone. Use `design.md` and `contracts/*` to resolve choices; if a contract proves impossible, update the spec with the concrete contradiction before changing the architecture.

## 0. Baseline and outer scenarios

- [x] 0.1 Capture current `npm test` and `npm run build` results; inventory existing UI/agent/sync scenarios and save representative legacy data covering every field/status, one dangling link, templates, PDF artifacts, and local paths. Do not rewrite old expectations until their replacement scenario exists.
- [x] 0.2 Add `e2e/workspaces.spec.ts` with Given/When/Then cases for Blank board creation, renamed column persistence, custom-field failure, and subitem movement. Run to demonstrate the new behavior is absent, with failures attributable to missing feature rather than setup.
- [x] 0.3 Add outer Archive/restore and Needs placement scenarios, including a separately archived child and a cycle fixture. Add pending/save-failure scenario using a narrowly scoped storage-failure test hook.
- [x] 0.4 Add separate scoped-sync outer scenarios for own-device approval and workspace join, with an expired invite and a waiting approval state. Keep these unavailable to normal users until Gate C passes; do not ship buttons that claim unsupported access guarantees.

## 1. Gate A: Reusable local data foundation

- [x] 1.1 Translate `contracts/model.ts` into runtime types and strict validators in `src/domain/model.ts` (or a focused equivalent). Add fixtures for all kinds, field types, allowed/invalid parents, legacy IDs, and unsupported versions. Verify unknown-key/type rejection.
- [x] 1.2 Implement local identity/key bootstrap and initial device/actor signing needed for new writes. Private keys stay out of documents/exports. Use temporary test identities in tests. Verify simultaneous first-open tabs create one profile, fresh initialization, and unsupported-crypto failure; broader enrollment/chain verification follows Gate B.
- [x] 1.3 Implement workspace creation and Job search/Blank seeds. Allocate IDs once; expose stable preset bindings. Verify two workspaces are independent and no Job search fields leak into Blank board.
- [x] 1.4 Implement ancestry indexes, rational ranks, complete placement updates, and deterministic Needs placement projection. Verify exact rational ordering, equal-rank insertion, concurrent moves, missing parents, cycles, and bounded traversal without repair writes.
- [x] 1.5 Implement field validation and field/option lifecycle. Verify select IDs survive renames, archive/restore retains values, archived required fields stop blocking edits, and type-change rejection is non-destructive.
- [x] 1.6 Implement the transaction wrapper and per-document publication queue in `src/domain/commands.ts` / `src/crdt.ts`. Patch actual draft properties, attach native metadata, and obtain a signed change proof. Verify overlapping same-tab submissions and independent offline title/value edits both survive; invalid commands create no change.
- [x] 1.7 Replace singleton snapshot writes with document/change-hash persistence and atomic bytes/proof/receipt commits in `src/storage.ts`. Verify storage failure, same-ID retry, crash/reopen, stale-tab concurrent saves, and compaction with an unseen writer.
- [x] 1.8 Replace `src/state.ts` root-array copy commits with repository-backed projections/subscriptions. Notify replication only after durable commit. Verify focus/BroadcastChannel reconciliation and no outbound change on failed save.
- [x] 1.9 Implement initial format migration plan/backup/application and v2 bundle validation from `contracts/commands.md`. Verify exact preservation of IDs/relationships/archive timestamps, interrupted resume, different-workspace import, corrupt bundle rejection, and competing migration conflict.
- [x] 1.10 Build native workspace/board selection and data-driven columns in Vue. Satisfy 0.2's workspace/rename/reorder happy paths and empty-title failure. Preserve mobile snap behavior and 1024px controls.
- [x] 1.11 Build generic item/custom-field forms, subitem navigation, Archive, and Needs placement recovery. Satisfy 0.2/0.3, including restore-under-archived-parent explanation and save failure without partial item publication.
- [x] 1.12 Implement generic WebMCP commands over the workspace store. Verify valid visible mutation, invalid-input/no-mutation paths, and absence of preset-specific aliases.
- [x] 1.13 Gate A evidence: run focused unit suites, `npm run build`, and new local-workspace Playwright scenarios. Demonstrate a Reading board with Author field and nested item alongside Job search, with reload/export/import. No DSL, extra sync engine, or parallel state authority.

## 2. Gate B: Private root, authority, and verified history

- [x] 2.1 Implement private personal-root persistence, device registry, workspace references, and idempotent cross-document registration. Verify interruption after durable workspace creation resumes catalog registration without another workspace.
- [x] 2.2 Implement canonical signed envelopes, certificate-chain validation, actor bindings, workspace genesis/grants, and proof storage. Use one shared canonical encoder and domain separation; record fixed test vectors. Verify tampering, wrong document/person, chain cycle/depth, and unsupported algorithm failures.
- [x] 2.3 Implement trusted-document admission with isolated candidates and bounded missing-proof queues. Verify unauthorized root/workspace changes never publish and proof dependencies can arrive later without false durable acknowledgement.
- [x] 2.4 Implement native history projection and item history UI. Verify A/J attribution survives relay through K, old changes remain Legacy/imported, and timestamps never decide conflicts.
- [x] 2.5 Gate B evidence: run all local regression checks plus signing/admission suites and history happy/failure UI cases. Confirm workspace export contains public proofs but no private keys, personal root, or invitation secrets.

## 3. Gate C: Two explicit connection flows

- [x] 3.1 Replace unscoped v0 invitations in `src/sync/protocol.ts` with signed discriminated v1 invitations. Implement 10-minute expiry, fragment encoding, strict parsing, and legacy upgrade message. Verify wrong-kind fields and malformed links fail before joining.
- [x] 3.2 Implement `InvitationService` durable issuer-local redemption state with atomic single-target claim and same-target resume. Verify competing recipients, cancellation, expiry, source reload, and disconnect-after-approval.
- [x] 3.3 Implement own-device enrollment: fresh device key, transcript authentication code, source approval, delegated certificate, private-root release, and persistent trust. Verify identity_conflict preserves an existing different profile and pending devices receive no root/workspace metadata.
- [x] 3.4 Implement workspace join: preserve recipient identity, issue owner-signed editor grant, register one workspace, exclude unrelated roots/docs. Verify editor cannot grant access and a workspace link cannot enroll an owner device.
- [x] 3.5 Refactor `src/components/SyncDialog.vue` and `src/sync/useDeviceSync.ts` into service-driven steps. Implement chooser, scope, invitation, approval/acceptance, transfer, connected, waiting, retry, expired, cancelled, and failed states. Opening chooser must not start a node.
- [x] 3.6 Gate C evidence: real-route isolated-profile Playwright tests cover own-device success + pending/rejected approval and workspace join success + invalid/expired invitation. Check mobile dialog controls and post-reload durable trust. No mock merge in the outer tests.

## 4. Gate D: Incremental mesh replication and complete transfer

- [x] 4.1 Introduce `ReplicationService` with per-peer/per-document native Automerge sync state. Keep `SyncTransport` transport-only. Verify later edit transfers a delta and no calls to full-document save are used for each live update.
- [x] 4.2 Implement authorized document negotiation, Sync all live-catalog following, and workspace-only scope. Verify with A/J, A/K, B/L: A's two workspaces reach K; only invited workspace reaches B; future private workspace creation never discloses its ID/title to B.
- [x] 4.3 Implement reconnect/backoff, bounded framing/reassembly, proof exchange, and backpressure. Verify duplicated/delayed messages, missing dependencies, oversize rejection, known-peer reload, and idle traffic quiescence.
- [x] 4.4 Implement content-addressed blob storage and resumable 256 KiB chunks with hash verification. Preserve archived references/blobs. Verify interrupted transfer resumes and corrupted bytes never become available.
- [x] 4.5 Implement per-workspace document/file progress and complete-sync aggregation. Verify usable workspace with pending files, unavailable local-path artifacts, and no false "Everything synced" while transfer remains incomplete.
- [x] 4.6 Add same-browser multi-tab and isolated-profile reconnect regression coverage using the real transport adapter; deterministic transport fault tests complement rather than replace browser pairing.
- [x] 4.7 Gate D evidence: run relevant complete unit suites, `npm run build`, and scoped-sync/multi-profile Playwright suites. Record first-transfer bytes versus one-edit bytes, document load time, and peak memory for a fixed fixture of 1,000 items / 10,000 changes. Treat numbers as baseline measurements, not unsupported scalability promises.

## 5. Integration and handoff

- [x] 5.1 Update README and public agent guidance with generic commands, two connection scopes, export guarantees, browser lifetime, and explicitly unsupported revocation/recovery. Remove contradictory v0 product copy only after replacements pass.
- [x] 5.2 Reconcile pending `tincanban-v0-0-1` overlapping requirements using the design precedence table when archiving. Preserve still-applicable mobile/template/artifact behavior.
- [x] 5.3 Run `openspec validate workspace-kernel-and-scoped-sync --strict --no-interactive`, build, relevant tests, and final real-route happy/failure checks. Report exact evidence and any remaining unchecked items; never mark the whole change complete while a gate remains unverified.

## 6. Gate E: Typed JSON and visual structural tree schema editor

- [x] 6.1 Implement domain schema parsing, validation with precise JSON paths, type validation, diff generation, and conflict detection in `src/domain/schema.ts` and `src/domain/schema.test.ts`.
- [x] 6.2 Implement `updateBoardSchema` atomic command in `src/domain/commands.ts` persisting changes in a single Automerge transaction, archiving removed columns/fields while preserving stable IDs and values.
- [x] 6.3 Build `src/components/SchemaEditorDialog.vue` with synchronized dual views (Visual structural tree editor and Typed JSON text editor with error gutter and diff preview).
- [x] 6.4 Gate E evidence: run unit tests (`src/domain/schema.test.ts`: 5/5 passed) and Playwright E2E suite (`e2e/schema-editor.spec.ts`: 3/3 passed) covering bidirectional editing, rename/reorder persistence across reload, select ID retention, precise JSON path errors, and column archiving.

## 7. Gate F: Job search Rejected column and retrospective notes

- [x] 7.1 Restore `status.rejected` column definition in Job search preset seeds (`src/domain/seeds.ts`) and schema migrations (`src/domain/migration.ts`).
- [x] 7.2 Add optional retrospective note field (`field.rejectionReason`) to Job search board schema and card form dialogs (`src/components/ItemFormDialog.vue`, `src/components/ItemDetailDialog.vue`).
- [x] 7.3 Gate F evidence: run initial format migration and seed unit tests (`src/domain/migration.test.ts`, `src/domain/seeds.test.ts`), and Playwright E2E suite (`e2e/job-search-rejected.spec.ts`: 2/2 passed, `e2e/legacy-migration.spec.ts`: 2/2 passed) proving legacy rejected leads upgrade cleanly, move to Rejected retains retrospective notes across reload, and cards are never lost or unexpectedly archived.

## 8. User Steering: Direct sync selection and custom workspace sets

- [x] 8.1 Extend invitation protocol (`src/sync/protocol.ts`) to bind fixed workspace sets (`workspaces: WorkspaceItem[]`) and query parameters (`workspaceIds`, `workspaceTitles`) with full backward compatibility for single-workspace invitations (`workspaceId`, `workspaceTitle`).
- [x] 8.2 Extend invitation service (`src/sync/invitations.ts`) to validate issuer ownership across all selected workspaces and issue signed `WorkspaceGrant` records for each workspace in the fixed set.
- [x] 8.3 Extend replication service (`src/sync/replication.ts`) with `{ kind: "workspaces"; workspaceIds: string[] }` scope, strictly bounding document access and advertisement to the authorized fixed set, excluding unselected and future workspaces.
- [x] 8.4 Refactor `src/sync/useDeviceSync.ts` and `src/components/SyncDialog.vue` so clicking Sync immediately displays workspace checkboxes with the active workspace preselected, single "Generate link" on the same screen (disabled on empty selection), and distinct secondary "Add my device (Sync all)" enrollment. Opening list does not start transport node; generating invitation starts transport. Recipient displays all invited workspace names upon acceptance.
- [x] 8.5 Verification evidence: run protocol, invitation, replication, and sync hook unit tests (`npm test`: 23/23 files, 123/123 tests passed), and Playwright E2E suites (`e2e/scoped-sync.spec.ts`: 6/6 passed, `e2e/sync.spec.ts`: 11/11 passed, full suite: 36/36 passed). Validate OpenSpec contracts (`npx openspec validate workspace-kernel-and-scoped-sync --strict --no-interactive`).

## 9. User Steering: Inline board editing and complete workspace settings

- [x] 9.1 Move `Edit board` into desktop header and mobile Settings group. Remove separate edit row. Keep entity-name/field editing behind `Edit {entityName}` in edit mode.
- [x] 9.2 Replace native HTML dragging with pointer/touch sortable behavior. Cards support exact within/across-column order; columns drag by header only; failed persistence restores committed DOM.
- [x] 9.3 Replace template-kind enum with generic root `document_template`; retain legacy reads.
- [x] 9.4 Add strict `WorkspaceSettingsDraft` projection and validation for workspace title, active board, columns, fields/options, and document templates. Exclude items and private/runtime material.
- [x] 9.5 Add atomic `updateWorkspaceSettings` plus WebMCP `get_workspace_settings` / `apply_workspace_settings` using expected heads.
- [x] 9.6 Add Workspace Settings Document templates/JSON views. Show precise JSON paths and disable invalid apply.
- [x] 9.7 Remove inline styles from active recent components and verify desktop/mobile dialog geometry, square controls, board/archive layout, drag success, and storage-failure restoration on real routes.
- [x] 9.8 Run full unit, build, OpenSpec strict validation, complete Playwright suite, then deploy and verify production.

## 10. User Steering: Column creation actions and overlay notices

- [x] 10.1 Move `Add {entityName}` from desktop/mobile headers into every expanded column and preselect the source column.
- [x] 10.2 Render success and storage notices in a fixed overlay with explicit dismissal and bounded auto-dismiss; preserve form errors and pending-save state.
- [x] 10.3 Verify happy, auto-dismiss, mobile layout, and storage-failure states; run all checks, deploy, and smoke-test production.

## 11. User Steering: Schema-driven filters

- [x] 11.1 Replace job-search filter enums with column IDs, live select option IDs/titles, number ranges, boolean values, and date ranges from the active schema.
- [x] 11.2 Apply the same search/filter path to preset and generic workspace items; reset filter state when switching workspaces.
- [x] 11.3 Verify renamed options, generic select filtering, numeric schema bounds, regressions, build, and OpenSpec.

## 12. User Steering: Wide desktop board layout

- [x] 12.1 Remove the fixed board-width ceiling and unnecessary stable scrollbar gutter while retaining narrow-screen horizontal navigation.
- [x] 12.2 Verify a 1920px board fills the viewport and has no horizontal overflow when its columns fit.

## 13. User Steering: Explicit Archive column role

- [x] 13.1 Replace public collapsed-column configuration with one optional `archive: true` column role.
- [x] 13.2 Validate at most one Archive column and make generic rendering and archive moves title/ID/preset-independent.
- [x] 13.3 Verify renamed Archive persistence and exact duplicate-role validation through real Workspace Settings JSON flow.

## 14. User Steering: Mesh member device details

- [x] 14.1 Extend signed peer advertisements and durable peer views with bounded optional device name and user agent metadata without using either for authority.
- [x] 14.2 Expand selected mesh members into device rows with presence, shortened ID, last seen, best-effort browser/OS, and raw user agent details.
- [x] 14.3 Keep old advertisements valid and render missing UA as unknown; verify known and unknown UI paths, unit parsing, full tests, and OpenSpec validation.
