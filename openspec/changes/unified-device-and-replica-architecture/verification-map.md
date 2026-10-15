# Final acceptance map

Every scenario remains an acceptance obligation. Artifact references identify
source and scenario locations; they do not imply a pass or deployment. The map
records required final evidence, not a test-count diary. Evidence must come from
the coordinated source and exact release artifacts; deployment remains a
separate proof from local or CI success.

Requirements remain in [the specification](specs/device-and-replica-contracts/spec.md),
[history contract](history-archive-contract.md) and [remaining tasks](tasks.md).
A nearby passing test cannot close an entire scenario.

| # | Acceptance scenario | Source and scenario references | Relevant invariant | Final evidence required |
|---|---|---|---|---|
| 1 | Rusty is connected after the phone was enrolled | `e2e/complete-device-state.spec.ts`; `src/sync/useBlindReplication.test.ts`; `src/sync/identityReplicaConnection.test.ts`; `src/sync/rustyManagement.native.test.ts`; `src/sync/useDeviceSync.test.ts`; `src/sync/deviceSyncEnrollment.test.ts`; `src/sync/identityReplica.test.ts` | Existing board-only Rusty origins trigger identity-scope provisioning; transferred credentials/capability remain distinct from receiver-local progress. Tombstones, conflicts and a changed identity block setup. | Isolated Chromium + WebKit traces; stored state shows credential/capability delivery, receiver-local cursor/ack, verified server receipt and ordinary scheduler setup/sync. Native HTTP and focused scheduler/setup tests are supporting evidence, not browser/deployment proof. |
| 2 | Profile update with the source device closed | `e2e/complete-device-state.spec.ts`; `src/sync/rustyManagement.native.test.ts`; `src/sync/useBlindReplication.test.ts`; `src/sync/identityReplicaConnection.test.ts`; `src/app/identityPhoto.test.ts`; `src/chat/serviceProfile.test.ts`; `src/app/useMemberAvatars.test.ts` | Rusty-acknowledged admitted profile/photo wins over generated or stale avatar observations; source must be unnecessary for recipient pull. | Browser run with source closed; recipient persisted latest profile/photo; stale observation rejected. Keep native and scheduler results as protocol/runtime evidence, not browser/deployment proof. |
| 3 | Required transfer schema is unsupported | `src/sync/identityDeviceStateCodec.test.ts`; `identityDeviceTransfer.test.ts`; `e2e/complete-device-state.spec.ts`; `src/sync/deviceSyncEnrollment.test.ts` | Unknown required state blocks completion without replacing identity or local data. | Test output plus before/after identity and data snapshots and explicit upgrade state. |
| 4 | Different person or revoked device requests private state | `src/sync/identityDevicePreferences.test.ts`; `e2e/complete-device-state.spec.ts`; `src/sync/keeperRevocation.test.ts`; `src/sync/deviceSyncHost.test.ts` | Same-person authentication and current non-revocation required; no secret/capability leakage. | Negative cases assert response omits private fields and persisted state unchanged. |
| 5 | Encrypted recovery restores complete private identity state | `src/sync/identityDeviceRecovery.test.ts`; `identityDeviceRecoveryCodec.test.ts`; `deviceRecovery.test.ts`; `e2e/identity-recovery-package.spec.ts` | Same manifest, authenticated root binding, atomic adoption, preserved same-person device/progress and restartable projections. | Final logic/fault-injection results plus isolated Chromium/WebKit restore; cold replacement retains previous identity backup and private credentials without source-device availability. |
| 6 | Invalid or older recovery files retain explicit scope | `e2e/identity-recovery-package.spec.ts` | Substitution/size/version checks before adoption; old seed-only reader explains missing state; no invented credentials or device-key export. | Final negative and legacy-reader cases; original durable bytes survive rejected/aborted import; browser input failure preserves words and board. |
| 7 | Optional device-state extensions survive transfer and conflict | `src/sync/identityDeviceExtensions.test.ts`; `src/sync/rustyManagement.native.test.ts`; `src/sync/identityDeviceTransfer.ts`; `identityDeviceActivation.ts`; `e2e/complete-device-state.spec.ts` | Unknown optional payloads remain opaque and optional; same-name variants are canonicalized, deduplicated and retained together without clock selection or arbitrary winner. | Show exact name/schema/value survive opposite-order imports and re-export; no variant becomes required. Final device-flow evidence must cover both devices. |
| 8 | Optional-state activation aborts without replacing newer local state | `src/sync/identityDeviceExtensions.test.ts`; `src/sync/identityDeviceActivation.ts`; `e2e/complete-device-state.spec.ts` | Activation applies required and optional device state with a single compare-and-swap; malformed/newer stored extension data fails closed and preserves retained bytes. CAS retries replan against current state. | Show before/after identity, private state and extension bytes; newer storage format requests upgrade; abort leaves no partial import. Include final device-flow evidence. |
| 9 | Profile observation arrives before its workspace is installed | `src/sync/identityProfileProjection.test.ts`; `src/chat/privateProfileObservation.test.ts`; `src/sync/rustyManagement.native.test.ts` | Same-person author signature and complete chain authenticate the observation only; no workspace owner/grant derives from the record’s `authority` wrapper. Outer document reference and signed chat scope remain distinct. | Final connected enrollment must prove close-source observation handling and workspace-scope isolation. Keep old-reader compatibility and product recovery/diagnostics UI as separate acceptance obligations. |
| 10 | Deferred profile projects after verified workspace installation | `src/sync/identityProfileProjection.test.ts`; `src/sync/identityProfileProjectionQueue.test.ts`; `src/app/useIdentityProfileRecovery.test.ts`; `src/sync/identityDeviceActivationLoader.test.ts`; `src/chat/privateProfileObservation.test.ts` | Projection requires current installed document scope and owner/grant/revocation admission, detached original record, durable chat confirmation and identity/authority guards. A failure retains the exact item; one unavailable workspace cannot block the queue. | Demonstrate deferred projection after real workspace installation, including retained failure reason, per-item recovery, browser diagnostics and old-reader behavior. Causal global name/photo acceptance is tracked separately. |
| 11 | Causally later photo removal survives clock skew | `src/domain/identityProfileState.test.ts`; `src/sync/identityProfileTransferCompatibility.test.ts`; `src/sync/rustyManagement.native.test.ts`; `saveIdentityPhoto`; `e2e/identity-profile-conflicts.spec.ts` | Signed causal operations, not timestamps, determine global photo; stale source snapshots merge without reversing later changes. | Final cold multi-device flow must show removal survives skew and reload. |
| 12 | Concurrent incompatible identity changes require explicit resolution | `src/domain/identityProfileState.test.ts`; `src/sync/identityProfileTransferCompatibility.test.ts`; `e2e/identity-profile-conflicts.spec.ts` | Both causal values remain candidates until the user observes both and signs a resolution; neither merge order nor arrival time selects a winner. | Final focused and browser results required.  |
| 13 | Legacy profile observations gain causality only on explicit save | `src/domain/identityProfileState.test.ts`; `src/sync/identityProfileTransferCompatibility.test.ts`; `profile-observations@1/@2`; `src/app/identityProfile.atomic.test.ts`; `e2e/identity-profile-conflicts.spec.ts` | Imported timestamps remain non-causal. Explicit reviewed save creates signed causality; older imports cannot supersede it. | Verify reviewed save and rejected older import in the connected flow; retain old-reader compatibility evidence. |
| 14 | Shared workspace projection cannot overwrite private identity state | `PersonalRootDocumentV1.profileState`; `src/sync/identityProfileTransferCompatibility.test.ts`; `src/sync/identityProfileProjection.test.ts` | Shared chat projection and private identity causal state keep separate scopes; shared timestamps cannot rewrite private authoritative values. | Focused reader/model evidence and future browser cross-path exercise; do not treat separate projection tests as proof of end-to-end isolation. |
| 15 | Name and photo save atomically | `src/app/identityProfile.atomic.test.ts`; `vendor/meta-mesh/packages/mesh-identity/src/deviceRename.test.ts`; `src/storagePersonalRoot.test.ts`; `e2e/identity-profile-conflicts.spec.ts` | Both fields, root presentation and local SDK presentation commit as one transaction; notification follows successful commit only. | Verify connected Save and abort behavior in Chromium and WebKit, including notification only after commit. |
| 16 | A stale profile draft requires review | `src/app/identityProfile.atomic.test.ts`; `src/storagePersonalRoot.test.ts`; `e2e/identity-profile-conflicts.spec.ts` | Draft is bound to captured causal revision; incoming change cannot be silently overwritten. Save after review must use the newly observed revision. | Verify drafts/history remain visible and unchanged after rejection, then explicit reviewed retry. Include missing/mismatched local profile and private-key preflight in the connected flow. |
| 17 | Equivalent owner devices use different valid certificate paths | `../mesh-lighthouse/src/management_tests.rs`; `../mesh-lighthouse/src/blind_tests.rs`; `vendor/meta-mesh/crates/meta-mesh-core/src/coownership_tests.rs` | Rights derive from same current person/scope capability, not certificate ancestry. | Focused Rust cases establish protocol behavior; final browser/cross-service run and release cohort evidence remain required. |
| 18 | Unrelated certificate is appended | `../mesh-lighthouse/src/publication_security_tests.rs`; `../mesh-lighthouse/src/blind_tests.rs` | Appended trusted certificate cannot broaden identity proof or rights. | Focused rejection tests exist; final endpoint mutation/receipt assertion remains required. |
| 19 | Revocation reaches another relay | `src/sync/keeperRevocation.test.ts` | Monotonic revocation applies across relay/capability; future content key rotation; no claim of erasing downloaded plaintext. | Rust and client negative outputs; new writes rejected on both endpoints; UI wording assertion. |
| 20 | Legacy owner policy migrates | `rustyPersonMigration.test.ts`; `rustyDeviceAccess.test.ts`; `useBlindReplication.test.ts`; `e2e/rusty-device-access.spec.ts`; `rustyManagement.native.test.ts` | Explicit owner action; retain service/scope/token/cursor/device binding. Background reports pending migration; saved authorized requests recover without renewed approval. No ambient certificate rewriting. | Final service/repository/controller cases and Chromium/WebKit happy, pending and failure states; original signed receipt, exact retry, unchanged connection bytes and independent device authority after original device closes. |
| 21 | Another same-person device creates a scope after person migration | `../mesh-lighthouse/src/person_management_tests.rs::given_person_policy_when_unrelated_owner_devices_create_scopes_after_pins_are_removed_then_rights_do_not_depend_on_ancestry`; `src/sync/rustyManagement.native.test.ts` | New-resource authorization uses exact root-person capability/revision, pinned service/person and `resource.create`; no ancestry or online-primary dependency after one-time migration. The first explicit migration still uses configured legacy controller proof. | Final connected device flow and exact release-artifact evidence must complement protocol coverage. |
| 22 | Person revocation gates every resource operation | `../mesh-lighthouse/src/person_management_tests.rs::given_global_device_revocation_then_existing_scope_status_enrollment_and_completed_retries_reject_that_device`; `given_global_person_revocation_then_valid_resource_capabilities_cannot_status_challenge_stage_or_checkpoint`; `src/sync/rustyPersonManagementClient.test.ts` | Current person revocation overrides resource operations despite otherwise valid resource caps; it does not revoke previously disclosed bearer tokens or plaintext. Future key/token rotation remains separate. | Reported Rust/client test outputs establish current covered endpoints. Global revocation UI, full application caller matrix and separate future-key/token rotation remain final-gate evidence. |
| 23 | Pending person policy blocks resources but permits recovery | `../mesh-lighthouse/src/person_management_tests.rs::given_person_policy_pointer_fault_then_resources_stop_until_exact_retry_recovers_without_retiring_old_evidence` | Pending policy blocks resource management but permits authenticated person status and replay of the exact durable request; service pin and historical evidence remain intact. | Reported Rust plus focused client outputs. Browser recovery UX and broader cross-tab/restart fault matrix remain unverified. |
| 24 | Person policy evidence and service pin survive restart | `../mesh-lighthouse/src/person_management_tests.rs`; `src/sync/rustyManagement.native.test.ts` | Historical signed policy evidence is retained across pending update/restart; service/person binding cannot be used across origins. | Reported tests cover current cases. Exact byte-for-byte historical signature audit and comprehensive service-pin replacement/restart matrix remain final-gate evidence. |
| 25 | Enrolled device creates and reopens a workspace | `src/sync/workspaceSigning.test.ts`; `e2e/workspaces.spec.ts` | Genesis signed by complete verified chain; Owner access survives reload without root key. | Passing resolver/genesis tests and isolated reload flow with verified authority evidence. Default API logic proof does not establish browser reload/last-workspace flow. |
| 26 | Signing ancestor is missing or forged | `src/sync/enrollment.test.ts`; `src/sync/invitations.test.ts`; `src/sync/keeperControllerSigning.test.ts`; `src/sync/identityDevicePreferences.test.ts` | No command/genesis commit or assumed Owner fallback without complete chain. | Rejected results and unchanged journal/genesis; recoverable evidence error asserted. |
| 27 | Context becomes stale during an operation | Acceptance-specific artifact still needs mapping. | Identity/device/scope/revision/expiry revalidated at commit and external request. | Race test rejects commit/request; no durable change or success receipt. |
| 28 | Historical evidence differs from current context | `src/app/automationOwnershipRenewal.test.ts` | Historical signed evidence remains immutable and verifiable independently of current signer context. | Original bytes/signature unchanged and verify under recorded historical chain after renewal. |
| 29 | Process stops during a preference update | `src/sync/identityDevicePreferences.test.ts`; `e2e/storage-atomicity.spec.ts` | One authoritative atomic preference record; restart sees whole old or whole new state. | Injected abort at each write boundary; reopened DB has a valid complete state and no projection divergence. |
| 30 | Device clock is far ahead | `src/sync/identityDevicePreferences.test.ts` | Causal/logical revision ordering, independent of wall clock. | Both orderings converge to causal result despite large timestamp skew. |
| 31 | Concurrent remove and update | `src/sync/identityDevicePreferences.test.ts`; `src/sync/keeperIntegrationSettingsApi.test.ts` | Removal persists until later causal re-add; reconnect/import cannot resurrect stale entry. | Convergence test and restart/reconnect assertion; only explicit later causal add restores. |
| 32 | Concurrent incompatible credentials | `src/sync/identityDevicePreferences.test.ts` | Durable surfaced conflict; no arbitrary credential selection or replication. | Conflict survives restart; replication is blocked for that scope and other scopes continue. |
| 33 | Cursor arrives after credential rotation | `src/sync/identityDevicePreferences.test.ts`; `src/sync/blindReplication.test.ts` | Cursor write conditional on exact credential revision, isolated by scope. | Stale cursor commit rejected; rotated record and unrelated scope byte-for-byte unchanged. |
| 34 | Unchanged browser or Worker polls | `vendor/meta-mesh/packages/mesh-replication/src/hostContract.test.ts`; `workers/automation/tests/replica.runtime.test.ts`; `src/sync/blindReplication.test.ts` | Revision-first no-op avoids historical reads/serialization/hash and uploads on both hosts. | Deterministic counters equal zero for forbidden work on browser and Worker; no new object. |
| 35 | One changed card | `hostContract.test.ts`; `src/workspaceDeltaJournal.test.ts`; `src/stateLocalSavePerformance.test.ts` | Ordinary write handles bounded new transition; does not replay lifetime history. | Operation counters/read bounds against 1k/10k/100k histories with same bounded transition work. |
| 36 | Upload acknowledgment is lost | `hostContract.test.ts`; `workers/automation/tests/replica.runtime.test.ts`; `src/sync/blindReplication.test.ts` | Retry exact persisted ciphertext; ack advances only after valid receipt. | Restart test compares ciphertext bytes; invalid/missing receipt leaves cursor/ack unchanged. |
| 37 | Shared engine hosts a restricted automation | `vendor/meta-mesh/packages/mesh-workspace/src/causalAdmission.test.ts`; `workers/automation/tests/replica.runtime.test.ts`; `src/domain/automationContract.test.ts` | Shared engine does not confer Owner/Editor fallback; every receiver checks exact signed scope. | Both local and receiver rejection; no admitted transition or privilege expansion. |
| 38 | Long editing history reaches the active budget | `src/sync/blindCheckpoint.test.ts`; `src/workspaceDeltaJournal.test.ts`; `vendor/meta-mesh/crates/meta-mesh-core/src/history_rebase/tests.rs` | Owner-authorized baseline bounds active tail while authenticated archive preserves original history. | Final evidence must measure the cold checkpoint path at the exact storage-sequence fence, prove covered snapshot-prefix replacement only, and retain original classifications and catalogue sources. |
| 39 | Unauthorized history is present | `vendor/meta-mesh/crates/meta-mesh-core/src/history_preparation/tests.rs`; `vendor/meta-mesh/crates/meta-mesh-core/src/history_preparation/capture_tests.rs`; `vendor/meta-mesh/crates/meta-mesh-core/src/history_capture.rs`; `vendor/meta-mesh/packages/mesh-replication/src/historyCaptureInterop.test.ts` | Baseline cannot admit pending/quarantined data or fabricate provenance. | Classification remains unchanged before/after; forged author/admission proof rejected. |
| 40 | History beyond the baseline is opened or restored | `src/sync/historyArchiveReader.test.ts`; `src/app/useArchivedItemHistory.test.ts`; `src/app/workspaceHistoryRecovery.integration.test.ts`; `e2e/attachment-session-recovery.spec.ts` | Fetch authenticated bounded paths from the authorized root without sender-local routing; restore emits a fresh authorized command and retains originals. | Final browser proof must show lazy parent-catalogue traversal, selected bounded object reads, complete private-backup coverage, and fresh authorized restore while preserving originals. |
| 41 | Archive preparation or baseline activation fails | `vendor/meta-mesh/crates/meta-mesh-core/src/history_basis.rs`; `src/sync/historyBaselineTransition.test.ts`; `src/sync/receivedHistoryBaselineRepository.test.ts` | Keep prior usable history until complete coverage, Owner authorization and atomic activation; private Native storage proof and serialized adapter results cannot authorize activation alone. | Fault matrix must prove old basis recoverable and activation incomplete at every boundary. |
| 42 | Storage capacity is exhausted | `vendor/meta-mesh/packages/mesh-replication/src/historyArchiveBytes.test.ts`; `vendor/meta-mesh/packages/mesh-replication/src/historyArchiveRemote.test.ts`; `vendor/meta-mesh/packages/mesh-replication/src/historyArchiveAdversarial.test.ts`; `src/sync/historyBaselinePublicationRepository.test.ts`; `src/components/WorkspaceHistoryMaintenance.vue`; `e2e/attachment-session-recovery.spec.ts` | Pending changes recover; explicit capacity cause; no silent history deletion or total-size promise. | UI maps quota to a clear retry message; E2E injects quota at transition claim and checks workspace/baseline preservation. Browser execution remains required. |
| 43 | Older client encounters a new baseline | `scripts/check-prior-history-reader.mjs`; `src/sync/rustyManagement.native.test.ts` with `TINCANBAN_PRIOR_READER_PROBE=1`; `src/sync/historyBaselineWire.test.ts`; `e2e/release-upgrade.spec.ts` | Unknown baseline policy/schema prevents incompatible writes and reports safe upgrade. | Actual production release `07242d4880821829026234ca1a3cb6bd07ee29fe` (deployment `38545039241`, SDK `111943361d2c765557da00bbc568596ff1a5d047`) was resolved from production release metadata. Its exact committed policy JS/WASM admits retained original history; its exact prior snapshot reader and AES decoder reject the current authenticated v2 compact-baseline fixture before merge, chat, upload or cursor persistence, preserving original bytes. The prior Native artifact has no baseline API: this proves safe rejection at its real receive boundary, not prior Native understanding of the new format or prior UI upgrade messaging. Current upgrade messaging remains a separate browser assertion. Reproduce the focused Native catalogue scenario with `TINCANBAN_PRIOR_READER_PROBE=1`; both pinned Git objects must be available. |
| 44 | Attachment arrives with the source browser closed | `e2e/attachments-rusty.spec.ts`; `vendor/meta-mesh/packages/mesh-blob/src/streamStore.test.ts`; `src/attachments.streaming.test.ts`; `File.slice`; `File.arrayBuffer()`; `attachmentTransfer.test.ts`; `createBlindReplica`; `Complete on Rusty`; `attachmentCoverage.test.ts`; `e2e/attachments-offline.spec.ts`; `downloadStream` | Rusty retains authorized encrypted manifest/chunks and the locator snapshot; source process not required. Completion follows blob receipts plus durable index/snapshot acknowledgment; local bytes or a locator alone do not imply completion. | Chromium + WebKit flow; source closes, recipient confirms status, then downloaded bytes match original. Native HTTP proves current production path, not browser behavior, service-credential migration or end-to-end streaming. |
| 45 | Session closes during a transfer | `vendor/meta-mesh/packages/mesh-blob/src/index.ts::requestBlob`; `finally`; `vendor/meta-mesh/packages/mesh-transport/src/index.ts`; `meshNetworkConnection`; `BrowserStream.reset()`; `closeSend`; `e2e/attachment-session-recovery.spec.ts` | A cancelled request releases only its stream, settles pending IO, preserves the connection for reuse, and retries only after current session/authority validation; old adapters remain usable through the fallback. | Final browser proof must confirm stream cancellation, connection reuse, and guarded retry; service credential/key migration remains a separate obligation. |
| 46 | Oversized peer response is stopped before EOF | `MeshStream.read(maximumBytes?)`; `DuplexStream`; `IrohStream`; `mesh-blob`; `ceil(256 KiB / 3) * 4 + 4096`; `vendor/meta-mesh/vendor/iroh-webrtc-transport/src/core/stream_state/tests.rs` (`StreamState::read_to_end`, `remaining + 1`) | Reject over-limit data before FIN or cache publication, reset only that stream, keep the connection usable, accept exact-limit chunks. | Preserve final stream-state, focused transport/blob and browser evidence for early rejection, stream reset and connection reuse at exact and over-limit sizes. |
| 47 | Missing or corrupt chunks | `attachmentCodec.test.ts`; `attachmentTransfer.test.ts`; `vendor/meta-mesh/packages/mesh-blob/src/streamStore.test.ts`; `attachmentStreaming.test.ts` | Require authenticated complete manifest and chunk binding before display. | Each tamper case leaves attachment incomplete and yields no displayed bytes. Core/local-store rejection is supporting evidence; final UI assertions remain required. |
| 48 | Network and authorization failures differ | `attachmentAccess.test.ts`; `tincanban-local-state-v1` | Distinct actionable network/access/upload states; no false complete backup. | State assertions per injected cause and coverage remains incomplete. Corrected tests prove local IndexedDB-backed guard behavior, not final UI/browser behavior. |
| 49 | Service storage and logs are inspected | `rustyManagement.native.test.ts` | Server stores ciphertext/opaque metadata only; no plaintext/content keys. | Restart retrieval plus filesystem/log sentinel scan and key/plaintext absence assertions, including enabled diagnostic delivery before whole-requirement completion. |
| 50 | Writer upgrade preserves legacy attachment discovery | `src/sync/replicaWriterUpgrade.test.ts`; `src/sync/workspaceReplicaWriter.test.ts`; `src/sync/rustyManagement.native.test.ts`; `ensureWorkspaceReplicaWriter` | Migrate legacy locators before raising the floor; publish writer-v2 preference and rebound local progress only after receipt. | Focused IndexedDB + native HTTP outputs and old/new locator reads. These establish the local transition path, not old-reader rollout or browser acceptance. |
| 51 | Writer upgrade retries after an uncertain receipt or local commit | `src/sync/replicaWriterUpgrade.test.ts`; `src/sync/workspaceReplicaWriter.test.ts` | Retain intent and avoid claiming upgrade after uncertainty; retry the authorized monotonic operation against current local profile/preferences. | Test output proves intent remains until receipt verification and exact local CAS; full browser restart and deployed-service evidence remain required. |
| 52 | Pending outbox blocks writer upgrade | `src/sync/replicaWriterUpgrade.test.ts`; `src/sync/workspaceReplicaWriter.test.ts` | Do not raise server floor while same-scope pending ciphertext is unresolved. | Assert no writer-upgrade request; exact pending object/request, preferences and index remain unchanged. This does not complete explicit key/token migration. |
| 53 | Concurrent preference or identity change blocks writer-upgrade publication | `src/sync/replicaWriterUpgrade.test.ts`; `src/sync/workspaceReplicaWriter.test.ts`; `src/sync/privateReplicaFactory.ts`; `ensureWorkspaceReplicaWriter`; `src/sync/privateReplicaLoop.ts` | A stale upgrade cannot publish progress into a changed connection or another identity; migration remains a normal-loop operation behind live owner/revocation checks. | Focused IndexedDB/native results plus browser acceptance and full release gate. A separate unsafe key/token change with pending ciphertext is refused for explicit migration. |
| 54 | Existing Worker access is refreshed with a writer-floor upgrade | `src/sync/workspaceReplicaWriter.test.ts`; `replicaWriterUpgrade.test.ts`; `workspaceReplicaWorkers.test.ts`; `automationInstanceClient.test.ts`; `workers/automation/tests/replica.runtime.test.ts`; `runtime.runtime.test.ts`; `rustyManagement.native.test.ts` | Refresh policy revision without changing grant/expiry/rights, definition, control state, exact pending ciphertext/request IDs, deduplication state or cursor. Unsupported Worker must fail before a fresh remote mutation; lost reply retains signed confirmation and the complete route union. | Focused non-browser protocol, client, journal and Workerd evidence exists. These tests do not prove one deployed frontend/Worker/Rusty cohort or final browser behavior. Live untyped grants without routes require explicit adoption/removal; final migration/old-reader/release gates remain open. |
| 55 | Display Role differs from original posting title | `applicationSourceIntakeCommand.test.ts`; `automationSourceContract.test.ts`; `replica.runtime.test.ts`; `e2e/application-source-binding.spec.ts` | Immutable original posting evidence drives matching; editable display label is separate. | Match selects the unique original application after rename; source record unchanged. |
| 56 | Employer page changes or disappears | `e2e/application-source-binding.spec.ts` | Retained submission observation remains immutable; live page cannot replace original evidence. | Fixture matrix retains same original evidence, captures missing state, and never overwrites it. |
| 57 | Two applications or a renamed HR title are ambiguous | `applicationSourceMatching.runtime.test.ts`; `src/domain/applicationBinding.test.ts`; `replica.runtime.test.ts`; `e2e/application-source-binding.spec.ts` | No automatic move on ambiguity; owner selection uses retained event without forwarding or title edit. | No-move assertion, selectable event/application IDs, original message and card title unchanged. |
| 58 | Owner binds and retries a retained rejection | `applicationBindingStore.runtime.test.ts`; `applicationBindingEvidence.runtime.test.ts`; `replica.runtime.test.ts`; `e2e/automation-instance-management.spec.ts` | Binding is auditable and durable; retry rechecks classification, grant, dedup and causal workflow. | Signature/audit survives restart; permitted current binding moves once; replay deduped. |
| 59 | Binding is replayed against another card or newer workflow | `src/domain/applicationBinding.test.ts` | Binding cannot change event, scope, integration, card, source or current workflow authority. | Tamper/staleness matrix rejects every attempt with no card transition. |
| 60 | Partial deployment fails | `workers/frontend/release.test.mjs` | Release stays incomplete; compatible readers/data preserved; component success cannot imply cohort success. | Immutable manifest fixture, induced failure, incomplete activation record, prior reader still opens retained data. |
| 61 | All final checks and deployments succeed | `scripts/release-cohort.test.mjs`; `scripts/release-coordinator.test.mjs`; `scripts/deploy-rusty-cohort.test.mjs`; `workers/frontend/release.test.mjs`; `.github/workflows/ci.yml`; `.github/workflows/deploy-frontend.yml` | Activate only exact tested artifact cohort after all checks and production capabilities match. | Final CI artifacts, signed manifest, successful staged activation, production component SHA/digest/capability report. Source fixtures and workflow wiring are not execution or deployment evidence. |
| 62 | Existing phone tab uses an older build | `src/release/runtimeRelease.test.ts`; `e2e/storage-upgrade-block.spec.ts`; `e2e/release-upgrade.spec.ts` | Old tab reports version/upgrade, preserves local data and refuses stale writes. | New browser scenario observes incompatible release metadata, shows read-only notice, rejects item signing and retains workspace state. Chromium + WebKit execution and deployed old-tab proof remain required. |
| 63 | Rollback after a schema migration | `workers/frontend/release.test.mjs`; `e2e/storage-upgrade-block.spec.ts` | Activate only reader compatible with retained baseline/archive/migration evidence; preserve pending events. | Forward-migrate/rollback fixture passes with data hashes, archive proofs and pending events intact. |
| 64 | Only some requirements are implemented | `scripts/release-coordinator.mjs` (`assertImplementationGate`); `scripts/release-coordinator.test.mjs` (“unfinished architecture implementation”); `.github/workflows/deploy-frontend.yml` | No E2E or release preparation before all implementation areas and required non-E2E checks pass. | Gate fixture rejects an incomplete implementation; final checklist and CI evidence must still show every area complete before release authorization. |
| 65 | Final verification exposes a defect | `scripts/release-coordinator.test.mjs` (interrupted rollout and failed native recovery); `scripts/release-recovery.test.mjs`; `.github/workflows/recover-release.yml` | Repair meaningful failures and rerun affected checks; never bypass a failure to claim success. | These fixtures cover interrupted-stage refusal/recovery. They do not preserve a real final-run failure report; final evidence must retain the failing run, corrective diff and rerun result for affected scenarios plus the required suite. |
| 66 | Dense bilingual board stays readable on desktop and mobile | `e2e/reading-typography.spec.ts`; `.card-notes` | Preserve entire existing card, metadata, filter and board appearance. | Final Chromium + WebKit evidence at desktop/mobile widths; Latin/Cyrillic samples, card title/company/metadata/notes remain Caveat, no horizontal clipping or hidden vertical content. |
| 67 | Long details, chat and settings remain readable | `e2e/reading-typography.spec.ts` | Fira Sans only inside detail prose and discussion/chat prose; application labels/controls retain existing Caveat; Fira Code only for code and `settings.json`. | Final Chromium + WebKit evidence for representative detail/chat prose, non-clipped vertical text and reachable controls. |
| 68 | Font load is blocked | `e2e/reading-typography.spec.ts` | System fallback keeps content/UI usable; font failure cannot block startup or discard entered text. | Chromium + WebKit; board and detail still render, edit persists, controls/content remain available with Caveat, Fira Sans and Fira Code assets unavailable. |
| 69 | Text zoom and reduced motion preserve readability | `e2e/reading-typography.spec.ts` | Scaled text/actions remain reachable without horizontal or hidden vertical clipping. | Chromium + WebKit with 40px root font size and reduced-motion emulation; no hidden vertical overflow and key controls can scroll into view. This does not emulate browser text-only zoom and does not verify status/navigation motion semantics; those remain final-gate gaps. |
| 70 | Authorized collaborator and enrolled device back up and restore compact history offline | `e2e/attachment-session-recovery.spec.ts` (the “archived owner baseline” and “adding my phone” scenarios); `src/sync/browserPeerHistoryBaselineReceive.ts`; `src/sync/peerHistoryRecovery.ts`; `src/app/workspaceHistoryRecovery.ts` | Collaborator receives and independently verifies the Owner-attested baseline over its authenticated device channel without Rusty credentials; backup coverage comes from retained original archive bytes, and restore re-verifies baseline authority before offline item-history access. Missing ciphertext must produce incomplete coverage; no trusted host flag substitutes for Native verification. | The isolated WebKit “archived owner baseline” scenario passed on 2026-10-15 (1/1; `/tmp/old-webkit-backup-clean-20261015`). Final two-generation enrollment passed serially in Chromium (1/1; `/tmp/two-epoch-final-paged2-chromium-20261015`) and WebKit (1/1; `/tmp/two-epoch-final-paged-webkit-20261015`): complete backup inspected, both archive pages read and original version restored with the owner closed. An enrolled device without the identity root can inspect and restore that backup; creating a full identity-root backup requires the original device. Hosted CI and exact deployed-cohort evidence remain separate gates. |

