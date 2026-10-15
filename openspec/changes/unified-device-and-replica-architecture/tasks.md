## Review checkpoint authorization — 2026-10-15

The user requested a committed checkpoint and CI review before the full
implementation is complete. This supersedes the earlier no-intermediate-commit
and no-CI/browser-execution timing rule for review runs on separate branches.
The checkpoint includes current authorized application changes across tincanban,
meta-mesh and Rusty. Draft pull requests may run their complete CI suites; this is
not the final implementation gate, production deployment or proof that any of the
nine architecture requirements is complete. Local browser verification remains
deferred. Production branches and deployment conditions remain unchanged.

The review cohort pins SDK `d19470dee8c4554cdf0c80ef7848b7d67f5efa1d` and
Rusty `5238a1bcc94bec99583c86710d6242cec306551d`. Rusty retains its independent
existing exact core dependency revision; this checkpoint does not assert the
final compatible-release manifest. CI now builds the Native archive verifier
from the SDK gitlink and runs the eight real HTTP client cases against the pinned
Rusty, in addition to the existing suites. Final local rechecks passed: Native
core 290 / 3 ignored, actual policy WASM interoperability 6, Native HTTP 8, and
production build/size. The policy WASM is 5,656,378 bytes (Brotli 1,185,652;
SHA-256 `cbd0e019a989151c43bab8260c6f6fdf6295b199f33f2fbc2a899327f324307d`).
Evidence: `/tmp/tincanban-native-baseline-core-all-final.log`,
`/tmp/tincanban-history-control-wasm-green-final.log`,
`/tmp/tincanban-native-baseline-http-all-final.log`,
`/tmp/tincanban-native-baseline-root-size-final.log`.

## 0. Specification and Baseline

- [x] 0.1 Record all nine findings, current evidence and target boundaries.
- [x] 0.2 Specify migration, trust, archive, failure and release semantics.
- [x] 0.3 Write Given/When/Then acceptance scenarios for every area and the final gate.
- [x] 0.4 Create an active goal covering the entire implementation and final CI deployment.
- [x] 0.5 Map every acceptance scenario to a concrete test/verification artifact.
- [x] 0.6 Inventory affected source paths, actual storage/protocol versions and rollback readers in all repositories.

## 1. Complete Device State

- [x] 1.1 Author outer acceptance tests for post-enrollment connection, profile delivery and unsupported schemas; do not execute E2E yet.
- [x] 1.2 Prove failing codec/manifest tests for omitted components, private-state leakage and device-local cursor transfer.
- [ ] 1.3 Implement one versioned manifest/codec used by enrollment and ongoing same-person synchronization.
- [ ] 1.4 Implement safe legacy migration, recovery-package/key-holder import and idempotent restart recovery.
- [ ] 1.5 Remove obsolete parallel field-copy code; run focused non-E2E privacy/merge/schema tests.
- [ ] 1.6 Verify complete owner-capability compatibility and cold-device browser delivery. Ordinary scheduling and person-policy bootstrap have focused native/client evidence; browser and older-reader acceptance remain open.

## 2. Explicit Rusty Authority

- [x] 2.1 Author equal-rights, unrelated-chain, first-scope creation after person migration, global revocation, pending recovery and restart/pin-integrity scenarios.
- [x] 2.2 Prove failing Rust/service/policy tests for authority independent of certificate ancestry.
- [ ] 2.3 Implement explicit scope-management capability and monotonic revocation in client, policy and Rusty.
- [ ] 2.4 Migrate legacy controller pins through confirmed owner-policy updates without changing scopes or service pins.
- [ ] 2.5 Remove ancestry-based management decisions and primary-device certificate repair after migration coverage exists.
- [ ] 2.6 Verify scope boundaries, future-content key rotation and negative signature/replay cases without E2E.
- [x] 2.7 Implement distinct root-person policy capability and first-resource creation bound to its exact signed revision.
- [ ] 2.8 Enforce current person policy across resource management, status, publication, checkpoint and enrollment; preserve authenticated exact-retry recovery and signed audit evidence across restart.

Evidence for 2.1/2.2/2.7: the four new Requirement 2 scenarios map to concrete
person-policy HTTP and client cases. The initial five Rust cases failed on the
unsupported person endpoint (HTTP 400); initial client cases omitted the signed
parent revision and attempted network delivery from a locally revoked device.
Current `cargo test --locked` passes 58 cases, including six person-policy cases.
The actual-client native HTTP test restarts the same service volume/origin with
empty controller pins, then a distinct root-issued same-person device without the
root private key reads approved person policy, creates a new scope policy and
enrolls storage. All three native cases pass. This completes the new capability
and first-resource binding task only. Product revocation/migration, future-content
key/token rotation and final browser/rollback/release requirements remain open.

## 3. Verified Signing Context

- [x] 3.1 Prove failing missing-chain, stale-context and scope/purpose-substitution tests.
- [ ] 3.2 Implement a shared context resolver with complete validated evidence and current authority revision.
- [ ] 3.3 Migrate genesis, commands, chat, enrollment, publication, checkpoints and owner requests to that API.
- [ ] 3.4 Preserve immutable historical verification evidence and explicit expiry/revocation behavior.
- [ ] 3.5 Eliminate new bare-key/leaf-only signing assembly; verify each caller and invalidation path.

### Scope, enrollment and private-state signing increment — 2026-10-15

- `workspaceSigning.ts` composes the durable local key/profile guard with actual
  current Native scope authority. Genesis/change producers reject revoked grants,
  device revocation, conflicts, failed reads and swapped host contexts. Tests use
  real IndexedDB evidence and compiled Native policy, including revocation during
  crypto. A ninth positive test uses actual default browser identity adoption and
  genesis without an identity private key, retaining its complete issuer chain.
  Access checks for an ordinary single-head write use the admitted dependency
  view; existing incremental performance assertions pass. Scope signing loads
  lazily, retaining the startup budget. This supersedes the cached-scope-helper
  limitation recorded in the previous increment.
- Enrollment request and device-certificate approval use verified local contexts;
  the latter binds recipient device/key and verified issuer evidence separately.
  A default-path positive test with an isolated recipient first reproduced an
  incorrect issuer/recipient scope binding and now passes. Approval now uses one
  synchronous final stored-record/fingerprint/claim/status/expiry comparison and
  consume. Two deterministic race tests reproduced successful approval after
  cancellation/replacement at the final async boundary; both now reject without
  overwriting the newer invitation. The three focused enrollment files pass 34
  cases. The invitation store itself remains in-memory.
- Same-person private-state export captures the author, uses the durable local
  signer/session guard, and acquires shared metadata before signing. Three red
  cases reproduced stale saved-key export, key replacement during crypto, and
  identity replacement while reading shared metadata. All reject without an
  emitted packet; a delegated-device positive case verifies the complete chain.
  Preference/delegation/transfer files pass 18 cases.
- Legacy Keeper control requests use verified local signing under their unchanged
  protocol/domain, explicit service/controller/operation/time bindings and correctly
  converted expiry. Six red cases covered bad/stale keys, missing ancestors,
  mutable inputs and expiry/key replacement during crypto. Focused Keeper files
  pass 73 cases, including actual enrolled-device full-chain requests.
- Generic grants, legacy certificate repair, ownership/control and remaining SDK
  raw-key producers still need migration. Final publication/journal boundaries,
  browser reload, migration/recovery, history archives and release remain open.
  None of tasks 3.2–3.5 or the final implementation gate is marked complete.

## 4. Atomic Private State

- [x] 4.1 Prove failing crash-boundary, skewed-clock, remove/update and credential-rotation tests.
- [x] 4.2 Implement one transactional preference source with logical revisions and separate device progress.
- [ ] 4.3 Implement remove dominance, explicit causal re-add, credential conflicts and safe tombstone retention.
- [ ] 4.4 Implement transactional migration from both legacy keys and verified restart recovery.
- [ ] 4.5 Remove duplicate effective-config persistence and wall-clock precedence; run repository contract checks.

## 5. Shared Replica Engine

- [ ] 5.1 Write one host-independent replica contract suite, with failing no-op/cursor/outbox/receipt tests.
- [ ] 5.2 Extract protocol state machine and explicit browser/Worker repository, signer, transport and scheduler adapters.
- [ ] 5.3 Implement revision-first no-op checks, bounded delta/baseline transfers and durable exact-ciphertext retries.
- [ ] 5.4 Integrate shared command/admission core while preserving automation's exact restricted grants.
- [ ] 5.5 Remove duplicate browser/Worker orchestration and obsolete cache bypasses.
- [ ] 5.6 Verify unchanged polls perform zero historical payload serialization/hashing and no new uploads on both hosts.

## 6. History Baselines and Archive

- [ ] 6.1 Specify concrete wire types, policy transition, archive manifests/indexes, budgets and compatible-reader rules.
- [ ] 6.2 Add failing Rust policy tests for forged baselines, owner/grant changes, invalid-history laundering and stale epochs.
- [ ] 6.3 Implement explicit owner-authorized baseline transition and receiver validation; document bootstrap trust and attack cases.
- [ ] 6.4 Implement immutable authenticated archive segments, lazy historical reads and preserved original signatures/classifications.
- [ ] 6.5 Implement archive coverage receipts, pre-compaction recovery, atomic activation and crash recovery.
- [ ] 6.6 Integrate fresh-command history restore and complete/incomplete recovery bundle export.
- [ ] 6.7 Verify 1k/10k/100k equal-state histories have bounded active tails and history-independent ordinary-write/no-op operation counts.
- [ ] 6.8 Verify quota/pending/quarantine/old-client failure states without deleting historical data.

Partial implementation evidence: `historyArchive.ts` and `historyArchiveStore.ts`
provide bounded content-addressed pages/parts and guarded immutable local storage;
`historyArchiveCrypto.ts` and `history_archive_crypto.rs` implement the scoped
AES-GCM envelope with a shared browser/native fixture; native
`history_preparation.rs` runs causal admission and produces a private
`VerifiedHistoryPreparation` token. Rusty stores opaque archive ciphertext and
issues signed leaf receipts plus aggregate receipts. The shared SDK
`historyArchiveCoverageSet.ts` constructs bounded coverage trees and verifies the
signed root against the entire ordered caller-provided set; a signed subset fails
even if it covers the root object. Shared scope quota includes archive bytes in
upload, checkpoint retained-capacity and scratch accounting.

The durable `historyPreparationJournal.ts` now implements `captured`, `archived`
and `covered`. Capture retains exact caller-provided source bytes privately. The
canonical state header stays at most 16 KiB. Each append atomically CASes four
records (head, binding lookup, prepared ciphertext object and ordinal reference),
retaining request ID and previous-record digest. Freeze verifies retained source,
append chain and object hash chain, then derives coverage from bounded sorted pages
of 64. Coverage checks each signed storage receipt and the final aggregate against
that complete set. The 16-case SDK `historyPreparationJournal.test.ts` covers
reopen, races, lost replies, bounded ordering and invalid evidence. Stage and
coverage retries reopen persisted ciphertext/receipts
after lost commit replies and do not reseal already staged objects. No deletion API
exists.

`src/sync/historyPreparationRepository.ts` adapts the journal to a separate private
IndexedDB database. The real native HTTP archive case now uses that repository,
reopens it through a fresh IndexedDB handle after Rusty restart, and forbids
`crypto.subtle.encrypt` during resume. The Worker Durable Object adapter encrypts
each SQL value with context/key-bound AES-GCM AAD, checks raw ciphertext and guard
inside `transactionSync`, syncs commits, and scans bounded SQL key pages while
decrypting one value at a time. Workerd storage tests cover phase resume, a CAS
winner, rollback on an injected second write, ciphertext-only storage and
scope/context/secret substitution. The Worker adapter is not connected to
`AutomationReplica`.

The journal's ordinary host API remains caller-fed. Native
`VerifiedHistoryArchiveCapture` now consumes `VerifiedHistoryPreparation`, retains
validated original JSON and emits a source-derived catalogue; cross-runtime and
native HTTP vectors bridge the two layers in tests. A live WASM capture handle and
ordinary host/Worker producer integration remain absent. First-use Rusty byte/count accounting still
scans the archive directory; a durable bounded restart index remains open. Ordinary
host scheduling, signed Owner transition, active-pointer atomic activation,
restore/export and history-size bounding remain unimplemented. Requirement 6 tasks
remain unchecked; this increment covers repository phases, not the full 6.5
recovery/activation contract.

### Portable cold archive and Native correspondence increment — 2026-10-15

- Closed a demonstrated architectural gap: randomized archive ciphertext IDs were
  reachable only through a sender-local flat locator list. The portable encrypted
  directory now carries authenticated plaintext/ciphertext child hashes and
  bounded sorted binding-hash leaves. Cold readers need its root, key and remote
  storage access, not the sender journal.
- Added a distinct durable directory preparation after data coverage, bound to
  the same source, authority, private configuration, previous baseline, service,
  scope, policy and key. Its own objects never enter the data set it indexes.
  The two new acceptance cases first failed on the helper stub. A 73-object test
  now resumes a three-page directory after a lost upload reply with encryption
  disabled; input/guard adversarial tests preserve prior storage.
- The Native HTTP acceptance now covers both sets, restarts Rusty at the same
  origin, disables all sender-journal read methods, then recovers exact original
  control/proof/pending bytes and verifies the retained signature/change hash.
  Workerd executes the same helper through encrypted Durable Object storage,
  including lost-response recovery and sender-free cold reads.
- Added strict Native locator decoding and the shared encrypted browser fixture.
  Review found an unchecked sum of attacker-supplied child counts; a red test
  reproduced overflow, and validation plus checked addition now reject it.
- Added `VerifiedHistoryArchiveCapture::verify_storage_directory`. Its positive
  acceptance first failed on the stub. It regenerates Native objects, traverses
  authenticated directory paths, opens ciphertext and compares exact original
  bytes. Unique generated bindings must equal the directory count. The private,
  non-deserializable evidence token retains both roots, scope/key digest and exact
  sorted ciphertext sets; it supplies no receipt or activation authority.
- Correspondence tests cover a real two-leaf/one-branch directory, missing/corrupt
  bytes, an extra authenticated entry, scope/index/epoch substitution and revocation
  during download. The binding hash agrees with the shared JavaScript fixture.
  The verifier and its retained sets can scale with preparation history; this is
  not a bounded ordinary-write path or an active-history bound.
- Verified: SDK 49 files / 518 tests and types; Native core 258 passed / 3 ignored;
  Native HTTP 8/8; Workerd 10 files / 125 tests; app/Worker types, focused app lint,
  targeted Rust formatting and wasm32 policy compile. The locator fixture
  regenerates byte-identically. Existing negative Workerd RPC cases still emit
  denial/replay diagnostics. Evidence: `/tmp/tincanban-history-locator-sdk-all-final.log`,
  `/tmp/tincanban-history-storage-core-all-final.log`,
  `/tmp/tincanban-history-locator-native-http.log`,
  `/tmp/tincanban-history-locator-workerd-all.log`,
  `/tmp/tincanban-history-storage-policy-check.log`.
- Still absent: Native verification of composite signed coverage, Owner transition
  and archived control/frontier validation, live WASM/ordinary producer integration,
  activation/recovery, per-entity historical UI, restore/export, bounded active-tail
  measurements and compatible coordinated rollout. Tasks 6.1–6.8 remain open.
  No E2E/browser verification, staging, commit, push or deployment occurred.

### Native composite archive coverage increment — 2026-10-15

- Added `history_archive_coverage.rs`: a bounded expected-set reducer and strict
  aggregate receipt verification under `RUSTY/2`. The reducer's positive browser
  vectors and 100,000-object case first failed on its stub; the composite positive
  acceptance independently failed on the verifier stub. Red logs:
  `/tmp/tincanban-native-coverage-reducer-red.log` and
  `/tmp/tincanban-native-composite-coverage-red.log`.
- `VerifiedHistoryArchiveStorage::verify_coverage` derives both expected sets from
  private Native correspondence evidence. It checks exact roots/summaries, pinned
  service/scope/policy, key epoch and distinct bounded preparation IDs against
  stable request hashes. Both receipts must verify; a valid signed subset with
  the catalogue root, wrong epoch, swapped receipt or replayed preparation fails.
- The private, non-deserializable coverage token retains Native catalogue/locator
  roots, source/authority revisions, key digest, both receipts and preparation IDs.
  Strict bounded schemas reject unknown/missing/duplicate fields and forged or
  noncanonical signatures. A failed check leaves storage evidence reusable.
- Shared deterministic SDK-signed vectors cover 1, 64, 65, 512, 513 and 4101
  objects, including unary tail promotion. Native checks every summary and service
  signature; the lazy 100,000-object derivation has height 4. Only current leaf and
  per-level branch buckets grow in the reducer. The underlying capture/expected
  sets still scale with original history; ordinary-write history bounds remain open.
- Added the bounded stdin example `history_archive_verify` for opt-in Native HTTP
  integration. That acceptance first failed on the adapter stub
  (`/tmp/tincanban-native-archive-coverage-http-red.log`). It now runs genuine Native
  preparation/capture/correspondence/coverage on exact original evidence, ciphertext
  fetched after Rusty restart and both actual service receipts. Swapping the
  directory receipt for the data receipt fails the exact Native preparation check.
  Serialized adapter output is test evidence only and cannot authorize activation.
- Verified: Native core 265 passed / 3 ignored, SDK 50 files / 519 tests and types,
  Native HTTP 8/8, app types/focused lint, targeted Rust formatting, wasm32 policy
  compilation and byte-identical fixture regeneration. Evidence:
  `/tmp/tincanban-native-archive-coverage-core-all.log`,
  `/tmp/tincanban-native-archive-coverage-sdk-all.log`,
  `/tmp/tincanban-native-archive-coverage-http-green.log`,
  `/tmp/tincanban-native-archive-coverage-http-final-focused.log`,
  `/tmp/tincanban-native-archive-coverage-policy-check.log`.
- This closes Native composite content/storage proof only. Signed Owner transition,
  archived control/frontier validation, live WASM/ordinary producers, activation,
  recovery/restore/export, measured bounded active history and coordinated release
  remain open. CI must build the new opt-in verifier alongside the final compatible
  pinned Rusty. Tasks 6.1–6.8 remain unchecked; no E2E/browser verification or VCS/
  deployment action ran.

### Admitted-state rebase and archive binding increment — 2026-10-15

- Added `history_rebase.rs` and its typed walker. The mixed-admission positive
  acceptance first failed on the stub. The copier reads only the private Native
  admitted projection, preserves known scalar/object types and current counter
  values, and emits one deterministic zero-time marked basis change, including
  empty state. A binary state digest is checked again after save/reload. It never
  assigns original authorship to its new operation IDs.
- Real signed histories of 1k, 10k and 100k edits to one field all produce the
  identical current-state digest, one basis change and a save below 2 KiB.
  Preparation/admission still reads full original history. This is not proof of
  bounded active-tail admission or history-independent ordinary writes/no-ops.
- Direct typed-state assertions cover map/table/list/text, Unicode, exact integer
  widths, negative zero, bytes, timestamps and incremented counters. Marked/block
  text and conflicts currently reject without changing the source. Future scalars
  reject before the unsupported save path; the guard first failed its focused
  test. Lossless support for these states remains required by the full contract.
- Added private `VerifiedHistoryBasisArchive`: exact Native capture, rebase and
  composite coverage must agree on source/authority/capture revisions, workspace,
  epoch and data preparation ID. The positive acceptance first failed on its stub
  (`/tmp/tincanban-history-basis-join-red.log`). Equal state from different evidence,
  whitespace-changed exact originals, another epoch or transition rejects without
  consuming valid tokens. A red case then reproduced another authorized Owner
  device substituting its basis; the join now binds the complete normalized
  signer evidence (`/tmp/tincanban-history-basis-signer-red.log`).
- The non-browser Native HTTP acceptance first failed against the prior verifier
  output (`/tmp/tincanban-history-basis-native-http-red.log`). After Rusty restart
  and with sender-journal reads forbidden, the adapter now derives the admitted
  basis and joins it to exact downloaded originals and both actual service
  receipts. The test checks one change, a below-2-KiB basis and a fixed independently
  encoded typed-state digest. The serialized summary remains test evidence only.
- Native core passes 276 cases / 3 ignored
  (`/tmp/tincanban-history-rebase-core-all-final.log`); the current Native integration
  adapter builds. Native HTTP passes 8/8
  (`/tmp/tincanban-history-rebase-native-http-all-final.log`); wasm32 policy compile
  passes (`/tmp/tincanban-history-rebase-policy-check.log`). App types, changed-file
  lint and targeted Rust formatting pass.
  The full history/baseline gate remains open: signed Owner transition,
  archived control/frontier receiver validation, live WASM/ordinary producers,
  activation/recovery/restore/export and bounded active-tail operation counts are
  still absent. Tasks 6.1–6.8 remain unchecked. No browser/E2E or VCS/deployment
  action ran.

### Native Owner attestation and causal control boundary increment — 2026-10-15

- Added the exact `workspace-history-baseline@1` payload, private Native signing
  proposal and signature-confirmation token. The positive acceptance first failed
  on the proposal stub (`/tmp/tincanban-native-baseline-red.log`). The payload binds
  raw/admitted frontiers, policy/source/authority, preparing device/full chain,
  basis/state hashes, catalogue/locator roots and both exact signed storage
  receipts. Its ID hashes canonical payload without only `baselineId`.
- Confirmation checks the current complete source revision, exact proposal,
  distinct `MESH-HISTORY/1` domain and canonical signature. Duplicate, unknown or
  omitted nested JSON fields cannot disappear through typed parsing. Tests cover
  re-signed state/archive/frontier/epoch/parent/receipt substitutions, wrong keys
  and domains, unsigned certificate-field injection, missing explicit null,
  whitespace-preserving evidence, clock-only metadata and reusable valid retry.
- Successors require a private verified parent, consecutive history epoch,
  admitted parent basis and retained signed control records/genesis identity.
  Four lineage tests cover a valid successor, skipped/replayed/unrelated basis,
  omitted known revocation and an actual ownership transfer followed by a
  delegated new-Owner signer with its complete two-certificate chain. These
  fixtures use explicit Owner proofs for their newly authored basis operations;
  they do not implement or bypass production network-baseline admission.
- The control audit reproduced two real defects: a valid earlier Owner device
  removal failed after transfer, while an earlier Owner could issue a person
  removal against a later frontier. Red evidence:
  `/tmp/tincanban-native-historical-control-red.log`. The Native authority context
  now checks historical Owner control against the exact outgoing causal frontier;
  separate self-device removal remains valid. Temporary first-pass history-sized
  frontier maps are released before the final retained map is built.
- Those changed results now identify `mesh-causal-admission@2`; source preparation
  revisions also bind the length-delimited policy ID. A red test reproduced equal
  revisions across distinct policies (`/tmp/tincanban-native-baseline-policy-revision-red.log`).
  The shared capture fixture was regenerated after asserting every original byte
  and expected hash/classification remained unchanged. Earlier `@1` observations
  are not reclassified or relabeled in place.
- Native-generated deterministic `history-control-v2.json` supplies five actual
  signed control cases to the SDK. The packaged WASM reproduced both Native bugs
  (`/tmp/tincanban-history-control-wasm-red.log`). The rebuilt policy exports its
  actual `causalAdmissionPolicyId`; the six interop cases and full SDK pass.
  The policy artifact was rebuilt; transport artifacts and coordinated release
  remain in the final cohort gate. No new network-baseline capability is enabled.
- The real Native HTTP acceptance now requests a proposal after cold ciphertext
  recovery and Rusty restart, signs it with the JavaScript identity SDK and sends
  only the signed envelope back for Native confirmation. A wrong-domain signature
  rejects. The prior adapter failed this new request first
  (`/tmp/tincanban-native-baseline-http-red.log`). All eight Native HTTP cases pass
  (`/tmp/tincanban-native-baseline-http-all.log`). Adapter JSON is test evidence,
  never an authority token or active baseline.
- Current checks: app 287 files / 2,912 tests, one opt-in file / two cases skipped;
  SDK 51 files / 525 tests plus types; Workerd 10 files / 125 tests plus types;
  six-category app quality and production build/size checks. Evidence:
  `/tmp/tincanban-history-control-root-all.log`,
  `/tmp/tincanban-history-control-sdk-all-final.log`,
  `/tmp/tincanban-history-control-worker-runtime.log`,
  `/tmp/tincanban-native-baseline-root-quality.log`,
  `/tmp/tincanban-native-baseline-root-size.log`.
  Negative Workerd RPC cases still emit rejection/replay diagnostics; these
  passing assertions do not claim clean runtime logs.
- Still open: cold receiver archived-control/frontier proof, live WASM preparation
  handles and actual platform signing producers, durable private/pin guards,
  authorized journal phase, atomic activation/recovery, lossless conflicted/rich
  state copying, per-entity history UI, restore/export and bounded ordinary-tail
  operation counts. All 6.1–6.8 remain unchecked. Browser/E2E, staging, commits,
  push, deployment and full-goal completion remain unperformed.

Evidence recorded for the preparation-journal increment: root 281 files / 2,883 tests, with
one opt-in file and two cases skipped (`/tmp/tincanban-history-preparation-final-root-all.log`);
SDK 45 files / 496 tests (`/tmp/tincanban-history-preparation-final-sdk-all.log`);
all 7 native HTTP client cases passed
(`/tmp/tincanban-history-preparation-native-all.log`); Workerd 10 files / 125 tests
passed (`/tmp/tincanban-history-preparation-workerd-all.log`), including 3 preparation
cases. Root six-category quality, SDK/Worker types and app build/size checks pass.
Private JS is 234.98/239 kB and CSS 10.74/10.75 kB; public JS is 61.07/235 kB and
CSS 10.6/10.6 kB. Existing negative Workerd RPC cases emit denial/replay exception
diagnostics; these passing assertions do not establish clean runtime logs.
These results do not establish browser acceptance, native baseline activation,
ordinary scheduling or rollout.

## 7. Encrypted Attachments and Lifecycle

- [x] 7.1 Author closed-source/mobile preview/download and session-replacement E2E scenarios without executing them. `e2e/attachments-rusty.spec.ts` covers a source-closed mobile recipient preview/download; `e2e/attachment-session-recovery.spec.ts` gates an active read, closes the connection, and checks full recovery without partial-cache publication. Both remain browser-unrun; this closes authorship only.
- [ ] 7.2 Add failing protocol/repository tests for resumable chunks, missing bytes, substitution, revocation and lost receipts.
- [ ] 7.3 Implement purpose/scope/epoch-bound encrypted chunks and private opaque addressing in client/shared core/Rusty.
- [ ] 7.4 Implement durable attachment manifests, independent coverage, streaming and resumable retry.
- [ ] 7.5 Implement session-generation invalidation, current-path reacquisition and authorized Rusty fallback.
- [ ] 7.6 Verify blind server restart/log/storage sentinels and distinct product failure states with non-E2E tests.
- [x] 7.7 Coordinate an existing automation Worker's signed policy-revision refresh with writer-floor migration while preserving grant rights/expiry, control state, pending ciphertext, deduplication and cursor. Implementation/non-browser proof only; final browser/cohort verification remains in the release gate.

### Isolated Rusty attachment storage increment — 2026-10-15

- Authored `e2e/attachments-rusty.spec.ts` and isolated Chromium/WebKit projects,
  without execution: recipient confirms portable Rusty access, has no local file
  bytes, source observes explicit receipt-backed coverage and closes, recipient
  previews/downloads exact original bytes. The coverage UI and client transfer are
  still planned. The session-replacement browser case remains unauthored because
  no deterministic supported attachment-transfer/session gate exists yet.
- A native HTTP acceptance test first failed on the absent blob endpoint (404).
  Rusty now provides separate `/blobs/{ciphertextId}` reads/writes with independent
  signed blob receipts, strict opaque objects, bounded chunk size, existing scope
  tokens/revocation and durable exact retries. Objects never enter snapshot
  inventory or checkpoint deletion. Namespace creation and object commit are
  fsynced before a receipt. Successful responses prohibit caching.
- Snapshots and blobs share scope byte capacity; checkpoints account for retained
  blobs and scratch use. Native cases cover restart, denied upload, wrong scope,
  corruption, oversized ciphertext, fsync failure/retry without growth, shared
  quota and actual signed checkpoint preservation. All 64 Rust tests pass;
  formatting and required native binary build pass. This is server implementation
  only: encrypted client manifest/chunk codecs, durable transfer state, scheduling,
  authorized fallback, session recovery, coverage UI and sentinel/log inspection
  remain open. Requirement 7 and tasks 7.1–7.6 remain incomplete.
- Current aggregate: root logic passes 243 files / 2,473 cases (one opt-in file,
  two cases skipped); full root quality passes types, lint, unused-code/dependency,
  duplication and pattern checks. Production budgets pass: private JS 238.95/239
  kB, private CSS 10.74/10.75 kB, public JS 61.07/235 kB, public CSS 10.6/10.6 kB,
  Markdown and all WASMs. Workerd passes eight files / 113 cases. Native Rusty HTTP
  app tests pass three cases against the rebuilt binary. No E2E/browser, staging,
  commit, push, deployment or goal completion occurred. All final gates stay open.

### Encrypted attachment client and index increment — 2026-10-15

- Added strict manifest/chunk codec, HTTP blob client and durable transfer engine.
  The codec verifies original source bytes, encrypts 256-KiB chunks with explicit
  scope/epoch/purpose/transfer/index/count AAD, strips direct-peer tickets and
  validates complete assembly against the original descriptor. Caller inputs are
  captured before crypto. Invalid locator requests are rejected before local or
  network object reads; this early-boundary test first failed before the fix.
- Transfer acceptance tests first failed at the unimplemented engine. Exact
  ciphertext and request IDs are committed before sending, chunks precede the
  manifest, and each receipt is verified. Lost replies resume without source bytes;
  interrupted downloads retain verified encrypted chunks and fetch missing ones.
  Forged receipts and a revoked supplied guard never produce a confirmed locator
  or complete file. Real product workspace-authority binding remains required.
- A no-op transfer test first found 11 ciphertext hashes after a completed upload.
  Verification is now retained for the exact progress record/credential binding;
  unchanged warm polls perform zero hashes/uploads, while changed/cold records
  reverify and live host guards still run. Six engine cases and eight repository
  cases pass after that fix; native restart retry now supplies no source bytes.
- The repository stores bounded progress separately from immutable ciphertext;
  metadata-only receipts do not rewrite chunks. Real independent IndexedDB handles
  prove one CAS winner and concurrent index union. Red cases reproduced receipt,
  transfer-plan and received-progress rewrites; those transitions now reject. A
  failure on the second queued IndexedDB write leaves both state and bytes absent.
- Browser snapshots and Worker activation/pull/push/pending retry/renewal/restart
  preserve the private immutable locator union. Omitted old indices cannot erase
  known local locators; conflicting transfers fail closed. A changed index advances
  content revision despite unchanged document heads. Sort order is ordinal, not
  locale-dependent. Browser index parsing/storage loads on demand; source-only
  board polls do not initialize a file-transfer journal.
- New native HTTP case runs the actual codec, journal and client against Rusty:
  lose the first confirmed reply, restart the same service, retry identical bytes
  and request, recover the file in an empty recipient repository without source
  callbacks, then reject a revoked cold reader. Every server file and captured
  output excludes plaintext sentinel/name/digest/key/tokens. Logging is disabled
  in this fixture; an enabled diagnostic-sink sentinel test remains required.