## Current integration obligations

History paths now connect Native baseline admission, `src/storageDeltaAccess.ts`
accounting, peer/Rusty archive readers, private-backup coverage, and restore in
`src/app/workspaceHistoryRecovery.ts` with startup projection in
`src/statePersistence.ts`. Source wiring does not establish restart, unchanged-
state budget, coverage, or authorization behavior. The isolated WebKit
single-baseline recovery and final serial two-baseline Chromium/WebKit enrollment
scenarios passed; exact evidence is recorded in row 70. Hosted CI and production
activation remain open.

Requirement 8 keeps immutable-source matching and signed retained-event binding
contracts. Existing API, Native and Worker tests remain relevant; the universal
inbox and any new email queue/selection screen are specification-only for this
release. Existing application-binding browser cases cover their named retained
event flows, not a universal inbox product surface.

The preproduction release uses the existing writer policy; no new writer-3
migration/rejection program is required. Preserve current boards, old keys,
pending ciphertext and original signed evidence. Internal stored-format tags
remain only where actual parsing needs them. Roll out one exact frontend,
automation Worker, shared SDK and Rusty cohort through CI, then verify deployed
artifact identities. Open tabs must load that release before their behavior can
serve as deployment evidence.

Final acceptance must include unchanged-state work budgets, original-source
preservation, interrupted recovery, authorization failures, Chromium/WebKit
behavior and exact deployed-state verification. Keep each claim tied to its
named scenario and exact tested release artifact.