- Final full root run passed 250 files / 2,523 tests (one opt-in file/two cases skipped).
  After final lazy-loader changes, the three affected snapshot/adapter files pass
  23 tests. Root quality passes all six categories; final changed-file lint and
  dependency checks pass after the loader changes (662 modules/2,511 edges). Native app HTTP suite passes four
  cases; full Workerd suite passes eight files / 115 tests. Initial full Workerd
  run caught an agent-added describe wrapper hiding typedFixture; the wrapper was
  removed and all cases rerun. No skipped/reduced checks hid the failure.
- Build initially exceeded the unchanged startup budget. Attachment index loading
  moved behind its real replica-use boundary; final size is 238.90/239 kB private
  JS, 10.74/10.75 kB private CSS, 61.08/235 kB public JS, 10.6/10.6 kB public CSS.
  Markdown and all WASM limits pass. No budget increased.
- Still open: application upload scheduling, actual current workspace/device
  authority guards, Preview/Download fallback, direct-session replacement, truthful
  byte/metadata/admission coverage UI, streaming source/sink integration, enabled diagnostic privacy and writer/key
  migration. An older writer may discard the optional snapshot index and must be
  prevented from compacting it before release. History baselines/archives, the
  remaining signing/migration work and the full release cohort remain unfinished.
  No whole requirement, E2E gate or goal completion is claimed. No browser/E2E,
  stage, commit, push or deployment occurred.

### Attachment authorization, product reads and writer floor — 2026-10-15

- Replaced the no-op attachment host guard with a verified signer/current-authority
  composition. Initial tests reproduced four missing denials. Real-crypto and
  IndexedDB tests now cover actual Owner/Editor/Visitor/uninvited permission,
  signed device revocation, stored key replacement, connection deletion (including
  during an awaited document read), missing/changed references and duplicate
  content under different filenames. A connection-removal race and duplicate-name
  false denial were independently reproduced before their fixes.
- Connected normal attachment fetching to a guarded Rusty reader. Known private
  locators use the encrypted repository and transfer engine; offline storage can
  use the existing peer fallback. Access changes are terminal, peer bytes receive
  complete descriptor verification, and no partial file is returned. A peer-ticket
  change initially caused two redundant downloads; route tickets are now excluded
  from encrypted journal identity while remaining available to peer fallback.
  Controller tests prove identity/workspace switches cannot return old bytes.
- Extended the native HTTP attachment case to call this production adapter with
  actual workspace reference/config/index, source callbacks unavailable, exact
  returned bytes and a cold rejected read after server revocation. Existing
  restart/lost-reply/ciphertext/privacy checks remain. Four native app cases pass.
  The original guard-specific tests use real IndexedDB/native policy; native HTTP
  composition is separate evidence, not browser or enrollment acceptance.
- Added a signed monotonic scope writer floor with legacy disk default 1, strict
  version negotiation, v2 PUT query and signed checkpoint writer version. Old
  writers cannot append or prune an upgraded scope; blobs require the upgraded
  policy. Native restart/no-downgrade/checkpoint/old-writer tests pass. A real
  signed default-revocation receipt initially failed because active floor 2 was
  rejected; default requests now accept that supported active floor. Explicit
  upgrades still require signed confirmation of 2 and unknown values fail closed.
- Browser/Worker snapshot writes share v2 negotiation. Full Worker runtime passes
  115 cases; Rusty formatting and full Cargo suite pass 67 cases. The latest full
  final root aggregate passes 252 files / 2,561 cases (one opt-in file/two cases
  skipped). Full root quality passes all six categories; dependency checks cover
  670 modules/2,562 edges. Native app HTTP remains four passing cases.
- Direct-peer retrieval now pins its mesh run and original identity/credential,
  reacquires replacement sessions and rejects late replaced-session results.
  Signed local revocation, identity/secret/epoch change, stopped runtime and a
  runtime change during awaited cache write cannot return stale bytes. Twelve
  dedicated cases plus related mesh suites pass (79 focused cases). Review caught
  and reproduced an unintended active-workspace-set mutation and false authority
  changes from timestamp/certificate order; checks now use Native partitioning
  without changing active scopes and canonical rights with the transport secret
  and epoch retained. The cache has no rollback primitive: a change after its
  awaited write commits prevents return, but cannot erase already committed bytes.
  SDK `requestBlob` now has logical abort/deadline behavior around stream open,
  operations and verification, with per-chunk authority checks. The fetcher applies
  a ten-second overall deadline and polls identity/credential/session authority
  every 250 ms. Timeout or cancellation settles the caller and prevents partial
  bytes/cache writes; at this historical checkpoint, the transport still lacked
  stream read reset, so the underlying read could remain pending until peer
  activity or closure. The following per-stream cancellation increment resolves
  that transport limitation; browser/session-replacement acceptance stays open.
- Attachment index lookup now uses a tagged stable crypto-context binding
  (owner/workspace/origin/scope/epoch/service key/content key), independent of
  replaceable access tokens, policy/preference revisions and replica cursors.
  The old private-replica binding is read as a migration source and additively
  unioned into the new index; source bytes remain intact, and later legacy writes
  are imported by source revision. Repeated revision checks reuse the computed
  content revision while the exact raw record is unchanged; another repository's
  raw-record change invalidates the cache. This documentation follow-up reran
  four IndexedDB index/access/repository suites (37 tests), the vendored blob SDK
  suite (16) and the app's direct-peer blob suite (15); all passed. These focused checks do not imply
  browser acceptance, and no native HTTP run was repeated for this follow-up.
- The attachment access harness initially failed its new database-name assertion:
  static runtime imports selected the memory store before fake IndexedDB setup.
  Runtime imports now occur only after the fake database is installed. All 13
  access cases pass, and the assertion confirms `tincanban-local-state-v1` exists.
  The earlier access-test run is not IndexedDB evidence; only the corrected run is.
- File-transfer code, service capability parsing and configured-server setup/health
  orchestration load on demand. Startup size initially failed by up to 196 bytes;
  the final completed build is 238.89/239 kB private JS, 10.74/10.75 kB private CSS,
  61.08/235 kB public JS and 10.6/10.6 kB public CSS. Markdown/all WASM limits pass.
  No size limit changed. Diff checks pass across application, SDK and Rusty; staged
  diffs remain empty. This is non-E2E working-tree evidence, not the final gate.
- Still open: automatic source-file scheduling, explicit key/token migration when a
  pending outbox blocks writer upgrade, truthful byte/index/admission coverage UI, streaming integration,
  enabled diagnostic-sink privacy and final browser/session acceptance. History
  baselines/archives, remaining signer/migration work and coordinated releases are
  unfinished. No whole requirement or final gate is closed. No browser/E2E, stage,
  commit, push or deployment occurred.

### Archive index, encryption and native preparation foundations — 2026-10-15

- SDK immutable archive primitives now bound index pages to 64 KiB / 64 children,
  binary parts to 256 KiB, tree depth to 32 and keys to 512 UTF-8 bytes. Streaming
  builders publish only immutable objects; lazy readers authenticate the root,
  path metadata, exact part hashes and complete drained byte counts. Tests include
  1k/10k/100k index entries, not compacted Automerge histories. Arbitrary original
  proof bytes retain whitespace/extensions; a real restored device signature still
  verifies. Independent IndexedDB handles exercise guarded absent-value CAS,
  identical concurrent writers, lost commit replies and preserved corrupt records.
- Native page verification agrees with the shared multi-page Unicode fixture.
  One red case reproduced missing nullable range fields silently becoming null;
  the strict decoder now requires both fields. UTF-16 key ordering is shared
  explicitly rather than relying on Rust scalar ordering.
- AES-GCM archive envelopes bind purpose, scope/key epoch, workspace/history epoch,
  index, plaintext identity, kind and part position/count. Shared JS/Rust fixtures
  recover exact noncanonical proof bytes. Tests reject rehashed corruption, scope
  and part substitution, unknown schemas, noncanonical encodings, oversize input
  and valid producer ciphertext claiming a false plaintext identity. The codec is
  not a durable ciphertext retry journal or an archive coverage receipt.
- Native preparation first failed its five positive cases. It now runs actual
  causal admission and returns only a private non-deserializable preparation
  token. The token retains the typed proof evidence plus exact source document
  and pending bytes, derives the admitted projection, validates current-owner
  device evidence and rejects revocation/stale source changes. Its source revision
  excludes receiver clock metadata. Original proof JSON encoding still needs the
  binary archive integration; no signed baseline activation authority is issued.
- Current evidence: SDK 40 files / 442 tests, root 275 passing files / 2,827 tests
  (one opt-in file / two cases skipped), all six root quality categories and SDK
  type check pass. Full native workspace passes; core reports 232 passing / three
  ignored cases, with opt-in formal-model cases elsewhere also ignored. New native
  archive/preparation cases pass 20/20. Targeted Rust formatting passes.
- Rebuilt both WASMs before the combined build/budget check. Private JS is
  234.65/239 kB, CSS 10.74/10.75 kB, public JS 61.08/235 kB and CSS 10.6/10.6 kB.
  Transport WASM is raw 10,857,189 / Brotli 2,297,617 bytes against 2,300,000;
  policy WASM is raw 5,687,169 / Brotli 1,196,484 against 1,200,000. Logs:
  `/tmp/tincanban-archive-native-workspace.log`,
  `/tmp/tincanban-archive-sdk-all.log`, `/tmp/tincanban-archive-root-all.log`,
  `/tmp/tincanban-archive-root-quality.log`, `/tmp/tincanban-archive-root-size.log`
  and `/tmp/tincanban-archive-final-sdk-types.log`.
- Signed baseline wire/transition, archive record catalogue integration, original
  authority/frontier verification across rebasing, encrypted archive server
  namespace and aggregate coverage, durable preparation/activation/recovery,
  restore/export and bounded active-tail performance remain open. No archive
  capability, host activation, E2E/browser check, staging, commit, push or deployment
  occurred. All tasks 6.1–6.8 and the full nine-requirement goal remain open.

## 8. Application Source and Email Binding

- [x] 8.1 Author immutable-source, renamed-role, 404 and explicit-owner-binding acceptance scenarios without E2E execution.
- [ ] 8.2 Add failing source-record and signed-binding logic/runtime tests.
- [ ] 8.3 Implement stable application/source identity and immutable extracted posting/submission observations.
- [ ] 8.4 Capture original evidence independently of display labels and asynchronously from ordinary local moves.
- [ ] 8.5 Implement explicit retained-event application selection, signed binding, durable audit and retry.
- [ ] 8.6 Enforce classification, source/grant authorization, event identity and current causal workflow preconditions after binding.
- [ ] 8.7 Migrate legacy records without inventing historical evidence or editing the user's card labels.

## 9. Release Cohort

- [ ] 9.1 Define and validate one exact-artifact release manifest and component capability/version endpoints.
- [ ] 9.2 Implement CI artifact verification, staged compatible rollout, activation record and failure recovery.
- [ ] 9.3 Implement old-tab upgrade/read-only behavior, cache revalidation and truthful device acknowledgment states.
- [ ] 9.4 Verify migration and rollback-reader compatibility through non-E2E release fixtures.
- [ ] 9.5 Update architecture, operator/recovery instructions, Agent guide and test inventory from actual implementation.

## 10. Typography and Readability

- [ ] 10.1 Author the four typography Given/When/Then browser acceptance scenarios without executing them.
- [ ] 10.2 Inventory available licensed local font assets and Latin/Cyrillic coverage; record required additions without fetching runtime fonts.
- [ ] 10.3 Preserve all existing board/card/chrome styling; use Fira Sans only for detail descriptions/notes and discussion/chat prose, and Fira Code only for code and `settings.json`; define resilient system fallbacks.
- [ ] 10.4 Verify 74-card bilingual desktop/mobile layout, long details/chat/settings, blocked font behavior, 200% text zoom, reduced motion, and no clipping or lost UI.
- [ ] 10.5 Record font licenses and structural checks; do not claim coverage until the required browser scenarios pass in final verification.

## 11. Implementation Complete Gate — Required Before Final Release

- [ ] 11.1 All implementation and test-authoring tasks in sections 1–10 are complete; none is deferred behind a TODO, unsupported host or unverified migration. Browser execution tasks remain reserved for 12.1 and must pass before final completion.
- [ ] 11.2 All authored acceptance scenarios are mapped; every relevant non-E2E test passes with intended negative coverage.
- [ ] 11.3 Required types, lint, dependency, duplicate-code, pattern, Rust formatting/policy, Worker runtime, build and size checks pass.
- [ ] 11.4 Non-browser evidence for security/trust, archive preservation, failure recovery, typography structure and measured work budgets matches the specification; final browser/rendering proof follows in 12.1.
- [ ] 11.5 Review complete uncommitted changes across repositories; preserve unrelated user changes and existing production state.
- [ ] 11.6 Record that the implementation gate passed; only then authorize execution of final E2E.

## 12. Final Verification and CI Deployment

- [ ] 12.1 Run final isolated acceptance suites on Chromium and WebKit, including actual WebKit coverage on Linux CI; happy and failure/pending paths for all nine architecture areas and typography.
- [ ] 12.2 Repair any meaningful final failure and rerun affected checks; never bypass a required scenario.
- [ ] 12.3 After final local checks pass, stage all authorized application changes and required shared/server changes; create final version-bound commits without AI trailers.
- [ ] 12.4 Push the final release candidate, including exact dependency pins; run every required CI job against its immutable artifacts.
- [ ] 12.5 Deploy the complete compatible cohort through the release coordinator after green CI; preserve validated rollback and recovery state.
- [ ] 12.6 Verify production manifest/component SHA/digest/capabilities, deployment status, updated desktop/mobile flows and coverage evidence.
- [ ] 12.7 Mark the goal complete only when every required task and acceptance criterion is satisfied; report exact releases and remaining device-upgrade requirements.

## Partial Implementation Evidence — 2026-10-14

This is progress evidence, not an implementation-gate or deployment approval.

### Immutable application-source record/admission increment

- Added strict 64-KiB canonical source records, separate original/refresh/imported
  states, scope/parent/reference validation and a signed `recordApplicationSource`
  command. Commands capture input before asynchronous hashing; duplicate IDs,
  generic edits, archives and history-review replacement cannot overwrite sources.
  Child renumbering and pending-move presentation preserve source records.
- Meaningful red cases confirmed the missing record contract, owner overwrite,
  hash/sign race, whole-map deletion/substitution, initial-record protection,
  Text-encoded namespace disguise and browser policy failure. Fixed those paths.
  Rust admission retains invalid raw evidence in quarantine and independent valid
  branches in the authorized projection. Refresh cycles reject without recursion;
  historical pre-source map replacements remain valid, distinct IDs merge, and
  incompatible same-ID creations require review. Existing automation grants remain
  unable to author source entities at that increment; explicit v2 capture follows below.
- Source logic tests pass: six command, seven reader, six transition and four
  real compiled-WASM admission cases. Seventeen native source cases sit within
  the 32 passing causal-admission cases. The latest full core library run passed
  207 cases with three existing formal-graph cases ignored; subsequent bounded
  timestamp/gate changes passed the causal suite and rebuilt both WASM artifacts.
- A complete root aggregate passed 222 files / 2,285 cases, with one opt-in file
  and two cases skipped. Full quality passed types, lint, dead-code/dependency,
  duplication and pattern checks (603 modules / 2,196 dependencies). That aggregate
  precedes the last large-change operation-gate fallback; the four real WASM cases
  were rerun after it. The subsequent complete Worker runtime suite passed all
  57 cases, including its 312k-operation workspace within 64 MiB policy memory.
  Worker type checking passed. The memory case initially failed at 123,011,072
  bytes; changes above 32,768 operations now use the complete source transition
  check without allocating expanded per-character operation structs.
- Production build/size passed with unchanged budgets: private JS 238.9/239 kB,
  private CSS 10.74/10.75 kB, public JS 61.79/235 kB, public CSS 10.6/10.6 kB,
  transport WASM within 2.3 MB and policy WASM 1.19/1.2 MB. Replacing runtime
  timestamp formatting with fixed ISO validation removed unnecessary formatting
  code; no size or Worker memory limit was relaxed. Source protocol enum literals
  are distinguished from UI copy by bounded AST rules; visible terminology remains
  covered by the existing negative cases.
- Five `e2e/application-source-binding.spec.ts` scenarios are authored and linted,
  including successful explicit binding/retry/dedup, changed page/404, missing
  original, stale workflow and revoked grant. They remain unrun; capture/binding
  UI and the test-only job-page endpoint remain unimplemented. Source-backed
  intake/matching, narrow versioned capture grants, submission/reference evidence,
  signed retained-mail audit, legacy/fork provenance, bounded archives and the
  complete release gate remained open at that increment. No browser, E2E, staging, commit, push or
  deployment occurred.

### Versioned source intake and matching increment

- Confirmed red contract/command/runtime/native cases before implementing v2
  scope and `job-intake@2`. Exact added permission is
  `board.application.source.append`; signed definition and grant versions must
  agree. Unknown versions and expanded permission lists fail. V1 signed JSON and
  its restrictions remain unchanged. Capability negotiation rejects an unsupported
  requested v2 before owner signing/enrollment. Existing retry keeps its exact v1
  approval; UI upgrade is an explicit owner action, with failed activation pending.
- `createItemWithApplicationSource` captures its whole draft before asynchronous
  digest work and creates one card plus original in one signed change. Worker
  capture uses extracted posting fields without submission-label overrides.
  Missing/unsafe/oversized/incomplete evidence becomes unavailable, with no partial
  or fabricated text. Caller mutation during either hashing stage is covered.
- Rust admission permits exactly one same-card original alongside new-card
  creation, or one refresh of a prior original on an existing active scoped card.
  Existing originals cannot be overwritten; foreign-board/root/multi-record effects
  reject. Source-only refresh has a bound card, not expanded editor authority.
  Unchanged source metadata does not make a card non-leaf; real children still do.
  Five native matrix cases pass, including actual signed v1/v2 grants and unknown v3.
- Source-backed candidates read admitted records. Matching ignores editable labels,
  mutable thread fields and refresh text; semantically identical concurrent originals
  deduplicate without timestamp precedence. Selected conflicts, missing originals
  and same-company ambiguity require review. Exact retained original URLs can
  identify unavailable records. A current source-ID set and workflow are checked
  again after synchronization; the pre-source v1 URL path remains during migration.
  Actual compiled-policy Workerd flows cover v2 atomic capture/restore/dedup and
  rejection with no live page fetch, plus an unchanged v1 grant reading an
  owner-captured original and moving with source metadata present.
- Root aggregate: 224 files / 2,296 cases passed, one opt-in file and two cases
  skipped. Full root quality passed before the equivalent single-schema permissions
  refactor; its affected five-file run then passed 26 cases and targeted lint/types.
  Build/size passed afterward with unchanged budgets: private JS 238.47/239 kB,
  private CSS 10.74/10.75 kB, public JS 61.05/235 kB, public CSS 10.6/10.6 kB,
  transport within 2.3 MB and policy 1.19/1.2 MB. Replacing the duplicate definition
  schema kept exact version-specific permissions and removed unnecessary startup
  schema machinery; the earlier 447-byte overage was fixed without raising limits.
- Core library: 212 passed, three existing formal-graph cases ignored; both WASM
  artifacts rebuilt. Changed Rust files pass rustfmt; a full-core formatting scan
  additionally found pre-existing formatting in proof-transfer/runtime files,
  which is not represented as passing here. Worker Node suite passes 26 cases;
  complete Workerd suite passes 75 cases in six files, including its unchanged
  large-document memory test. Worker types and targeted changed-source/test lint
  pass. The human-workflow fixture additionally passed after its mutable test state
  cleanup. The equivalent human-check credential stripping cleanup followed the
  aggregate and passed Worker types/lint; the aggregate is not exact proof for that
  final local cleanup. Removed obsolete unused replica imports/arguments and progress destructuring;
  no authorization/receipt boundary was removed.
- Source detail/refresh UI, manual first-Apply capture, immutable submission/ATS/
  thread evidence, signed retained-mail binding/audit, legacy/fork provenance and
  all remaining nine-area requirements are still open. The five source browser
  scenarios now author explicit upgrade assertions but remain unrun. No E2E,
  staging, commit, push, deployment or implementation-gate completion occurred.

### Retained-mail binding coordinator increment

- `automation-application-binding@1` carries full device-chain proof, separate
  durable routing/definition IDs, original event/source/decision digests, exact
  grant/access epoch and dated workflow. Domain tests reject tampering, incomplete
  ancestors, wrong owner and stale signing contexts. Historical proofs remain
  verifiable without pretending that historical validity proves current rights.
- Worker scope verification reads its admitted original/legacy record, not display
  labels or refreshed text. Shared compiled Rust access policy checks current
  owner-device revocation against the actual document and signed authority. A
  native-policy fixture rejects a formerly valid revoked owner device.
- Event identity includes exact decoded original MIME bytes, authenticated parsed
  event and durable row/routing identity. An initial implementation incorrectly
  hashed base64url text; a non-UTF-8 byte fixture reproduced that fault before the
  byte-correct fix. Retained classifier validation shares the live model/policy,
  probability and margin rules and rejects uncertain or contradictory decisions.
- Purpose-bound AES-GCM stores exact proof and classification. SQL binding history,
  causal current pointer and saved audit commit together with rollback on failure.
  Immutable triggers prevent rewriting/deleting history or audit. Exact retries
  retain initial ciphertext; stale/concurrent corrections and ID rebinding fail.
  Fresh-handle storage reread is covered, not complete Worker eviction recovery.
- Actual coordinator save does not schedule execution. Separate bound retry checks
  the stored current proof and reuses retained classification, with no Clef or
  page lookup. Date, forward-only status and current workflow guards remain.
  Another workflow change during sync returns review. An uncertain receipt leaves
  the event pending and no applied audit; retry uploads the already signed action.
  Its actual CRDT change hash, applied audit and event success commit after upload.
  These coordinator fixtures replace network sync; real receipt verification is
  separately exercised by the replica-engine suite.
- Review found a superseded bind could return duplicate-success; the negative
  fixture failed before requiring the current head. The old unbound retry could
  enqueue bound intent; its negative fixture failed before requiring signed bound
  retry. Deleted automation also discarded the retained classifier result; the
  failing fixture now passes with a SQL update preserving that original result.
- Current evidence: full root run passed 225 files / 2,305 cases (one opt-in file
  and two cases skipped), then the equivalent expected-schema reuse passed its
  eight affected domain cases and root types. Worker Node suite passed 31 cases;
  final full Workerd suite passed 96 cases in eight files, including existing
  large-document memory and actual receipt tests. Root types/lint/dead-code/deps/
  duplication/pattern checks pass; dependency check reports 607 modules / 2,220
  edges. Newly introduced schema duplication was removed without raising limits.
  Worker types and targeted source/test lint pass. Build/size and native Rusty/core
  tests were not rerun because their runtime files were unchanged in this increment.
- Public owner API, fresh request/replay protection, browser binding controls,
  full restart/old-reader and legacy routing adoption remain open. Source detail/
  refresh, manual first-Apply capture, submission/ATS/thread evidence and recovery
  fork provenance remain open too. All other nine-area gates remain incomplete.
  No browser/E2E, staging, commit, push or deployment occurred.

### Fresh review API and browser-control increment

- Added action/body/origin-bound `automation-application-review-request@1`, full
  unique device-chain verification and 60-second lifetime. Actual Worker routes
  expose discover/list/review/bind/retry. Current Owner/device native checks run
  after synchronization and before cached replies; encrypted nonce outcomes retain
  exact replay, reject nonce substitution and remain bounded to 128 live requests.
- Three HTTP/DO tests cover typed-definition versus legacy route discovery,
  retained review/save/explicit retry, signed mailbox metadata and cached replay
  after owner-device revocation. Network sync remains fixture-replaced; genuine
  signed storage receipt verification remains covered by separate engine tests.
- Worker observations now use verified signing contexts; strict readers reject
  extraneous certificate chains. A reproduced regression (six full device access
  checks for two unchanged observations) now reuses one native access decision,
  bound to exact document/authority/grant/identity evidence and clock/expiry.
- Automation settings lazy-load the signed mailbox adapter, selection controller
  and dialog. Legacy fallback requires explicit missing capability; authorization,
  transport or proof errors propagate. Save never schedules processing. Lost
  response retry reuses exact proof; owner loss or device switch blocks late UI
  publication. Local source selection rejects refresh/missing/foreign evidence,
  stale workflow and archived parents; honest unavailable/legacy originals remain
  eligible for explicit Owner selection. Plain retained text uses scoped reading
  typography; board/card styling stays Caveat.
- Root full logic suite passed 231 files / 2,354 tests, with one opt-in file and two
  cases skipped. Worker full Workerd suite passed eight files / 99 tests. Focused
  review domain/client/controller/adapter cases passed 54; after shared response
  reader extraction, its four affected app files passed 20. Root quality checks
  passed, with the newly introduced HTTP response-reader duplication extracted.
  After the equivalent response-reader extraction, full root quality checks passed
  again (622 modules / 2,295 dependency edges), with no new duplication. Build/size
  passed: private JS 238.51/239 kB, CSS 10.74/10.75 kB; all unchanged budgets pass.
- Full browser acceptance, actual Worker eviction/restart, reader compatibility,
  untyped route adoption and unbound legacy retry/activation routing remain open.
  Source detail/refresh, first-Apply/manual capture, submission/ATS/thread evidence
  and recovery-fork provenance remain incomplete. All final nine-area gates remain
  open; no browser/E2E, stage, commit, push or deployment occurred.

### Unbound retry and approval continuity increment

- New strict `retry-unbound` review action binds event ID without offset or proof.
  Actual HTTP/DO acceptance confirms discovered legacy routing, fresh native Owner
  access, exact nonce replay, body/action substitution rejection and bound-message
  refusal. The browser retry button uses the lazy routed adapter. Only explicit
  unsupported action permits an older API; invalid action metadata and failed
  access/transport/proof stay errors. Capability validation now distinguishes
  malformed advertisements from absent action support.
- Approval preparation preserves separate definition/routing IDs. Explicit
  configuration gets the requested new expiry; plain retry retains exact old
  approval. Expired historical signatures can establish prior continuity during
  renewal, but do not enable restore or execution. Native Worker renewal tests
  retain paused controls, pending ciphertext, stable migrated request ID and
  event dedup; altered historical signatures reject.
- New grants and definitions use verified signer contexts. The export boundary
  checks actual native Owner role, active device/workspace and current authority,
  uses complete same-person certificate evidence, and retains signer chains in
  final activation packets. Wrong keys, missing/substituted signer, mutable input
  and late authority changes have focused coverage. Purpose validation remains
  before profile/key reads; the full regression suite caught and corrected an
  accidental inversion while input capture was introduced.
- Evidence: final full root suite passed 232 files / 2,372 cases, with one opt-in
  file and two cases skipped. Full Worker Workerd suite passed eight files / 101
  cases, including the new actual HTTP route and expired historical renewal.
  Root quality checks passed before the final capability-validation tightening;
  its changed-file lint/types and affected client/adapter tests pass afterward.
  Worker types and changed production/test lint pass. Final build/size passes
  with unchanged limits: private startup JS 238.81/239 kB, CSS 10.74/10.75 kB.
  No Rusty/core runtime files changed in this increment, so those native suites
  were not duplicated.
- Public instance management/expired inspection, untyped legacy adoption, explicit
  migrated activation routing, old-reader/restart/browser acceptance and remaining
  raw signing producers are incomplete. Other nine-area gates remain open.
  No E2E/browser, stage, commit, push or deployment occurred.

### Existing-instance management increment

- Added fresh complete-chain `automation-instance-request@1` and signed
  `automation-instance-identity@1` contracts. Strict DTOs bind exact origin,
  workspace, typed definition, actual route, pinned executor and nonce; read bodies
  are bounded separately from 24 MiB activation. Shared fresh-device request and
  bounded HTTP response helpers preserve purpose-specific contracts.
- A narrow historical inspector validates complete native causal history before
  selecting an old issuer. It exposes no execution/upload ports, permits expired
  inspection, rechecks current Owner rights around pulls and preserves received
  revocations even when they revoke the caller. Genuine epoch-2 ownership transfer
  admits the successor and denies the former owner; tampered history rejects.
- Actual signed HTTP/DO discovery and identity work on existing non-UUID routes
  without bootstrap allowlists or identity provisioning. Cached responses still
  require fresh Owner checks after pull. The bounded nonce ledger stores encrypted
  exact outcomes and rejects changed proof/body reuse.
- Explicit adoption attaches a typed contract to the existing legacy executor.
  Ordinary renewal cannot silently adopt; typed/deleted instances cannot be
  adopted/resurrected. History, applied-event dedup, exact pending ciphertext and
  request survive. Fixed same-scope cursor regression: preserve Worker progress
  rather than resetting it to an older browser cursor. Changed scopes retain
  separate replacement progress.
- Managed activation atomically publishes replica chunks, active generation and
  current Owner/routing metadata; forwarding address and allowlist survive. Actual
  HTTP tests cover both typed renewal and untyped adoption; real SQL transaction
  failure rolls all three back. Worker-authored changes now use verified key and
  live authority contexts, with complete signer evidence.
- Browser retry uses lazy existing-instance discovery/identity instead of enrolling
  another ID. Expired/adoption state is distinct from execution confirmation.
  Renewal, adoption and permission changes require explicit workspace-read consent
  for the new 30-day term. Three outer UI cases are authored in
  `e2e/automation-instance-management.spec.ts`, structurally reviewed but unrun.
- Evidence: full root suite passed 237 files / 2,403 cases; one opt-in file and two
  cases remain skipped. Full Worker Workerd suite passed 8 files / 111 cases;
  changed HTTP denial/copy cases passed after final wording updates. Root quality,
  Worker types and changed-file/test lint pass. Final build/size passes unchanged
  budgets: private startup JS 238.75/239 kB, CSS 10.74/10.75 kB; public reader
  JS 61.07/235 kB, CSS 10.6/10.6 kB. Rusty/core runtime code was untouched in
  this increment.
- Remaining: browser approval renewal across ownership transfer, eviction/restart
  and old-reader migration acceptance; other raw signing producers; immutable
  submission/ATS/thread references, first-Apply/manual capture, source refresh UI
  and recovery-fork provenance. History/archive, attachments, revocation/key
  rotation, full same-person/product recovery and coordinated release gates remain
  open. No browser/E2E, stage, commit, push or deployment occurred.

### Command, chat and historical-owner signing increment — 2026-10-15

- `src/app/automationOwnershipRenewal.test.ts` first reproduced rejection of a
  legitimate successor's explicit renewal. Browser and Worker historical
  inspection now share `admitHistoricalAutomationAuthority`: full native causal
  admission precedes historical issuer selection, and the current non-revoked
  Owner alone may renew. Four app cases cover valid transfer, forged/foreign
  evidence, revoked successor and unsigned branches. The previous approval and
  paused control remain unchanged; ordinary Retry does not renew authority.
- Domain actor bindings and change proofs moved from raw-key identity helpers to
  `transactionProofs.ts`. Both commands and quarantine review accept a host
  signing-context factory. Browser persistence binds one authority revision,
  current capability and the exact durable local profile/key; Worker commands use
  their own admitted Automation grant, lifecycle and expiry. They do not use a
  browser identity store. Historical remote test fixtures supply explicit separate
  host contexts. Intended red tests reproduced wrong-key, incomplete-chain,
  authority-change, mutable-author and stale durable-key acceptance before fixes.