## Final CI repair evidence

The first hosted matrix is retained at [run 38790475721](https://github.com/bobishh/tincanban/actions/runs/38790475721).
It exposed a lost delegated-controller certificate projection, a cached rejected
private-preferences import, stale acceptance-fixture assumptions and a slow
Native historical-parent query. Focused fixes retain the original authority,
revocation, 200ms interaction and full attachment-byte assertions. Cross-device
WebKit archive scenarios run on macOS; Linux WebKit UI coverage remains enabled.

After rebuilding the actual WASM, the 20,001-change / 80-proof browser scenario
completed in 10.6 seconds instead of 42.8 seconds, with controls opening in 68ms
(`/tmp/coreperf-worker-optimized-20261015`). The final move/pending-save/footer
batch passed (`/tmp/coreperf-final-after-native-20261015`), including a 168ms
longest task at 4x CPU. Native core passed 313 cases with three existing ignored
cases; immutable-source and entity-map rebinding negatives remain covered. These
are local repair proofs; final hosted and production cohort verification remain
independent completion requirements.


The next hosted matrix, [run 38795728593](https://github.com/bobishh/tincanban/actions/runs/38795728593),
exposed an additional historical-document materialization in local signing and a
browser-cached failed preference-module fetch. Local command signing now reuses
its immutable input only after matching the exact signed change dependencies;
the private preference adapter is bundled with the already-lazy mesh module.
Focused move verification measured a 62ms longest task at 4x CPU
(`/tmp/tincanban-final-basis-move-proof`), with the 200ms gate unchanged. The
original offline-owner reconnect scenario passed in 8.7 seconds
(`/tmp/tincanban-scoped-reconnect-static-loader`). The source/credential, signer,
revocation and subsequent causal admission checks remain required.

That matrix also exposed acceptance synchronization gaps: optimistic chat text
was mistaken for a completed local save, and several eventual Rusty/enrollment,
coverage and archived-restore states used an incidental five-second assertion.
Focused reruns retain exact completed-state, full attachment bytes and restored
original-content assertions. The two-generation owner-closed restore passed in
41.2 seconds (`/tmp/tincanban-final-two-generation-restore-proof`); cold WebKit
attachment coverage and download passed in 21.1 seconds
(`/tmp/tincanban-ci-cold-coverage-fixed-results`). External-service scenarios now
run in projects that install their actual Rusty/Worker dependencies. These are
repair proofs, independent from the final main CI and production activation.


WebKit backup profiling found 21,571 scope-authority validations taking 7,072ms
inside a 15.19-second backup interval. The shared Native verifier now keeps a
512-entry, per-thread cache of successful Ed25519 relations, keyed by the exact
public key, signature and domain-separated signed bytes. It does not cache
identity, authority, revocation, expiry or scope decisions. Forged inputs, error
behavior, bounded eviction and a changed signer identifier remain tested; the
full core suite passed 316 cases with three existing ignored cases. Both actual
WASM artifacts were rebuilt and their API check passed.

The same isolated WebKit scenario on those WASM artifacts made 21,477 validations
in 3,096ms; backup completed in 11.78 seconds and the full two-generation scenario
passed in 37.5 seconds, recorded in the task execution output. Temporary
profiling code was removed. Cold photo/name delivery with the source closed,
private connection transfer with local progress retained, incompatible-component
rejection, and other-person credential isolation passed through actual browser
flows. The application-source binding suite passed all five retained-event
cases (`/tmp/tincanban-app-source-binding-final`).

The main matrix [38800806638](https://github.com/bobishh/tincanban/actions/runs/38800806638)
passed the complete-device transfer scenarios but exposed a shared attachment
deadline: reconnecting consumed eight to nine seconds of the same ten-second
budget needed to transfer the file. A deterministic late-session regression
reproduces the exhausted budget. Recovery attempts may begin within ten seconds.
Each attempt has a ten-second setup allowance plus two seconds for each
additional sequential SDK chunk; a four-chunk file gets sixteen seconds. The
overall network deadline is recovery plus one attempt budget, at most 82 seconds
for the existing 8 MiB file limit. Expiry is checked before caching and returning
bytes, with authority revalidated around asynchronous operations. The isolated
reconnect/preview/full-download WebKit scenario passed in
20.3 seconds; exact preview and downloaded-byte assertions remain unchanged.

That matrix's production-packaging job exhausted its ten-minute job allowance
after sixty of eighty passing mobile WebKit cases. Its job allowance is twenty
minutes; scenario counts and interaction limits remain unchanged. Address-only
Rusty connection acceptance now waits for the board's completed sync state after
discovery, preserving the same exact-state assertion. These repairs require a
new successful main matrix before production activation.

Backup profiling on that failure path isolated 87 sequential peer object reads
taking 18.656 seconds of a 21.027-second export; encrypting 89 records took 38ms.
Live signing, journal-revision and private-preference guards together took about
two seconds, so their validation remains intact. Known leaf objects now load in
batches of at most four with at most 2 MiB reserved for read-ahead. Responses are
copied before asynchronous host guards, hash-checked and consumed in the original
canonical order. Missing objects, changed authority, mutable source buffers and
exact request bindings remain covered by focused negative tests.

The same hosted WebKit job also recorded a Native WASM capacity-overflow trap
during history preparation. Isolated repetitions have not reproduced it; no SDK
fix is claimed for that observation. The acceptance fixture now retains its
bounded synthetic Native source input on such a trap, excluding signer seeds,
so a recurrence can be reproduced independently of the browser. A final main
pass remains required for the complete recovery scenarios.

The subsequent main matrix [38806531629](https://github.com/bobishh/tincanban/actions/runs/38806531629)
found a zero-argument mock signature mismatch in the new deadline regression;
the corrected mock passes type checking. Its Rusty lifecycle traces also showed
pending connection/removal work continuing through successful server responses
after incidental five-second assertions expired. Those assertions now await the
workspace's exact completed state within thirty seconds, including the durable
server-revocation check. The two affected isolated scenarios passed together in
21.9 seconds. Product interaction budgets and runtime code are unchanged by this
acceptance-only repair.

That matrix also exposed a completion-message race: after a successful storage
checkpoint, ordinary background polling replaced the shared status message.
History completion now has independent workspace-scoped state, cleared before
the next accepted archive operation and on identity reset. Pending operations
cannot inherit the previous success; other boards cannot display it.

Full private-backup acceptance allows sixty seconds for the whole archive
download, consistently with the two-generation scenario. The failed hosted
traces showed continued transport work without a backup error; relay pings were
286–366ms to the US and 737–820ms to Europe. This bound does not change product
interaction limits, application I/O deadlines, complete-coverage verification,
offline restoration or missing-object assertions. The four-chunk reconnect
regression separately verifies that progressive transfers can complete after a
late replacement session under the size-aware network deadline.

The final two-generation device scenario then exposed a Native handle ownership
race: cache replacement freed a baseline wrapper still borrowed by an operation
across an await. A deterministic storage regression reproduces the null-pointer
failure. Cache replacement, eviction and identity changes now drop only their
cache reference; generated wasm-bindgen finalization releases an unreachable
wrapper after its borrowers finish. The cache retains at most eight entries,
identity changes still invalidate new lookups, and live authority guards remain
required. Independently owned temporary verification handles still use explicit
release. This fix does not establish the cause of the earlier unreproduced WASM
capacity-overflow observation.

After these fixes, isolated WebKit completed credential-free backup and offline
restore, including unavailable-object and capacity failures. The complete
two-generation enrollment/owner-closed original-version restore passed in 35.9
seconds (`/tmp/tincanban-final-history-borrow-fixed.log`). Exact hosted CI and
deployed-cohort verification remain required independently of those local proofs.

Main matrix [38810841545](https://github.com/bobishh/tincanban/actions/runs/38810841545)
exposed a test-clock race in the four-chunk regression: one twelve-second fake
advance could finish before real WebCrypto authority checks scheduled the next
chunk timer. The test now advances one chunk at a time and awaits each authority
check. All 22 attachment unit tests pass with V8 coverage; transfer deadlines and
live signature checks are unchanged. That matrix also found a Worker WASM memory
budget failure and a two-generation backup download timeout. All other groups,
including the full WebKit archive/recovery group, passed; this matrix did not.

The 312k-operation Worker case measured policy-WASM linear-memory high-water at
71,237,632 bytes in CI and 47,513,600 bytes against the exact captured artifact
locally. Linear memory includes unused allocator pages; the near 1.5 ratio suggests
reserve growth, without proving the allocator cause. The case now also repeats
activation and checks growth stays within 8 MiB. Its component ceiling is 80 MiB,
reserving 48 MiB beneath the Worker's unchanged 128 MiB isolate limit. This is a
policy-WASM budget, not a measurement of total isolate heap. Both full captured
runtime execution and the focused case pass locally; no production memory limit
or admission rule was changed.

The two-generation Chromium trace contained no archive HTTP requests because the
Owner reads its locally retained encrypted objects. An isolated phase profile
found 3,528 live guards during an 8.23-second backup; signing consumed 5.51 seconds,
private preferences 1.45 seconds and encrypted writing only 33 ms. Signing and role
derivation redundantly read the same initial authority. Role derivation now reuses
that guard's already validated authority while retaining its separate post-policy
fingerprint read. There is no authority cache across guards. Regression coverage
checks the two remaining reads, changed fingerprints and signed device revocation.
The same profile then measured signing at 3.93 seconds and backup at 6.65 seconds;
the sixty-second hosted acceptance bound remains unchanged.
After temporary probes were removed, the exact Chromium two-generation scenario
passed in 27.3 seconds, including complete backup, phone inspection and restoration
of an original version after closing the Owner device. Final source quality and
Worker type checks pass. A new exact main matrix and production cohort proof are
still required.

Matrix [38812993919](https://github.com/bobishh/tincanban/actions/runs/38812993919)
passed captured Worker runtime and the previously failing Chromium two-generation
backup. Its full unit coverage run still timed out in the four-chunk test: stepping
fake timers per chunk had not eliminated mixing real host I/O with virtual timers.
That test now advances only its deadline clock; explicit request/chunk gates drive
progress while WebCrypto, IndexedDB and session monitoring keep real host tasks.
All deadline and exact cache-write assertions remain. The 22 attachment tests pass
with coverage against this correction; production transfer behavior is unchanged.

Matrix [38813996535](https://github.com/bobishh/tincanban/actions/runs/38813996535)
still hit that integration fixture's outer timeout. Deadline regression now runs
directly against `fetchBlobFromCurrentSessions` with pure authority/signer ports;
it starts no mesh runtime or IndexedDB work. The other 21 mesh integration cases
retain real certificate, signing and revocation checks. The isolated deadline case
rejects the old ten-second attempt budget and passes the current four-chunk
transfer, with bounded retry timing and exact cached bytes. Combined focused
coverage still runs all 22 tests; final source quality passes.

That matrix's legacy-application mail fixture also sent mail before uploading its
locally created card. Worker correctly reported no matching application. The
fixture now explicitly syncs before mail submission; its unchanged missing-source
and unchanged-Applied assertions pass in the isolated browser case. No matcher,
review reason or production code was changed by either acceptance repair.

The isolated case also exposed assertion overhead: generic deep equality over
960,000-byte typed arrays took about 1.5 seconds locally. Keeping the same full
byte comparisons through native `Buffer.equals` reduces the case to 4 ms. Cache
descriptor equality and exactly one write remain asserted separately. No byte
sampling, shorter attachment or larger outer timeout replaces the original proof.