- Local signing now checks saved PKCS8 key material in addition to public identity,
  device and certificate. Encodings are cached per immutable CryptoKey. Tests
  replace saved device/root keys without changing public metadata and require
  rejection without rewriting the saved profile. Real IndexedDB authority plus
  compiled native policy tests reject a signed device revocation before/during
  command signing. Mutation/no-change failure cases now release private Automerge
  clones; those cleanup assertions also failed before implementation.
- Chat record construction requires a verified context at runtime and exports its
  complete certificate evidence. Its live producer rechecks identity, scope, owner,
  grants and revocation; failed authority reads cannot become empty allowed state.
  Wrong keys, missing ancestors, identity renewal and revocation/read failures
  reject before append/publication. Historical record creation is isolated in
  `records.testSupport.ts`; dependency rules forbid production imports of test
  support. Signing-only chat code loads on demand; receive verification stays on
  the existing path. Two E2E fixtures were updated for explicit remote-author
  contexts, without executing a browser. Their existing unrelated `any` lint
  findings were not suppressed or rewritten.
- TinSink retains its existing login wire and `TINSINK/1` domain while using the
  verified local signer and full chain. Request origin/challenge/deadline, exact
  opener, profile and workspace evidence are rechecked through asynchronous work
  and immediately before postMessage. Logic tests cover substitution, stale keys,
  missing ancestors, expiry and changed authority. Browser WindowProxy/navigation
  and delivery remain unverified.
- This does not finish Requirement 3. Generic grants, certificate issuance,
  enrollment bootstrap, ownership/control transfer, Keeper compatibility helpers,
  SDK producers and all commit/publication boundaries still need migration/audit.
  At this increment, the older scope-genesis/workspace-authorization signing
  helper still had a separate cached-profile path; its next migration must compose
  durable profile/key validation rather than treating a cached bootstrap as proof.
  History baselines/archives, encrypted Rusty attachments, complete migration and
  coordinated release work remain open. No E2E/browser, staging, commit, push or
  deployment occurred; the full implementation and final release gates stay open.

- Aggregate for this increment: full root logic passes 241 files / 2,440 cases,
  with one opt-in file and two cases skipped. The final eight-case command file
  passes after its empty-change stub was corrected to the actual `undefined`
  return type. Full Worker Workerd runtime passes eight files / 113 cases.
  The native Rusty HTTP suite passes three cases against an isolated existing
  service binary, including cold photo delivery; no native source changed here.
  Root quality passes types, lint, knip, dependency boundaries (644 modules,
  2,428 dependencies), duplication and pattern checks. Worker types and changed
  production/test lint pass. Build/size checks pass without changing limits:
  private startup JS 238.76/239 kB, CSS 10.74/10.75 kB, public JS 61.07/235 kB,
  public CSS 10.6/10.6 kB, Markdown and all three WASM budgets. The 61-scenario
  acceptance map remains ordered and complete structurally; acceptance gates
  remain open.

### Earlier causal profile and activation evidence

- Identity name and photo use the signed causal register in the private root and
  `profile-observations@3`. Non-adoption activation requires the existing local
  profile to match the manifest person and verifies that profile's private signing
  keys before writes; missing or mismatched profile requires restore and cannot
  bootstrap or partially activate. The validated raw profile is passed as
  `expectedRaw` to SDK presentation refresh, so cache publication is bound to the
  profile bytes checked during planning. The transfer reader rejects missing @3
  state, state hidden under @1/@2, forged operations, absent conflict history and
  presentation shadows that disagree with signed values. Current focused suites:
  domain model 8 tests; transfer compatibility 8; profile-root integration and
  activation preflight checks; atomic save 5; 11 focused SDK presentation-refresh
  checks pass. `mesh-identity` package-index
  lint retains four pre-existing findings; do not claim that index lint is green.
  The latest full aggregate passes 2,258 tests across 218 files, with one opt-in
  file and two tests skipped. Full root quality passes types, lint, unused code,
  dependency boundaries, duplication and code-pattern checks. The native
  cold-photo case uses production `saveIdentityPhoto` and verifies causal signed
  operations survive pull; three native HTTP cases passed. The profile-conflicts
  E2E has four authored cases, including pending-revision loading, and remains
  unrun. Browser, old-reader compatibility and all implementation/final gates
  remain open.
  Current build/size checks pass: private startup JavaScript 238.02 / 239 kB,
  private CSS 10.74 / 10.75 kB, public JavaScript 61.8 / 235 kB, public CSS
  10.6 / 10.6 kB, and Markdown/WASM budgets. No browser, E2E, staging, commit,
  push or deployment occurred.

- Earlier, after opaque-extension retention and startup packaging changes, `npm test`
  passed 206 files and 2,157 tests, with one opt-in file and two tests skipped.
  The final session-state extraction then passed all 10 affected scheduler cases.
  At that increment, full `npm run quality` and `npm run quality:size` passed; build budgets
  remain unchanged. Private startup JavaScript rounds to 239 kB against 239 kB,
  private CSS to 10.74 kB against 10.75 kB, public JavaScript to 61.8 kB against
  235 kB, and public CSS to 10.6 kB against 10.6 kB. Remaining Markdown and WASM
  budgets pass. The three native HTTP cases also pass; cold restoration now
  includes exact opaque optional state after deleting the receiver's local copy.
  Browser/E2E, staging, commits, pushes and deployment have not been performed.

- The portable private-connection writer now emits wire v3 with explicit
  workspace/identity purpose. The reader normalizes v2 as workspace-only and
  rejects an identity config disguised as v2. Device-state component schema is
  `private-rusty-connections@3`, with a legacy `@2` workspace reader. Purpose-bound
  identity ciphertext still uses opaque object wire v1; AAD binds purpose, person,
  scope and key epoch. Portable preference export excludes local cursor, receipt
  acknowledgment and pending outbox state.
- `IdentityReplica` uses the shared replica engine and signed identity-state
  protocol; `createIdentityReplica` composes repository, capability/current-device
  guards and manifest activation. `src/sync/rustyManagement.native.test.ts` now has
  three isolated native HTTP cases, including a cold same-person device with its own
  enrolled device key pulling an updated photo and exact opaque optional component
  after its local extension state is removed and source capture is unavailable. Its
  focused run passed 3 tests. The ordinary loop now provisions
  this factory for existing board-only Rusty origins, runs identity before board
  replicas and reloads configuration within the same pass. Seven setup tests and
  eight scheduler-loop tests cover provisioning, durable retry, activation and
  failure reporting. Initial person-policy migration still uses the configured
  legacy controller; after confirmation, resource creation can use an independent
  same-person device. This does not prove browser behavior, complete
  owner-capability compatibility, release compatibility or the implementation
  gate; task 1.6 remains open.

- Current full `npm test` passed 202 files and 2,128 tests; one opt-in file and two
  tests were skipped. Full `npm run quality` passed types, lint, unused
  declarations/dependencies, dependency boundaries (568 modules / 1,991
  dependencies), duplication budget and code-pattern rules. Current scoped checks
  also include 58 Rust tests plus format/build, three native HTTP tests, six client
  files / 63 tests, 14 capability-verifier tests and 6 discovery tests. Two later
  client boundary fixes were followed by 48 affected tests, type checking and
  targeted lint; no second full-suite run followed those fixes. No E2E, release,
  rollback-cohort or deployment evidence is claimed.

- Private preferences now use one `tincanban.private-replica-state.v2.<person>` record.
  The production loader, same-person exchange, enrollment and cursor writer use it;
  legacy effective-config and timestamp-precedence writes have been removed.
  Migration retains both legacy keys. Full old-tab compatibility, complete device
  manifest/recovery and a product flow for credential conflicts remain unfinished.
- Verified signing contexts validate the complete certified chain and private-key
  binding, snapshot inputs before asynchronous crypto, and guard scope/purpose,
  authority revision and expiry. Workspace genesis, workspace-change authorization
  and private-preference export use the resolver. Other producers remain to migrate;
  this does not satisfy section 3 as a whole.
- Rusty connection management, snapshot-checkpoint preparation, public publication
  commands and automation owner requests now use verified contexts. Browser owner
  requests recheck the active local identity and certificate, reject mismatched
  private keys, and bind purpose/scope/challenge/expiry. Automation owner-request
  construction now accepts a verified context instead of a raw profile. Input
  snapshots protect activation bodies and management evidence across awaits.
  Intended failing producer cases exposed wrong-key requests and stale publication
  after identity replacement. Seven focused suites passed 47 tests; the affected
  Worker runtime suite passed 22 tests. This does not establish explicit Rusty
  capabilities or finish remaining chat, enrollment, grants and ownership producers.
- The required-component manifest is now wired into enrollment approval v3 and
  ongoing same-person state v3. Runtime adapters read actual catalog, own signed
  profile observations, entitled references, causal private connections, signed
  management capabilities and opaque recovery envelopes. Private keys and device
  progress are excluded. Readers preflight required schemas, all supplied device
  certificate chains, root-key binding, service policy signatures and profiles
  before mutation. Current codec writes `owner-capabilities@2` and only accepts
  `@1` for legacy resource-only records; person capabilities require `@2`. This
  code path has focused codec/reader coverage. Unknown optional components now use
  `preserved-identity-components@1` in `tincanban.identity-device-extensions.v1.<person>`.
  It unions, sorts and deduplicates opaque variants (maximum 256 unique entries and
  1 MiB serialized state), rejects required/raw-key smuggling, and preserves future
  container schemas opaquely. The import plan joins the same activation CAS; newer
  local registry bytes block overwrite and require upgrade. Thirteen focused
  extension tests cover import/export, order-independent union, rollback, limits,
  cross-tab retry and mutation during storage reads. This does not complete task
  1.3's unified manifest contract or
  task 1.4's complete migration/recovery requirements; both remain unchecked. Legacy
  approval compatibility and complete recovery remain unfinished.
- Startup packaging is bounded: `recoverPendingIdentityDeviceActivation` reads
  only the current person's pending-activation key and returns before importing
  full transfer activation when that key is absent. Four tests in
  `src/sync/identityDeviceActivationLoader.test.ts` cover absent, pending,
  identity-change and failed-recovery paths. `src/sync/lazyDeviceEnrollment.ts`
  loads explicit enrollment only after selection; three tests in
  `src/sync/deviceSyncEnrollmentLoading.test.ts` cover ordinary startup, selection
  and cancellation during initialization. Fira Sans
  faces/prose CSS in `src/styles/design-system/reading-fonts.css` ship with lazy
  `ItemDetailDialog` and `WorkspaceChat` surfaces; the JSON mono rule stays in
  `SchemaWorkspaceJsonSection.vue`. Structural assertions are in
  `src/styles/design-system/readingFontsPackaging.test.ts`; no browser or
  rendered-bundle proof is claimed.
- Rusty now has an explicit service/person/resource management-policy namespace.
  Confirmed capabilities replace controller ancestry for migrated resources;
  first migration retains operator-approved legacy proof. Current capability,
  operation and cumulative device-revocation checks guard enrollment, publication,
  staging and checkpoints under the storage lock. Immutable owner-signed evidence
  precedes atomic policy publication; pending markers survive pointer faults and
  restart. Exact completed retries cannot erase another pending update.
  Status disclosure requires a current owner-device signature and durable single-use
  nonce; the service signs request/capability/revision/pending-state receipts.
  The server also requires the current management revision inside the signed
  enrollment, checkpoint, publication and staged-file authorizations. A substituted
  newer outer capability cannot authorize an older signed command. The person-policy
  server adds a separate root-person capability; one initial migration uses the
  configured legacy controller, while later scope creation requires exact parent
  capability/revision and no controller ancestry. The Rust suite passed all 58 tests;
  required formatting and binary build pass.
  Browser status reads now authenticate the owner device, verify the pinned signed
  status receipt and persist the exact capability before using its rights.
  Enrollment, publication/status/staging and checkpoints carry the capability and
  signed management revision; live policy guards reject imported revocation or
  revision changes around asynchronous signing. Known migration never falls back
  to controller ancestry when the descriptor loses capability support.
  The atomic per-person management repository retains monotonic signed authority
  and exact local pending requests independently from storage credentials/cursors.
  It preserves unresolved intent on restart, receipt loss, unrelated newer policy
  and transaction failure. Portable batch imports validate all evidence before one
  transaction, retain fresher local policy and exclude pending request bytes.
  Current focused evidence: six client files passed 63 tests, plus 14
  management-capability verifier tests and 6 discovery tests. Three separate native
  HTTP tests passed against the current Rusty binary. They cover signed status and
  explicit migration/storage enrollment, independent same-person scope creation
  after controller pins are removed (same volume/origin restart, no root private
  key), and cold photo delivery without source capture. This is protocol evidence,
  not browser or deployed-phone proof. Global revocation UI, future key/token
  rotation, explicit migration/recovery UI, interrupted workspace-installation
  recovery, old-reader compatibility for opaque optional components, older approval
  migration, live
  workspace-owner guards, baseline/attachment integration and compatible rollback
  readers remain open. Section 2 and the release gate remain incomplete.
- Public signing evidence now rejects extra runtime fields in identity and
  certificate envelopes/payloads before export. A failing test demonstrated that
  valid signatures alone did not prevent private metadata on an unsigned identity
  wrapper from entering a request; strict live-producer schemas close that gap.
  Historical stored records are not rewritten. Remaining producer migrations are
  still required.
- Earlier focused authority/signing evidence (12 Vitest suites, 128 passing tests
  and one pre-existing opt-in admission benchmark skipped) predates the current
  person-policy increment; do not treat it as current aggregate proof. The current
  person-policy scoped counts above are separately reported. Unknown or malformed
  advertised management versions require upgrade rather than being mistaken for an
  unmigrated legacy service. This does not claim the complete architecture
  acceptance matrix or implementation gate passed.
- Focused non-browser foundation run: six Vitest files, 87 passed, one pre-existing
  skipped test. Meaningful failing cases were observed before fixes for missing
  ancestors, wrong keys, authority races, mutated requests, revoked sessions,
  malformed packets, atomic preferences and causal-state bounds.
- Type checking, source lint and dependency checks passed for this foundation.
  These do not replace the remaining required checks or final browser verification.
- Browser and Worker ordinary replication now use the shared SDK `ReplicaEngine`.
  Exact encrypted outbox bytes and request IDs persist before delivery; receipt
  verification precedes atomic acknowledgment. The browser production adapter
  commits progress in the private repository, guards identity/credential changes,
  and does not write a second cursor record. Chat content revisions use durable
  metadata; no-op polling does not export historical chat. Focused browser/core
  adapter suites: 27 passed. Worker workerd suites: 32 passed. Shared engine
  contract suite: 16 passed. Intended red cases preceded implementation.
  These results do not cover the remaining checkpoint outbox, credential-retirement,
  bounded-history, complete-device-state or coordinated-release requirements.
- Current root types, standard source lint and dependency checks pass; Worker types
  pass. Removed only the obsolete suppression for the changed chat store after
  comparing the pruned inventory. All remaining required checks and acceptance
  gates remain open.
- Typography acceptance tests are authored and included in the WebKit matrix,
  but unrun. All board/card text retains its existing Caveat styling. Fira Sans is
  limited to detail descriptions/notes and discussion/chat prose. Font fallback,
  actual rendering, text zoom, motion and transfer budgets await final verification.
- No E2E/browser verification, staging, commits, pushes or deployments were executed
  during this implementation phase. The full implementation gate remains open.

- Device-state activation now plans catalog, private connections, management rights
  and recovery against exact serialized inputs, then publishes them in one
  IndexedDB compare-and-swap transaction. Enrollment includes the candidate local
  profile and previous-profile backup in that transaction; candidate keys stay
  inside the local storage adapter and never enter the portable manifest.
  Concurrent changes force retry; invalid existing evidence or transaction failure
  leaves all prior components intact. Legacy migration inputs remain readable and
  are included in the compare-and-swap conditions.
- Certificate/chat stores are secondary projections of durable activation and
  profile-observation state. Current working-tree code adds an author-only verifier,
  person-bound deferred projection queue and a projector that resolves the
  installed document's current chat scope/authority before using the full workspace
  verifier. `src/sync/identityProfileProjection.test.ts` and
  `src/chat/privateProfileObservation.test.ts` contain authored coverage for
  pre-install retention, no rights from the record's authority wrapper, later
  projection and retry after storage failure. Reported focused runs pass: 13 core
  projection, 7 queue, 7 private-author verifier, 7 lazy activation-loader and 4
  recovery-watcher tests. The native cold-pull case restores the original signed
  profile to the deferred queue for an unknown workspace; it proves transfer and
  private retention, not shared projection. Pending-reason data is returned to the
  recovery controller, but diagnostics UI is not complete. Browser acceptance,
  compatible old-reader behavior and final cross-path verification remain open;
  these focused results do not complete Requirement 1 or the release gate.
- Earlier foundation evidence: `src/domain/identityProfileState.ts` introduced a pure causal model with six reported
  real-crypto tests passing for signed per-device counters/context, full certificate
  verification, retained legacy-value hashes, explicit conflicts/resolution, and
  rejection of forged/missing/equivocating evidence. Limits of 512 operations,
  512 legacy values and 1 MiB apply to this model only; they are not the history
  baseline/checkpoint policy. At that point the model was not connected to transfer,
  photo storage or conflict UI; the newer integration evidence at the beginning of
  this section supersedes that limitation. `saveIdentityName` then atomically
  updates candidate `local_profile` and personal-root name using the exact old
  profile plus root CAS plan. Missing-root, abort and root-CAS-race cases preserve
  durable/cached state; notifications and existing workspace-profile publication
  occurred after commit. That earlier rename transaction did not create/resolve
  causal model operations. The current transaction signs the name and optional
  photo together and guards the reviewed causal revision before every CAS attempt.
- Ordinary signing accepts a valid non-enrolling certificate leaf. Enrollment
  capability is checked on issuers; a non-enroller cannot issue a child certificate.
  Historical signatures are unchanged. Proof storage now applies targeted atomic
  mutations to the latest durable record, preserves concurrent certificates and
  grants, does not resurrect removed grants from stale caches, and detaches inputs
  and reads. Malformed/newer evidence stops writes without replacing recovery data.
- New negative tests first reproduced partial imports, stale certificate collection
  writes, alias mutation, invalid certificate acceptance and stale cached identity
  adoption. The focused 23-file non-browser run passed 195 tests before the final
  strict-proof decoder check; its affected five-file run then passed 36 tests.
  Independent IndexedDB connections and a transaction fault after its first queued
  write prove atomic publication, beyond the memory adapter. Final aggregate checks
  follow; no architecture-wide completion is claimed.
- Final focused check for this activation increment: 23 files, 197 passing tests.
  Root type checking, standard source lint and dependency checks pass (550 modules,
  1878 dependencies). Removed only now-unused proof-store suppression entries;
  no broader suppression pruning occurred. SDK adoption tests additionally reject
  stale cached identity after another tab replaces its durable profile, and key-map
  mutation during asynchronous preparation. No E2E/browser, staging, commit, push
  or deployment took place; sections 1–10 and the release gate remain incomplete.

- Previous aggregate before the causal profile/name increment: `npm test` passed
  211 files / 2,203 cases (one opt-in file and two cases skipped); the four affected
  codec/transfer/extension/projection files then passed 44 cases after the alias
  refactor. That earlier aggregate is not current proof.
- Earlier full app run after fixing the UI-copy-policy literal in the new model error
  and the secondary-context fixture: 214 files passed, 2,217 tests passed and 2
  were skipped (one opt-in file). The pure identity-profile model's six tests are
  included. Before that final full run, the affected model/UI-copy-policy files
  passed 432 cases and targeted lint. That aggregate predates profile integration.
- Full quality passed types, lint, dead-code/dependency checks, duplication and
  code-pattern rules (591 modules, 2,107 dependencies) before the final model
  duplicate-legacy/error-word/fixture changes; the affected model/UI-copy-policy
  follow-up passed targeted lint. The separate vendor SDK package-index lint is
  outside root quality and still reports four pre-existing untouched issues.
  Production build/size passed after the name/model changes: private JS
  237.23/239 KB, private CSS 10.74/10.75 KB, public JS 61.8/235 KB and public CSS
  10.6/10.6 KB, plus Markdown and all three WASM budgets.
- The three native HTTP tests passed before this profile/model increment and were
  not rerun. Their prior cold profile case proves transport and deferred retention
  for an unknown workspace, not shared projection. No browser/E2E verification,
  deployment or gate completion is claimed. Causal model integration, conflict UI,
  older-reader compatibility and the broader architecture requirements remain open.

### Workspace writer-floor migration — 2026-10-15

- `privateReplicaRepository.ts` now records a device-local writer-upgrade intent.
  While present, reads and progress writes for that scope are blocked. Preparation
  refuses a same-scope pending snapshot outbox. The intent is excluded from portable
  state and exported credentials.
- `workspaceReplicaWriter.ts` checks current local identity and workspace owner
  authority, including signed device revocations. It discovers the pinned Rusty
  service, migrates the legacy attachment index before requesting floor 2, and
  requires a signed monotonic receipt. One local transaction then publishes the
  writer-v2 preference, rebinds the exact retained progress/cursor/acknowledgment,
  and removes the intent. `privateReplicaFactory.ts` invokes this lazily from the
  ordinary `privateReplicaLoop.ts` before constructing a workspace adapter.
- Portable policy-only updates retain exact pending ciphertext and cursor. The
  combined private-state import plan can migrate the legacy index in its CAS using
  exact raw source and target records. Pending outboxes that depend on changed key
  or access tokens still refuse activation for explicit migration; no migration
  procedure for that state is claimed.
- Reported focused evidence: 13 real-IndexedDB repository cases in
  `src/sync/replicaWriterUpgrade.test.ts`, six workspace-writer cases in
  `src/sync/workspaceReplicaWriter.test.ts`, and 15 scheduler cases. The native
  HTTP suite reports five passing cases, including a real floor-1 to floor-2
  upgrade, a legacy writer's HTTP 426 refusal and a v2 signed receipt. These checks
  establish local logic and native protocol behavior, not browser or deployed
  cohort acceptance.
- Final non-browser app run for this increment passed 255 files / 2,617 tests,
  with one opt-in file and two tests skipped. All six root quality categories
  passed (677 modules / 2,617 dependency edges); the final native HTTP suite passed
  five cases. Startup/network factory extraction retained all size budgets without
  raising limits: private JS 238.97/239 kB, private CSS 10.74/10.75 kB, public JS
  61.09/235 kB and public CSS 10.6/10.6 kB; Markdown and all WASM budgets passed.
  Logs: `/tmp/tincanban-writer-complete-{nonbrowser-tests,quality,size,native}.log`.
  Browser acceptance, old-reader/rollback compatibility, explicit key/token
  migration and the implementation/release gates remain open.
- Newly confirmed cross-component gap: a floor upgrade advances Rusty's
  `policyRevision`, while an already-approved Worker retains the older revision in
  its replica binding and verifies exact receipts against that binding. No current
  coordinated refresh preserves the existing Worker grant/expiry/rights, control
  state, pending ciphertext/request IDs, dedup state and cursor across this change.
  Exact receipt verification must stay strict; no implicit grant renewal is allowed.
  Requirement 7 now includes this acceptance case. Its implementation and
  cross-component proof remain pending despite the passing local/native checks.
  The complete specification and ordered verification map now contain 66 scenarios.
  No browser/E2E, staging, commit, push or deployment occurred.

### Existing Worker storage-policy refresh — 2026-10-15

- This increment supersedes the Worker compatibility gap above and implements
  task 7.7 without completing Requirement 7 or either final gate. The strict
  `refresh-access` body contains existing public storage coordinates and a signed
  Rusty receipt only. Complete-chain fresh Owner requests, current Native
  authority and transaction-local durable generation checks protect the Worker
  update. Signed responses bind the exact request nonce and confirmed public
  revision/floor. New upload receipts still require the exact active revision.
- Browser writer migration preflights all discovered typed routes before a new
  barrier or remote policy change, then durably captures both the route union and
  verified receipt. Lost Worker replies reuse that receipt; removed routes cannot
  disappear from retry. A bounded rescan captures new Workers before local
  activation. Unsupported Workers, identity/authority changes and an unstable
  cohort retain explicit retry state. Only cryptographically verified workspace
  revocations exclude unrouted cached grants. Live untyped grants still require
  explicit adoption/removal; no implicit renewal or authorization widening occurs.
- Red cases reproduced ignored maintenance failure/unsupported preflight and
  acceptance of a foreign-service receipt under a valid Worker echo. The client
  now verifies Rusty's signature before sending, independently from verifying the
  executor's signed reply. Owner and executor use distinct real keys in tests.
  The HTTP Workerd case refreshes an actual persisted pending action, retries the
  identical ciphertext/request at the new policy revision and preserves dedup.
  Separate expired paused/deleted cases retain the complete serialized state and
  do not reactivate the grant. A stale durable generation rejects before writes.
- A legal 32-actor preference revision reproduced failure to open the legacy
  attachment index above its former 2,048-character bound. Both index entry points
  now use one 16-KiB UTF-8 bound without changing any hashed key or source record.
  Focused index tests pass 24 cases. Route journal parsing has independent
  bounded/privacy/substitution coverage and retains only detached public routes.
- Current non-browser root suite passes 258 files / 2,654 cases, with one opt-in
  file and two cases skipped. Workerd's complete suite passes eight files / 120
  cases; after wire-code consolidation, four focused HTTP/control/CAS cases and
  Worker type checking pass again. Native Rusty HTTP passes five cases. The ordered
  specification/map check still matches all 66 scenarios. These are separate
  host/protocol results, not a deployed multi-component cohort.
- Final root quality passes all six categories: types, source lint, unused code,
  dependency rules (684 modules / 2,659 edges), duplication and patterns. Logs:
  `/tmp/tincanban-cohort-final-{tests,quality}.log`,
  `/tmp/tincanban-cohort-worker-complete.log`,
  `/tmp/tincanban-cohort-wire-worker-final.log`,
  `/tmp/tincanban-cohort-native-complete.log` and
  `/tmp/tincanban-cohort-size-profile-boundary.log`.
- The initial production build exceeded the unchanged startup budget. Profile
  settings status formatting now loads with its settings panel, and writer
  maintenance loads only when a workspace connection actually needs it. The same
  Native revocation verifier runs inside the lazy cohort path. Final measured
  budgets pass without a limit increase: private JS 238.91/239 kB, private CSS
  10.74/10.75 kB, public JS 61.09/235 kB, public CSS 10.6/10.6 kB, Markdown and all
  three WASMs. Manifest inspection confirms network-policy and profile-settings
  modules remain outside private/public static startup closures. Temporary manual
  chunk experiments were removed; `vite.config.ts` retains its prior behavior.
- Automatic attachment uploads/coverage/streaming, pending credential migration,
  history baselines/archives, remaining signing/recovery/conflict and older-reader
  work are still open. No browser/E2E verification, staging, commit, push,
  deployment, scope reduction or goal completion occurred.

### Read-only attachment coverage proof — 2026-10-15

- Documented `blobCoverage@1` separately from opaque blob storage. The bounded
  read-bearer request names a sorted exact set of ciphertext IDs and key epochs;
  Rusty validates stored bytes and epoch, fsyncs the namespace, then signs the
  service/scope/current-policy/request/object-set receipt. No plaintext, blob
  payload or application grant enters this read-only protocol.
- The client suites pass 42 tests across coverage verification, discovery,
  transfer, repository and workspace descriptor handling. Rusty's full suite
  passes 72 tests, including malformed batches, missing/corrupt/wrong-epoch
  objects, denied access, live policy/revocation and injected directory-fsync
  failure. The fsync fault first reproduced premature receipt issuance; both
  scope-link and blob-directory durability are now required. Logs:
  `/tmp/tincanban-blob-coverage-rust-complete.log` and
  `/tmp/tincanban-attachment-coverage-client.log`.
- Updated Requirement 7 scenario 42 without changing scenario count/order. A
  locator alone is explicitly not durable-coverage proof. Automatic upload
  scheduling, product coverage UI and streaming remain unfinished. E2E remains
  unrun; no staging, commit, push or deployment was run for this documentation
  update.

### Cold attachment coverage confirmation and transfer binding — 2026-10-15

- `src/sync/attachmentCoverage.ts` now authenticates the retained encrypted
  manifest, derives the exact chunk IDs and verifies Rusty's signed batch proof
  without downloading chunk payloads. Current workspace/device guards run before
  and after confirmation. Five focused adapter tests pass.
- Rebuilt Rusty with `cargo build --locked`. The native HTTP suite passes 5/5;
  the source-closed/restart case confirms exactly three ciphertext objects before
  fresh-recipient file download, sends no write token, and denies a revoked read.
  Log: `/tmp/tincanban-blob-coverage-native-client.log`. Rusty's complete suite
  remains 72/72; focused client suites remain 42/42.
- `AttachmentTransfer` now binds saved work to stable content/storage identity,
  excluding replaceable bearer tokens, policy revision and peer tickets. A CAS
  migration changes only the binding/generation, preserving exact ciphertext,
  request IDs, historical durable receipts and progress. Fresh upload replies
  still require current policy; old journals require their original access to
  authenticate the legacy binding.
- These protocol and native results do not close Requirement 7: automatic upload
  scheduling, coverage UI, streaming and browser acceptance remain open. No E2E
  was run.
- A further red case reproduced refusal to resume an old journal containing an
  expired peer ticket. Descriptor comparison now excludes that transport hint,
  while migration retains the original descriptor and exact encrypted records.
  The focused four-file suite passes 33 cases; the subsequent complete root run
  also verifies a real IndexedDB CAS migration preserving an old ticket. Logs:
  `/tmp/tincanban-attachment-ticket-migration-{red,green}.log`.
- Current complete root logic suite passes 261 files / 2,682 tests, with one
  opt-in file / two tests skipped. Types and focused lint pass. Rust formatting
  and its complete 72-test suite pass; native HTTP remains 5/5. Specification and
  verification map match all 66 scenario titles in exact order. Root UI-copy
  checks initially rejected technical migration wording; the failure now gives
  an actionable original-access recovery instruction. Final root log:
  `/tmp/tincanban-attachment-coverage-complete.log`. All three repositories have
  empty staging areas. No browser/E2E, commit, push or deployment occurred; the
  full nine-area objective and final release gates remain open.

### Scheduled attachment replication and local coverage status — 2026-10-15

- Normal `createBlindReplica` push now discovers workspace file descriptors and
  schedules the encrypted attachment path. It uploads source bytes, verifies
  object receipts, merges the private locator index and flushes a bounded current
  snapshot before reporting `Complete on Rusty`. The cold-reader path verifies
  the manifest and signed exact object set without fetching chunk payloads, then
  confirms index publication before reporting completion. Preview/download
  independently fetch and authenticate the file chunks.
- Status remains in the local active replication session, scoped by workspace
  and exact descriptor identity. Presentation distinguishes checking, uploading,
  missing source, incomplete, unavailable, denied, unsupported and capacity.
  The `ItemDocuments` row defaults to `Not confirmed on Rusty`; completion text is
  `Complete on Rusty` only when a matching status is complete.
- Parent reports six native HTTP tests passing, including production scheduling
  from the actual encrypted server snapshot without a source callback, three
  ciphertext objects confirmed before recipient download, no write token and
  revoked-read denial. Root had 263 files / 2,705 tests before new UI tests; the
  current aggregate quality checks are still running. This entry does not claim
  fresh full-suite counts.
- UI helper suite now has five focused tests, including exact SHA-256 and BLAKE3
  descriptor matching. Browser acceptance remains unrun. Service-credential/key
  migration, streaming, history and the overall architecture goal remain open.
- Initial red cases reproduced missing scheduling, absent bounded snapshot flush
  and misclassification of a mid-upload permission revocation as a network
  failure. Tests now cover exact pending-snapshot retry followed by the new index,
  shared background work, lost index delivery without false completion, source-free
  retry, live guard invalidation and distinct 403/404/426/507/503 states.
- Current complete root logic suite passes 263 files / 2,707 tests, with one
  opt-in file / two tests skipped. All six root quality categories pass. Native
  HTTP passes six cases after the final adapter changes. Logs:
  `/tmp/tincanban-attachment-auto-final-{tests,quality,native}.log`.
- Production size checks pass without raising limits: private startup JS
  238.96/239 kB, private CSS 10.74/10.75 kB, public JS 61.07/235 kB, public CSS
  10.6/10.6 kB; Markdown and WASM budgets pass. Removal/status maintenance loads
  with the private connection factory. Manifest inspection confirms attachment
  network modules remain outside both static startup closures. Log:
  `/tmp/tincanban-attachment-auto-final-size.log`.
- The existing source-closed browser scenario remains unrun. A second authored
  scenario injects blob-upload failure, requires an unavailable file status and
  independently confirms a new card note reaches snapshot storage. Both scenarios
  parse; no browser/E2E execution occurred. All 66 specification scenarios still
  match the verification map in order. The full implementation and coordinated
  release gates remain open; nothing was staged, committed, pushed or deployed.

### Incremental local attachment persistence — 2026-10-15

- The mesh-blob SDK now offers lazy `putStream`/`getStream` over async byte
  iterables. Local records use a JSON pointer and immutable 256-KiB chunk keys.
  Writes hash incrementally, publish the new serialized pointer by exact CAS only
  after declared size and SHA-256/BLAKE3 match, and preserve old chunks/byte
  records. On uncertain publication response, a committed pointer is retained.
  Existing whole-byte records remain readable with one bounded whole-record
  allocation; they are not silently migrated or rewritten.
- App `storeAttachment(File)` computes its descriptor then replays
  `File.slice` chunks at most 256 KiB, never `File.arrayBuffer()`. SDK tests use
  memory and fake IndexedDB; the app test forbids whole-file `arrayBuffer`. Native
  HTTP 6/6 now starts with this local store format before automatic upload,
  coverage confirmation and cold recipient read.
- This local storage stream is not end-to-end encrypted transfer streaming:
  `AttachmentTransfer.upload` still accepts a complete `Uint8Array` and download
  assembles a complete bounded file. Durable chunk-by-chunk encryption intent,
  source/sink transfer, active stream cancellation, credential/key migration,
  history and full goal remain open. Requirement 7.4 stays unchecked.
- Final root suite passes 266 files / 2,727 tests; one opt-in file / two tests
  are skipped. SDK passes 33 files / 362 tests, including 11 stream-store tests;
  SDK TypeScript check passes. Native HTTP passes 6/6. Root quality passes all
  six categories: types, lint, unused-code, dependency, duplication and pattern
  checks. Logs: `/tmp/tincanban-stream-storage-final-tests.log`,
  `/tmp/tincanban-stream-storage-final-quality.log`,
  `/tmp/tincanban-stream-storage-final-sdk-types.log`,
  `/tmp/tincanban-stream-storage-sdk-tests.log` and
  `/tmp/tincanban-stream-storage-native.log`.
- Production size passes existing budgets: private startup JS 234.31/239 kB;
  CSS 10.74/10.75 kB; public JS 61.07/235 kB; public CSS 10.6/10.6 kB;
  Markdown and all three WASM budgets pass. Log:
  `/tmp/tincanban-stream-storage-final-size.log`.
- The spec/map check extracted all 66 `#### Scenario:` titles and compared them
  in order with the 66 numbered verification-map rows; titles match exactly.
  Local-store evidence remains attached to scenarios 42 and 44. No browser/E2E,
  staging, commit, push or deployment occurred. End-to-end encrypted transfer
  streaming remains open, as do credential/key migration, history and the full
  architecture goal; Requirement 7.4 remains unchecked.

### Encrypted attachment streaming and recoverable preparation — 2026-10-15

- Production upload now reads `BlobByteSource` chunks, hashes each bounded
  plaintext chunk while sealing and writing its ciphertext plus the exact
  extended preparation prefix together through CAS. After the full source digest
  verifies, one transaction publishes the unchanged v1 progress journal and
  encrypted manifest and removes the preparation intent. A complete staged
  restart needs no source file: it reopens every encrypted chunk and rechecks the
  full descriptor digest before publication. A partial prefix requires the
  original source and rejects a differing chunk. A full-source digest mismatch
  discards only the exact unpublished preparation and its ciphertext, allowing a
  valid retry. Existing transfer IDs, per-object request IDs and final wire schema
  remain unchanged.
- Production download streams authenticated plaintext chunks into the local
  blob-store atomic sink. A failed or incomplete stream publishes no replacement
  local pointer; a retry resumes from retained encrypted chunks. The preview and
  download APIs still materialize the completed file after sink verification.
- `attachmentStreaming.test.ts` and `attachmentPreparationRepository.test.ts`
  cover restart, source mismatch, digest-failure cleanup, atomic prefix/journal
  commits and sink recovery. `/tmp/tincanban-encrypted-stream-final-focused.log`
  records 8 files / 68 tests passing before the final cleanup retry; the later
  `/tmp/tincanban-encrypted-stream-retry-green.log` records 3 files / 21 tests
  passing for the retry change. Native HTTP log
  `/tmp/tincanban-encrypted-stream-native.log` records 6 passing cases.
  `/tmp/tincanban-stream-sdk-worker-runtime.log` records 8 files / 120 tests
  before these app-only changes. `/tmp/tincanban-encrypted-stream-quality-refactor.log`
  contains six-category quality output from before the final discard addition,
  so it is not final combined quality evidence. No final aggregate verification
  or browser/E2E run is claimed here.
- At this checkpoint, physical transport read reset, service credential/key
  migration, browser acceptance, history and the full architecture goal remained
  open. The following per-stream cancellation increment resolves the transport
  reset limitation only. Requirement 7.4 remains unchecked; no staging, commit,
  push or deployment occurred.
- Initial upload hashes each source chunk as it encrypts and stages it; newly
  staged chunks are not reopened in that pass. A complete staged restart reopens
  every chunk before final publication. The durable transfer binding uses only
  workspace, scope, key epoch, content key, Rusty origin and service pin; bearer
  tokens, policy revision and peer tickets remain outside the stable binding.

### Per-stream cancellation and session recovery — 2026-10-15

- `requestBlob` now resets the individual stream on normal release, cancellation,
  and late stream-open completion. The mesh transport adapter preserves optional
  reset for older adapters; it never closes the entire connection. The generated
  transport WASM and browser bridge expose/reset one stream handle. Core reset
  notifies blocked reads and writes before awaiting IO locks, then sends QUIC
  `RESET_STREAM` and `STOP_SENDING`; cancelled reads fail instead of returning
  partial EOF.
- Two real loopback QUIC cases cover pending-read cancellation, wire reset/stop,
  a subsequent request on the same connection, and a blocked writer racing
  concurrent resets. The original pending-read test first failed because the peer
  did not receive `STOP_SENDING`; focused native tests now pass 2/2. The complete
  Rust workspace test run passes; its log includes 212 core tests and both reset
  cases. Targeted Rust formatting checks pass for the changed crates/files.
- Focused TypeScript coverage exercises reset propagation, old-adapter fallback,
  normal cleanup and late-open cleanup. Final SDK suite passes 34 files / 373
  tests; root suite passes 269 files / 2,755 tests with one opt-in file and two
  tests skipped. Root six-category quality checks pass. Logs:
  `/tmp/tincanban-physical-stream-rust-red.log`,
  `/tmp/tincanban-physical-stream-rust-final.log`,
  `/tmp/tincanban-physical-stream-rust-workspace.log`,
  `/tmp/tincanban-physical-stream-ts-green.log`,
  `/tmp/tincanban-physical-stream-root-tests.log`,
  `/tmp/tincanban-physical-stream-sdk-check.log`,
  `/tmp/tincanban-physical-stream-sdk-tests.log` and
  `/tmp/tincanban-physical-stream-quality.log`.
- At the reset-only checkpoint, the first regenerated transport WASM measured
  2,302,354 bytes, 2.35 kB over its 2,300,000-byte budget. Synchronous stream
  detachment alone measured 2,301,460 bytes and remained over. The completed
  Promise-returning reset bridge retains the stream clone while detaching
  synchronously; its pre-annotation Brotli measurement was 2,299,582 bytes (raw
  10,848,575 bytes), and that reset-only size check passed. The later bounded-read
  build measured 2,300,144 bytes, 144 bytes over; the final optimized bounded-read
  artifact has not yet been measured. Do not treat the reset-only pass as the
  current result. The authored session-recovery browser test remains unrun; full
  browser/release acceptance, credential/key migration, Requirement 7.5 and the
  full architecture goal remain open. No staging, commit, push or deployment
  occurred.
- `preloadBlobStreamStorage()` is reexported by `attachmentFileStream.ts` and
  awaited in the existing online idle detail preload. The offline attach/preview
  scenario in `e2e/attachments-offline.spec.ts` is authored and syntax-parsed,
  but browser execution remains unrun. The SDK repair case confirms valid streamed
  storage wins over a corrupt legacy byte record while leaving that record intact.
- Final root tests pass 268 files / 2,745 tests; one opt-in file / two tests are
  skipped (`/tmp/tincanban-encrypted-stream-ultimate-tests.log`). SDK type check
  passes and SDK tests pass 33 files / 363 tests, including 12 stream-store tests
  (`/tmp/tincanban-stream-repair-sdk-types.log`,
  `/tmp/tincanban-stream-repair-sdk-tests.log`). Existing size budgets pass:
  private JS 234.35/239 kB, private CSS 10.74/10.75 kB, public JS 61.08/235 kB,
  public CSS 10.6/10.6 kB, Markdown and all WASM (`/tmp/tincanban-encrypted-stream-ultimate-size.log`).
  Root six-category quality passed after the app changes but before the final
  SDK-only priority adjustment (`/tmp/tincanban-encrypted-stream-preload-quality.log`).
  Final native HTTP passes 6/6 (`/tmp/tincanban-encrypted-stream-ultimate-native.log`).
  Final Worker type check passes and its runtime suite passes 8 files / 120 tests
  (`/tmp/tincanban-encrypted-stream-ultimate-worker-types.log`,
  `/tmp/tincanban-encrypted-stream-ultimate-worker-runtime.log`). Final manifest
  review found three stream/storage entries outside both private and public static
  startup closures. Offline E2E remains unrun.

### Oversized peer-response acceptance scenario — 2026-10-15

- Added Requirement 7 acceptance scenario “Oversized peer response is stopped
  before EOF”: with 256-KiB attachment chunks, an over-limit peer response that
  never sends FIN must fail without partial bytes/cache publication, reset only
  its stream, preserve connection reuse, and still accept an exact-limit chunk.
- Added ordered verification-map row 44 with native `stream_state` and mesh-blob
  `index.test.ts` coverage. The later bounded-read entry records the implemented
  tests and pass results. Legacy cached adapters may ignore `read(maximumBytes)`, so the bounded
  memory guarantee requires compatible adapters and rollout. The specification
  and map now contain 67 scenarios in exact order.

### Bounded peer blob-response reads — 2026-10-15

- `MeshStream.read(maximumBytes?)` now carries an optional u32 read limit through
  the SDK wrapper and raw WASM. Invalid bounds (negative, fractional, non-finite
  or above u32 max) reject; no-argument calls keep the previous unbounded read for
  existing consumers. Application `DuplexStream` and `IrohStream` now alias the SDK
  `MeshStream`.
- `mesh-blob` supplies `ceil(256 KiB / 3) * 4 + 4096` before native reads, then
  checks returned length as a guard for adapters that ignore the bound. The shared
  production `StreamState` reader accumulates ordered pieces in a 16-KiB scratch
  buffer, asks for at most `remaining + 1`, and checks before append. Over-limit
  data fails without waiting for FIN, resets both directions of only that stream,
  and retires its failed runtime handle. It uses the bounded shared read loop, not
  Iroh's built-in `read_to_end`; history consumers retain the old unbounded default.
- A red native no-FIN test first timed out waiting for EOF. Final focused native
  loopback tests pass 5/5; focused transport and mesh-blob tests pass 38/38. The
  SDK suite passes 35 files / 385 tests, and the root suite passes 270 files /
  2,767 tests with one opt-in file / two tests skipped. Logs:
  `/tmp/tincanban-stream-read-limit-red.log`,
  `/tmp/tincanban-bounded-ordered-read-native.log`,
  `/tmp/tincanban-bounded-read-ts-green.log`,
  `/tmp/tincanban-bounded-read-sdk-check.log`,
  `/tmp/tincanban-bounded-read-sdk-tests.log` and
  `/tmp/tincanban-bounded-read-root-tests.log`. At this checkpoint, SDK type check and six-category root quality passed before the
  final app stream type aliases; later final root tests, quality, and app size results
  are recorded in the proof-stream entry below.
- The first bounded-read size attempt measured 2,300,144 bytes, 144 over the
  transport WASM cap. The inline-buffer artifact then measured raw 10,847,978 and
  Brotli 2,299,791 bytes against the 2,300,000-byte cap (209 bytes margin) in
  `/tmp/tincanban-bounded-inline-buffer-final-size.log`. This candidate measurement
  predates the later proof-stream lifecycle edits; the final combined app-size
  check now passes (see the following entry). Cached old adapters may ignore the limit, so they have no memory-bound
  guarantee until a compatible rollout. Browser/E2E remains unrun; Requirement 7.4,
  7.5, credential/key migration and the full architecture goal remain open.

### Bounded peer proof-stream cleanup — 2026-10-15

- Workspace proof-page requests now call the optional bounded read with a 256-KiB
  limit and independently reject an oversized returned frame. The 20-second
  deadline sets an expired state; checks after each awaited open/send/close/read
  prevent stale requests from sending, parsing or caching a response. Timeout
  resets the active stream, late-open completion resets its handle before any
  further operation, and `finally` releases streams on success and failure. The
  reset API is preferred; adapters without it use `closeSend` only when needed.
  No path closes the whole connection.
- Three outer lifecycle regression tests failed before the fix. The corrected
  `workspaceSet.test.ts` cases pass in two files / 43 tests, covering ordinary
  paged bounded reads, a pending-read timeout and a stream opened after timeout:
  `/tmp/tincanban-proof-stream-lifecycle-red.log` and
  `/tmp/tincanban-proof-stream-lifecycle-green.log`.
- The final inline-buffer WASM probe passes at Brotli 2,299,791 / 2,300,000 bytes
  (209-byte margin), raw 10,847,978 bytes. Final combined app-size and six-category
  quality checks pass. Private JS is 234.60/239 kB, private CSS 10.74/10.75 kB,
  public JS 61.07/235 kB and public CSS 10.6/10.6 kB; transport WASM remains in
  budget (`/tmp/tincanban-bounded-proof-final-size.log`). Root tests pass 270 files /
  2,770 tests with one opt-in file / two tests skipped
  (`/tmp/tincanban-bounded-proof-final-root-tests.log`); final SDK type check passes
  (`/tmp/tincanban-bounded-proof-final-sdk-check.log`). The full Rust workspace had
  passed before the layout-only inline-buffer change; current focused native tests
  pass 5/5. Browser/E2E remains unrun;
  Requirement 7.5 and the full nine-requirement goal remain open. No staging,
  commit, push or deployment occurred.


### Rusty archive storage and shared remote transport — 2026-10-15

- Three native HTTP acceptance cases first failed on missing archive endpoints
  (404). Rusty now serves immutable encrypted `/archives/{ciphertextId}` objects
  independently from snapshot and blob inventory/retention. It bounds ciphertext
  to 256 KiB + tag, validates canonical encodings, enforces current scope tokens
  and floor-2 writer policy, and fsyncs namespace/object commits before distinct
  signed archive receipts. Successful responses prohibit caching. Discovery
  advertises encrypted archive storage and bounded batch coverage, not baselines.
- A checkpoint quota regression test reproduced successful retention despite the
  archive taking remaining capacity. Retained replacement accounting now includes
  archives; upload, combined quota, scratch and actual signed checkpoint pruning
  preserve their bytes. Restart and injected directory-fsync failure/retry prove
  exact object reuse without growth. Archive accounting scans on first use after
  process restart; the warm cache is invalidated before uncertain writes. Durable
  bounded accounting remains open.
- The shared browser/Worker remote adapter verifies exact service pin, scope,
  revision, request, ciphertext identity/epoch and receipt purpose. Bounded JSON
  reads cancel over-limit streams; live guards reject stale I/O completion. Two
  red cases reproduced lost HTTP-507 capacity classification with JSON/non-JSON
  bodies; status/code now survive. A redirect case first failed; manual redirects
  and redirected-response rejection now protect credential routing.
- A read-binding test reproduced missing context/position at the archive store
  port. Readers now supply the full workspace/history/index/kind/position/count
  tuple. Equal plaintext hashes at different positions use distinct encryption
  locators. The actual-client test now retains a real signed Automerge change with
  an absent dependency and repeated-content parts. After a lost receipt and actual
  server restart, a fresh IndexedDB handle reloads the earlier harness plan, retries exact
  ciphertext and the cold reader verifies original bytes, change hash/dependencies
  and original author signature. Server disk excludes private sentinels and IDs.
  This describes that earlier storage-only increment; the current native test uses
  `historyPreparationJournal.ts` through the private IndexedDB repository adapter.
  Current journal evidence still does not establish baseline authority.
- Current results: root 276 passing files / 2,841 tests (one opt-in file / two
  cases skipped); SDK 41 files / 456 tests; Rusty 79/79 tests; actual-client native
  HTTP suite 7/7; Workerd nine files / 122 cases, including two new shared archive
  runtime cases. SDK/Worker type checks and all six root quality categories pass.
  Root build/budgets and Rusty formatting pass. Existing negative Workerd RPC
  cases emit expected denial/replay exceptions while their HTTP assertions pass;
  no clean-runtime-log claim is made.
- Evidence logs: `/tmp/tincanban-rusty-archive-http-red.log`,
  `/tmp/tincanban-rusty-archive-capability-red.log`,
  `/tmp/tincanban-rusty-archive-checkpoint-green.log`,
  `/tmp/tincanban-rusty-archive-all.log`,
  `/tmp/tincanban-archive-remote-status-red.log`,
  `/tmp/tincanban-archive-remote-redirect-red.log`,
  `/tmp/tincanban-archive-read-binding-red.log`,
  `/tmp/tincanban-archive-native-repeated-parts.log`,
  `/tmp/tincanban-archive-remote-native-all.log`,
  `/tmp/tincanban-archive-remote-root-all.log`,
  `/tmp/tincanban-archive-remote-sdk-all.log`,
  `/tmp/tincanban-archive-workerd-all.log`,
  `/tmp/tincanban-archive-remote-final-quality.log` and
  `/tmp/tincanban-archive-remote-final-size.log`.
- At this earlier increment, coverage receipts covered at most 64 named immutable
  objects, not a complete catalogue. Aggregate coverage (implemented in the next
  entry), authenticated archive records/catalogue updates,
  source-to-binary preparation integration, durable preparation/activation journal,
  signed Owner baseline transition, bounded active history, old-basis recovery,
  restore/export, host scheduling and compatible release verification remain open.
  No browser/E2E, staging, commit, push or deployment occurred. All nine requirements
  stay in scope; archive tasks 6.1–6.8 and the final implementation gate remain open.

### Authenticated archive coverage tree — 2026-10-15

- The new SDK summary and remote tests first failed on unimplemented summary
  functions and the missing aggregate method. Native HTTP tests compiled and
  failed on an absent capability/route. Rusty now authenticates up to eight prior
  archive receipts and signs the exact scope/policy/root-bound composition.
  Unknown schemas, forged or foreign signatures, stale policy, root substitution,
  overlapping ranges, mixed heights, unsafe counts and depth overflow reject.
  Request bodies are bounded to 64 KiB and individual receipts to 8 KiB.
- SDK confirmation streams strictly ordered encrypted IDs into leaves of 64 and
  branches of 8, promoting short tails with unary branches. Challenges derive
  from the captured transition, authority, root and exact summary. An injected
  lost aggregate reply retries identical challenges and returns identical signed
  receipt bytes. Final verification recomputes the whole expected set; a signed
  subset containing the catalogue root is rejected. The lazy 100,000-object test
  checks the coverage reducer, not active Automerge history or ordinary-write
  performance. The expected set still needs integration with authenticated
  production preparation/catalogue capture.
- The shared HTTP adapter verifies children before network delivery and verifies
  the exact returned summary/request, not just the service signature. A real
  restarted Rusty and a Workerd test both execute the same SDK confirmation and
  complete-set verification. Discovery now recognizes exact archive capability
  contracts; absent advertisements stay absent and malformed/newer contracts
  require upgrade. Its tests first reproduced silently dropped advertisements.
- Current checks: root 279 files / 2,861 tests passed, with one opt-in file / two
  cases skipped; SDK 43 files / 475 tests passed; Rusty 82/82; native-client suite
  7/7; Workerd 9 files / 122 tests. SDK/Worker types, root six-category quality,
  Rusty formatting, required server build and app build/size checks passed.
  Private JS is 234.56/239 kB and CSS 10.74/10.75 kB; public JS is 61.06/235 kB
  and CSS 10.6/10.6 kB; WASM budgets pass without a new core/WASM change.
  Negative Workerd RPC cases still emit denial/replay exception diagnostics.
- Evidence: `/tmp/tincanban-archive-aggregate-summary-red.log`,
  `/tmp/tincanban-archive-aggregate-remote-red.log`,
  `/tmp/tincanban-archive-aggregate-http-red.log`,
  `/tmp/tincanban-archive-coverage-set-red.log`,
  `/tmp/tincanban-archive-capabilities-red.log`,
  `/tmp/tincanban-archive-coverage-retry-green.log`,
  `/tmp/tincanban-archive-aggregate-final-rust-all.log`,
  `/tmp/tincanban-archive-aggregate-final-root-all.log`,
  `/tmp/tincanban-archive-aggregate-sdk-all.log`,
  `/tmp/tincanban-archive-aggregate-native-all.log`,
  `/tmp/tincanban-archive-aggregate-workerd-all.log`,
  `/tmp/tincanban-archive-aggregate-final-quality.log` and
  `/tmp/tincanban-archive-aggregate-final-size.log`.
- Aggregation composes prior durable attestations; it does not reread all files
  or guarantee availability after later corruption. No archive or original
  history is deleted. Production preparation/ciphertext journaling, verified
  Owner baseline authority, atomic activation, bounded active history, restore/
  export and compatible rollout remain open. All nine requirements stay in scope.
  No E2E/browser checks, staging, commits, push or deployment occurred.

### Durable preparation records and host storage adapters — 2026-10-15

- Ten initial journal acceptance cases failed on the unimplemented repository.
  The shared journal now retains exact source bytes and separate staged objects,
  freezes a verified local append chain and expected ciphertext set, then stores
  signed complete coverage. Atomic append publishes the header, binding lookup,
  object and ordinal reference together. A header stays within 16 KiB; objects
  and enumeration use bounded records/pages. No deletion or active-pointer API
  exists. The app adapter uses a separate private IndexedDB database.
- The initial returned-state test reproduced a reference alias that let callers
  change the repository's captured identity; returned identity data is detached.
  Another test reproduced an async publication guard being silently accepted.
  Guards now must complete synchronously and return no value, including inside
  the final storage transaction. The 16-case journal suite covers lost stage and
  final-coverage commit replies, concurrency, quota/guard abort, key/binding
  mismatch, missing/corrupt records, unsupported versions, signed substitutions
  and two-page enumeration of 71 staged objects.
- `MeshStore.scan` now supplies exclusive, bounded prefix pages. An IndexedDB
  test reproduced an array key being coerced into a matching string when an
  all-U+FFFF prefix has no upper bound; non-string cursor keys now stop scanning.
  Five tests cover memory/native IndexedDB semantics and prove that a two-record
  page takes two cursor continuations with no `getAll`.
- The native HTTP fixture now uses the app repository rather than a one-off JSON
  plan. It retains original source bytes, freezes staged objects before network
  delivery, loses an upload response and restarts Rusty. A fresh repository
  handle completes coverage while `crypto.subtle.encrypt` is forced to fail,
  proving ciphertext/request reuse rather than re-encryption. Cold read still
  verifies original signature, exact change bytes/hash/dependencies and pending
  observation. This is source-data/transport evidence, not Native preparation
  or baseline activation authority.
- The Worker storage adapter encrypts each value under a distinct at-rest domain
  with context/key-bound AES-GCM. It snapshots SQL rows before crypto awaits,
  rechecks exact ciphertext and a sync guard inside `transactionSync`, and awaits
  durability. SQL scans fetch only bounded keys, then decrypt values individually.
  Workerd tests use actual Durable Object storage and the same three journal
  phases; competing CAS has one winner, an injected second-write failure rolls
  back the first, and context/key/secret substitution fails without replacement.
  This adapter is not yet invoked by `AutomationReplica`.
- Current proof: root 281 files / 2,883 tests (one opt-in file/two cases skipped),
  SDK 45 files / 496 tests, native client 7/7, Workerd 10 files / 125 cases,
  SDK/Worker types, all six root quality categories and app build/budgets pass.
  Rusty/core/WASM source did not change in this increment; the retained 82-case
  server result is from the preceding aggregate increment.
- Red logs: `/tmp/tincanban-history-preparation-journal-red.log`,
  `/tmp/tincanban-history-preparation-state-alias-red.log`,
  `/tmp/tincanban-history-preparation-async-guard-red.log`,
  `/tmp/tincanban-history-prefix-scan-keytype-red.log` and
  `/tmp/tincanban-history-preparation-workerd-red.log`. Current green logs:
  `/tmp/tincanban-history-preparation-final-root-all.log`,
  `/tmp/tincanban-history-preparation-final-sdk-all.log`,
  `/tmp/tincanban-history-preparation-native-all.log`,
  `/tmp/tincanban-history-preparation-workerd-all.log`,
  `/tmp/tincanban-history-preparation-root-quality.log`,
  `/tmp/tincanban-history-preparation-sdk-types.log`,
  `/tmp/tincanban-history-preparation-worker-types.log` and
  `/tmp/tincanban-history-preparation-size.log`.
- The journal accepts caller-captured bytes and source/authority fingerprints;
  these are not verified Native authority. Authenticated original-record/catalogue
  capture, integration with `VerifiedHistoryPreparation`, ordinary-host scheduling,
  signed Owner transition, atomic active-pointer publication, restore/export,
  bounded active history and compatible rollout remain open. All nine requirements
  stay in scope and 6.1–6.8 remain unchecked. No browser/E2E, staging, commits,
  push or deployment occurred.

### Native original capture and source-derived catalogue — 2026-10-15

- Three positive capture cases first failed on the Native constructor stub
  (`/tmp/tincanban-history-capture-red.log`). Two catalogue cases then failed on
  its writer stub (`/tmp/tincanban-history-catalogue-red.log`).
  `capture_workspace_history` now consumes `VerifiedHistoryPreparation`, validates
  separately supplied original control/proof JSON and retains its exact bytes in
  a private, non-deserializable `VerifiedHistoryArchiveCapture`. It binds those
  bytes and history epoch to the Native admission revision. Unknown/duplicate
  JSON keys, substituted evidence and invalid epochs reject before export.
- An additional red test reproduced an unsafe comparison rule that treated a
  missing signed null as equivalent to a materialized null. Only the unsigned
  outer null `grant` may now be absent. A legacy-compatibility red test exposed
  rejection of omitted defaulted empty control collections; those five unsigned
  container defaults may now be absent, but nonempty evidence cannot disappear.
  Original JSON remains untouched. The earlier revocation test also used an
  invalid timestamp; it now uses a valid millisecond timestamp and asserts the
  specific inactive-signer error rather than accepting an unrelated failure.
- Native `write_catalogue` derives original hashes/dependencies from Automerge
  and observations from its admission plan. It retains source control/proof JSON,
  the exact original save and every pending original, including duplicates and
  compressed encodings. The full save preserves its encoding even though loaded
  per-change bytes are extracted by Automerge. Change records bind workspace,
  history epoch, Native revisions and policy `mesh-causal-admission@1`.
  Proof references/dependency bytes use bounded trees; metadata/page cap is
  64 KiB, binary parts 256 KiB, fanout 64 and depth 32. Sink failure keeps the
  source and repeat export derives identical plaintext. Page buffers are bounded;
  the Native preparation and its change/proof maps still scale with source history.
- Ten new Native capture cases plus ten existing preparation cases pass. They
  include 131 actual changes, 130 proof records, a four-part original with equal
  content at separate positions, repeated pending originals, compressed pending
  bytes, absent legacy fields, forged/substituted evidence and failed writes.
  The full Native core suite passes 242 tests with 3 pre-existing opt-in tests
  ignored (`/tmp/tincanban-history-capture-core-final.log`).
- `examples/history_capture_fixture.rs` reproducibly generates the public shared
  vector `history-capture-v1.json`; regenerated bytes match the checked-in vector.
  Three SDK interop cases lazily fetch one pending original/proof without reading
  source document/control, reconstruct the complete source and rerun actual WASM
  causal admission, and reopen exact ciphertext through a fresh IndexedDB journal
  handle while resealing is forbidden. Full SDK: 46 files / 499 tests; SDK types
  pass (`/tmp/tincanban-history-capture-sdk-all.log`,
  `/tmp/tincanban-history-capture-sdk-types.log`).
- The combined app Native HTTP suite passes 8/8
  (`/tmp/tincanban-history-capture-native-http-final.log`). Its new case stages
  the Native vector through the actual app preparation repository, confirms real
  signed complete Rusty coverage and cold-reads original control, original proof
  and compressed pending bytes with signature/hash/dependency checks. This is
  fixture/transport integration, not a live production Native producer.
- Root types and focused Native-client lint pass. Policy crate checks successfully
  for wasm32 using the project's Rustup toolchain
  (`/tmp/tincanban-history-capture-policy-check.log`). An initial check using the
  unrelated Homebrew compiler failed because that compiler lacked the target;
  no code workaround or target installation was needed. No WASM exports/assets or
  production browser/Worker paths changed. The preceding 2,883-test app aggregate,
  Workerd 125-case result, server 82-case result and app-size proof are retained
  earlier results, not reruns in this increment.
- Remaining: require the Native producer through a live WASM handle and ordinary
  host/Worker scheduling; per-entity authenticated historical indexing; native
  Owner/control-ledger/frontier baseline validation; archive coverage bound into
  the signed transition; atomic active-pointer recovery; bounded active history,
  restore/export and compatible coordinated rollout. Serialized catalogue
  content is not Owner authority. All nine goal requirements remain in scope;
  6.1–6.8 stay unchecked. No browser/E2E, stage/commit/push or deployment occurred.
