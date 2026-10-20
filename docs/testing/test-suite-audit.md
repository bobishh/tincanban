# Test suite audit — 2026-10-02

## 2026-10-20: remove cosmetic browser checks

User direction: retain behavioral scenarios and unit tests; do not start the
application merely to assert button wording, fonts, colors, icon pixels, spacing,
or animation details. Accessible names remain selectors for actual interactions.

Measured [run 39495044034](https://github.com/bobishh/tincanban/actions/runs/39495044034):

| Work | Time |
| --- | ---: |
| Packaging/mobile job, total | 855 s |
| Its serial mobile WebKit suite, 87 cases | 587 s |
| Durable network scenarios | 670 s |
| Core shards, browser execution | 425–644 s |
| Browser installation on the measured Linux jobs | 25–40 s |

The suite listed 560 expanded cases before trimming and 468 afterward. Core goes
from 395 to 336 cases; mobile WebKit from 87 to 54. Every network case is retained.
All 22 durable cases are divided into two disjoint groups of 11, each using one
worker and fresh test processes. Discovery verifies their union equals the
original project. Actual new CI wall time remains to be measured.

Removed 13 presentation-only files: component/brand/detail geometry, Rusty mark
size, column color and fold motion, breakpoint, Sync decoration, window styling,
focus artwork, footer animation, avatar preview proportions, and technical fonts.
Removed direct CSS assertions from retained scenarios. Reduced repeated viewport
passes where the assertion being retained is the same functional operation.

Retained save/retry and draft preservation, profile photo editing, templates,
priority validation, discussion persistence and reply counts, keyboard navigation,
workspace creation, and persistence after a font request fails. Card editing,
stage changes, recovery, and window geometry policy also retain their dedicated
behavioral scenarios and unit coverage. Unit files and coverage floors are unchanged.

Startup diagnostics previously ran in both the core diagnostics step and its
dedicated Chromium/WebKit job. The core diagnostics step now selects only
`telemetry.spec.ts`; startup scenarios remain in their dedicated job.

## 2026-10-08: complete description inventory and CI correction

The [complete inventory](test-description-inventory.tsv) records every test
declaration under `e2e`, `src`, `workers`, application Rust crates and vendored
meta-mesh packages/crates. Generate it with
`npm run --silent test:inventory > docs/testing/test-description-inventory.tsv`.
It records source locations, group names and parameterized declarations. Group
headings, `test.step` and runtime skip calls are excluded. Rust entries are test
function identifiers, not prose titles. Counts below are declarations, not
expanded executions:

| Layer | Declarations | Files |
| --- | ---: | ---: |
| Browser | 318 | 96 |
| Application TypeScript | 665 | 95 |
| Worker TypeScript | 37 | 6 |
| meta-mesh TypeScript | 270 | 27 |
| Application Rust | 6 | 3 |
| meta-mesh Rust | 233 | 47 |

The earlier count of 362 browser descriptions incorrectly included group
headings. Playwright's current main configuration discovers 348 expanded cases,
including Chromium, WebKit and network projects. Dedicated automation and blind
Rusty configurations are separate. `--list` JSON has empty execution results;
its `stats.skipped` is not evidence that discovered scenarios are disabled.

There are no normalized duplicate prose titles across the TypeScript layers.
That does **not** establish semantic uniqueness. Two Rust title pairs occur in
both `catalog.rs` and `handshake.rs`: obsolete claim rejection. They validate
different input codecs and entry points; identical identifiers alone do not
justify deleting either boundary.

### Completed moves, with surviving assertions

| Previous location | Fast coverage / action | Browser or adapter boundary retained |
| --- | --- | --- |
| `e2e/archive-role-settings.spec.ts`, active-card archive assignment rejection | Existing `src/domain/schema.test.ts` verifies exact pointer and error; remove redundant browser case | Archive role/collapse consumer remains; settings JSON still proves visible invalid-draft feedback |
| `e2e/scoped-sync.spec.ts`, standalone expired invitation | Strengthen `src/sync/useDeviceSync.test.ts` with no transport start and no invitation URL | `e2e/sync.spec.ts` retains expiry dismissal and reload/URL behavior; malformed-link UI remains |
| `e2e/card-stage-shortcuts.spec.ts`, missing configured target | Four `src/domain/workspaceSettings.test.ts` cases: missing target, duplicate target, blank label, unknown key; exact errors and unchanged heads/settings | Configured order, successful stage action/reload and failed command feedback remain |
| `e2e/chat-storage.spec.ts`, immutable conflict, 2001-message limit, 4 MiB limit, monotonic cursor | Four `src/chat/storeIntegration.test.ts` contracts execute the real `ChatStore` transaction code against a fresh fake IndexedDB factory | Real cross-tab concurrency, atomic conflicting merge rollback and page reload persistence remain |
| `src/sync/durableMesh.test.ts`, three direct `createMeshRuntime().admitSession()` matrices | Move complete cases into `vendor/meta-mesh/packages/mesh-runtime/src/index.test.ts` | Application install/session adapter, stale cleanup and real multi-tab Iroh tests remain |

Seven browser cases moved/removed after equivalent fast assertions were verified.
The three runtime matrices changed ownership; root Vitest still executes them.
Do not describe this as seven browser tests' measured CI savings: local ChatStore
harness tests were already short, and no runner-equivalent before/after timing
was collected.

### Semantic overlap decisions

| Family | Shared logic / setup | Decision and distinct risk |
| --- | --- | --- |
| Device synchronization: `sync`, `scoped-sync`, `workspace-roles`, `member-access`, `workspace-sync-data`, `durable-mesh` | Pairing fixtures, grants, validation and reconnect decisions | Move pure decision matrices; keep actual admission, role UI, durable receive/no ACK, failed storage/replay, revocation and persisted trust. Repeated pairing setup is not proof of duplicate assertions. |
| Succession and authorization | Rust core + `mesh-workspace` policy cases + app planner/guard fixtures | Keep named and quorum UI flows plus app atomic authority/scope/revocation persistence. A Rust policy result does not prove the application's durable commit. |
| Session selection, route/ACK and anti-entropy | `mesh-runtime`, `mesh-peer-store`, `mesh-replication` and app wrapper tests | Protocol matrices belong to meta-mesh. Keep app translation/state/error contracts and a real transport proof. Three direct runtime proxies moved; other wrappers require matching adapter assertions before deletion. |
| Identity and proofs | Certificate/grant/genesis/canonicalization rules in app and mesh libraries | App `proofs.ts` still has an independent verifier/signing implementation. Deleting its tests would conceal that duplicate implementation. Unify implementation first; preserve app ProofStore and automation scope contracts. |
| Chat/storage | Identity predicate, retention rules, transaction code, browser storage | Pure policy and transaction matrices can run fast. Keep actual browser concurrency, commit rollback and durable reload. In-memory IndexedDB does not prove browser disk persistence. |
| Schema/settings/priority/custom fields | Domain validation and derived calculations | Move exhaustive invalid values/decision tables; retain UI consumers, visible validation feedback, draft preservation, failed Apply and reload. Check every surviving consumer assertion before merging a large “all settings” story. |
| Layout, input and responsiveness | Repeated board/card preparation, viewport sweeps | Units cannot prove DOM geometry, focus/inert, touch/pointer, scroll lock, animation or timing. Consolidate preparation within bounded stories; preserve distinct viewport and failure branches. Archive's four-width sweep already shares one setup. |
| Discussions, references and Markdown | Parsing/formatting/domain units + repeated content fixtures | Keep rendered links/source navigation, pending send/copy, multi-window focus/geometry, offline UI and contextual peer interchange. Move only exhaustive parser/format matrices. |
| Startup, workers and migrations | Schema/migration planner units, package stores | Keep actual worker boot, upgrade blocking, app publication after IndexedDB commit, multi-tab serialization and failed startup recovery. Memory adapters and protocol models do not cover these boundaries. |
| Rusty, native and external automation | Shared protocol rules and service fixtures | Keep actual service contracts. Do not replace native admission/transport/disk tests with JS proxy tests. Production automation requires its own authorized external fixture. |

All descriptions were reviewed for overlap. Assertion-body comparison focused on
suspected duplicates and proposed migrations; this is not a claim that every
remaining browser assertion has been proved unique or every candidate migrated.
The concrete reductions above are implemented; broader merges require preserving
the listed boundaries and collecting new execution evidence.

### Measured cause of the long CI and current configuration

[Run 37799579672](https://github.com/bobishh/tincanban/actions/runs/37799579672)
took 43m37s wall time. Static checks took 2m36s; formal models 45s. The four UI
shards spent 434, 350, 305 and 359 seconds inside Playwright, approximately
24 minutes combined test work. The serial network step spent 1406 seconds.
The old Rusty job took 8m02s, including a failed lifecycle case. These are actual
job/step timings, not predicted savings.

Replacing the suite with an arbitrary nine-test smoke was rejected and reverted.
The current workflow retains full core/network coverage and manual dispatch of
the same checks. Independent jobs have no `needs` chain; separate network
project runners may run three at a time. Core still uses four shards because
removing them before reducing actual test work would increase elapsed time.
The network matrix now also includes schema migration; native verification
includes the application lighthouse join cases and Rust core rules. WebKit
checks run in the packaging job. Static quality, coverage floors, bundle budgets,
security audit, formal models and production policy packaging remain.

Root Vitest includes vendored package tests once, excluding workspace symlink
copies in `node_modules`. `verify:meta-mesh` only checks the Git pin/clean tracked
files; it is not a protocol test command. Native CI now explicitly runs
`cargo test --locked --manifest-path vendor/meta-mesh/crates/meta-mesh-core/Cargo.toml --lib`.

The removed protocol-1 Rusty lifecycle job targeted a deleted Playwright project
and cannot test the new blind-storage implementation. The current blind Rusty
scenario passes locally with its matching sibling binary; publishing a pinned
protocol-2 fixture remains necessary for equivalent GitHub verification.

### Verification and limits

- Full root unit coverage after the final loading changes: **1053 passed, 1 skipped**, 122 files, 5.27s local elapsed; statements 50.04%, branches 45.23%, functions 48.36%, lines 54.83%. Original floors retained.
- Rust core rules: **185 passed, 3 ignored**, 13.64s test execution. Ignored tests are not claimed as verified.
- Four migrated ChatStore contracts: **258 ms** test execution. Remaining browser storage/stage/archive checks: **7 passed**, 10.3s local elapsed.
- Blind Rusty connect/sync/server-stop/removal/reload: **1 passed**, 4.3s local elapsed after lazy-loading changes.
- Pairing/QR and failure recovery: **7 passed**, 19.3s. Production policy/transport packaging: **3 passed**, 4.6s. WebKit mobile layout, safe area and failure recovery: **8 passed**, 13.3s.
- Static quality passes. Initial JS was 238.59 kB against 235 kB; QR generation and Rusty replication/enrollment/automation now load on demand. New initial JS **229.14 kB**; all original size caps pass.
- The two application native lighthouse join histories **fail** at live replication after successful join. Native logs report `read error: connection lost`; one test fails before reaching its owner-offline phase. Their exact adapter/transport fault remains undiagnosed. These failures are retained and exposed by automatic CI, not deleted as duplicates.
- Workflow/project structure was checked locally. No GitHub run of this revised configuration exists yet; no remote timing or green CI is claimed. The dirty meta-mesh checkout prevents the clean-pin check until its changes are explicitly committed/pinned. No commits or pushes were made by this audit.

The sections below are historical evidence; their counts and old CI topology do
not describe the current checkout.

## Baseline and limits

Before reduction, core contained 176 independently expanded scenarios. The inventory [core-scenarios.tsv](core-scenarios.tsv) now tracks the current suite. The earlier statement that CI passed 179 scenarios was incorrect: log numbering included retries. GitHub run `36991147079` was cancelled at its ten-minute job limit, before Playwright printed the final failure report.

That log already showed five distinct failing cases: detailed-card performance/durable reload, mobile device-list scrolling, fast-startup loading indicator, and telemetry with HTTP 202 and 503. The performance measurements themselves were 168 and 190 ms, below the unchanged 200 ms gate; failure occurred after that measurement. Cancellation must not be presented as the only issue.

Unit coverage is a separate scope. It cannot justify deleting browser tests: it does not execute Vue or prove focus, layout, drag/drop, persistence wiring, or network delivery. Per-scenario main-thread JS coverage is supporting evidence only; identical execution can still assert different outcomes. CSS, Workers, WASM, extra browser pages, and the uninstrumented performance benchmark need behavioral review.

The complete local baseline in CI mode took 354 seconds: 172 clean passes, three failures (fast-startup indicator and both telemetry cases), and one authority-isolation case passed only after retry. Follow-up evidence identified fixture and configuration problems, not redundant assertions:

- Workspace creation helper returned immediately after clicking Create. An owner badge from the previous workspace could satisfy the next assertion; the test then corrupted the wrong workspace. It now waits for the closed form and the new workspace board.
- Permission validation showed its loading indicator immediately, bypassing the existing progress delay. The same delay now covers access checks; card aging helpers moved out of the oversized root component without raising its size limit.
- Diagnostics tests depended on an ignored developer environment variable. Playwright now supplies an intercepted test-only intake URL.
- The performance gate remained below 200 ms in the failing GitHub attempts. CPU slowdown now ends before the separate cold-reload durability check; the performance threshold is unchanged.
- Mobile device scrolling injected a synthetic list and guessed a Vue scope attribute. It now mounts the actual dialog with device data, retaining scroll-lock assertions.

A 15-scenario browser coverage sample was collected for mobile navigation, favicon, compact breakpoint and storage cases. In that selected group, the normal-storage smoke and middle-width navigation had no uniquely executed JS statements. The compact breakpoint boundary scenario had six. The failed-startup favicon case had no collected application module, so its contribution is marked unavailable rather than redundant. Assertions, layout and failure semantics still determine any deletion.

## Candidates for the next reduction pass

No scenarios have been deleted in this audit. These are reviewed candidates, not automatic deletion decisions.

| Candidate | Action to evaluate | Coverage retained elsewhere / unique risk to preserve |
| --- | --- | --- |
| `mobile-nav.spec.ts`: full 390px drawer flow | Keep full flows at 360px and 430px; reduce middle width to geometry smoke if needed | All three execute the same assertion sequence. Preserve smallest/largest widths, focus/inert behavior, Settings handoff, backdrop and Escape. |
| `favicon.spec.ts`: successful startup icon case | Remove only if the failed-startup case retains identical SVG pixel/decode checks | Both call the same `faviconLoads` assertions. The failure case also proves independence from app startup. |
| `storage-upgrade-block.spec.ts`: normal-storage startup smoke | Merge/delete generic smoke | Blank-startup and owner-after-reload flows already assert functional controls; preserve every legacy upgrade, blocked open, conflict, and recovery scenario. |
| `storage-failure.spec.ts`: basic item-save failure | Fold checks into mobile failure/retry flow in `interaction-polish.spec.ts` | Preserve exact alert, draft, no published card, retry, exactly one item, save-state recovery, durable reload. Basic test has less behavior, but viewport is a distinct consideration. |
| `board-drag-drop.spec.ts`: basic failed card move | Consolidate with detailed-board failure/retry in `card-move-performance.spec.ts` | Preserve source placement, empty destination, failure notice, retry and durable reload. Keep filtered-board failure separately: hidden cards/ghost cleanup are distinct. |
| `board-breakpoint.spec.ts`: compact search/reset case | Fold empty/reset assertions into the existing 640→560→561 boundary flow | Preserve compact geometry and no phone navigation at 640px; desktop/mobile filter tests cover different layout branches. |

Expected savings from these candidates are modest. They do not explain all runtime and cannot replace CI isolation. Core now has two independent shards, each with one worker; failed shards upload traces. Network suites keep their existing isolation.

## Keep: distinct risks

- Pointer drag versus touch scroll, release over a header, exact rank/order after reload, and column reordering.
- Filtered versus unfiltered moves, incoming refresh during drag, filter cancellation, ghost cleanup, unaffected DOM, storage failure/retry.
- Atomic IndexedDB commit versus UI publication, migration versus upgrade blocking, overlapping peer admission versus same-device tab contention.
- Owner/editor/visitor roles, forged evidence, revocation, pending authority, offline recovery, durable acknowledgement, and replay.
- Required-field UI validation versus domain validation: keep one meaningful UI example; move exhaustive value matrices to unit tests where appropriate.
- Modal focus traps, inert background, scroll lock and interrupted handoff: source coverage alone cannot establish those outcomes.

## Cost observations

The interrupted GitHub log recorded roughly 30 seconds in filtered-board layout, 27 seconds in drag/drop, and 26 seconds in workspace flows, counting only passing attempts captured in the log. Retries, setup, polling, cold worker startup, and tests not reached are excluded. These are partial observations, not complete suite timings.

Several layout tests create/configure a board and multiple cards through the UI for every assertion. Faster fixture preparation is a candidate after retaining at least one end-to-end creation flow. Removing assertions is not the first response to expensive repeated setup.

## Reduction protocol

1. Collect passed per-test browser coverage for the candidate and proposed survivors.
2. Record assertions and unique user-visible failure each protects; inspect branches, layout, and side effects that JS coverage misses.
3. Delete/merge one reviewed candidate group; compare execution coverage and retain required unique assertions.
4. Run survivors with happy plus failure/pending state; verify durable reload and affected network paths where applicable.
5. Measure actual runtime savings. Keep the change only if protection remains meaningful.

Final local verification retained all 176 core scenarios: both 88-case CI-mode shards passed with no retries (154 and 131 seconds in the recorded runs). Authority isolation passed five consecutive repetitions. Owner/editor and owner/visitor network scenarios also passed. Unit coverage ran 754 passing tests with one skip; static quality, bundle budgets and dependency audit passed. Negative probes confirmed fresh unsafe `any` fails lint and an unmet coverage floor fails the test command. The optional browser collector also passed early-page-close teardown verification without changing the scenario result.

## Follow-up: consolidate setup into user stories

Requested scope: audit repeated preparation and propose multi-action, multi-card and multi-user histories. This section changes no executable tests. A shard splits existing tests between separate runners; it reduces elapsed time by parallelism, not repeated work. Story consolidation addresses the repeated work.

### Measured cost

Source: the two successful local CI-mode JSON reports for commit `4f690a0` (`/tmp/match-core-shard-1.json` and `/tmp/match-core-shard-2.json`). Durations below sum test attempts per file; they are not elapsed CI time, isolated setup measurements, or predicted savings. All 176 scenarios passed without retries in these reports.

| Group | Scenarios | Summed local test seconds |
| --- | ---: | ---: |
| Filtered board layout | 8 | 22.8 |
| Workspaces | 13 | 21.2 |
| Detailed-card performance | 3 | 16.3 |
| Board drag/drop | 8 | 16.0 |
| Card narrative races | 4 | 10.6 |
| Interaction polish | 9 | 10.2 |
| Workspace worker admission | 4 | 10.0 |
| Remaining UI polish | 9 | 10.0 |
| Inline add | 2 | 8.9 |
| Configured workspace creation | 6 | 8.9 |

Static searches across all spec files found 189 `page.goto(`, 87 `.reload(`, 43 `.newContext(`, and 96 `.newPage(` call sites. These include helper bodies and loops: they are not runtime counts or evidence that every call is wasteful. Explicit `waitForTimeout` has eight call sites; touch gesture timing accounts for some. There is no evidence that removing sleeps alone solves suite cost.

### Concrete consolidation map

Each proposed story owns fresh state and named `test.step` phases. Share setup **within** a story, never mutable pages between independent tests. Use several named cards so failure, restoration and successful edits do not accidentally assert against the same ambiguous locator. Every fault injection must be restored and recovery asserted before a later phase.

| Current source and repetition | Proposed story | Assertions that must survive / boundary |
| --- | --- | --- |
| `filtered-board-layout.spec.ts`: eight calls to `createBoard`, each creates a board, adds an Owner field through JSON and saves three cards through UI | Desktop filter story: one-column status + context + overview → close → two-column search/geometry → empty result → reset → filtered move with preview → hidden card survives → reload. Mobile layout story remains separate. Failed drag → recovery can be one fault story. Refresh-during-drag and the two cancellation directions remain targeted race probes. | Preserve desktop width, context widths/opacity, mobile navigation absence, hidden-card count, exact source/destination and ghost cleanup. Clear filters and close dialogs between phases. Source-disappears and destination-disappears cancellation are distinct. Do not collapse all eight into one chain. |
| `archive-layout.spec.ts`: identical full flow at 1920, 1440, 1024 and 390px, recreates job board each time | One responsive archive story, loop through all four widths on one board; open/close archive at each width. Add compact/phone boundary and search/reset phases from `board-breakpoint.spec.ts` only with explicit reset of selected column and filters. | Retain six-column geometry, no document overflow, archive colors, expanded equal width, collapsed 76px width, 560/561 navigation boundary and 640px empty/reset. Fresh mobile *touch context* tests are not replaced by resizing a desktop context. |
| `board-drag-drop.spec.ts`: five desktop tests repeatedly create a blank board and cards | One normal desktop ordering story: create three cards → hover/drop into empty column → cross-column order → same-column reorder → column reorder in edit mode → reload final state. Failure/retry is a second story, potentially consolidated with the detailed-card failure probe. | Assert full ordered ID/title arrays at each mutation, empty hint during hover, notices, durable final order. Keep three touch tests separate from pointer story. Keep measured performance isolated from unrelated steps. |
| `workspace-settings-json.spec.ts`: four identical blank-board/dialog setups | One configuration story: invalid entity name → exact validation path → repair → second-archive rejection → repair → apply title/entity/fields/templates + renamed archive → reload. | Disabled Apply must leave committed config unchanged. Prove repaired draft applies all intended fields; current happy test only checks a subset. Required-field value matrices belong in domain unit tests, while UI retains an actionable example. |
| `card-edit.spec.ts`, `card-stage-shortcuts.spec.ts`, `history-restore.spec.ts`, `rejection-notes.spec.ts`: each helper creates board and item anew | Two coherent lifecycles: generic card (create → shortcut → reorder → failed restore → successful restore → reload); job lead (create → edit → rejected → notes → failed save → retry → reload). Several cards exercise neighbor preservation. | Generic versus job-specific forms remain distinct. Slow-save/newer-draft and narrative races retain explicit controlled scheduling in separate probes. Do not replace debounce assertions with merely eventual text visibility. |
| `chat.spec.ts`: paired message/offline history and typing story each perform invitation and owner approval | Extend existing paired chat history with typing/device-count/no-message phase **before** sending. Then send, verify delivery, toast, replay deduplication, offline recovery and private workspace separation. | Existing test already combines many useful behaviors; consolidate the repeated pairing, not remove assertions. Verify typing clears before subsequent phases. Keep local storage/signing and unavailable Markdown faults separately recoverable. |
| `member-access.spec.ts`: already one visitor → editor → revoke → cancelled reconnection → approved reconnection history | Retain as model for coherent multi-step access story. Add actual edit/denied edit verification if replacing overlapping role scenarios. | A promoted visitor does not prove direct editor invitation admission. Preserve direct editor/visitor admission until their different paths are explicitly exercised. Ownership transfer and quorum succession are destructive authority transitions, separate stories. |
| `durable-mesh.spec.ts`: repeated `pairWorkspace` across transport stories | Candidate normal transport history: paired edits → one reload → tab close/return → queued edits → offline edits on both sides → convergence. Fault family remains separate: real node failure, dropped notification, receive persistence failure/no acknowledgement, unsigned change rejected without disconnect. | Reload, closed tab, offline browser, real Iroh node close and lost transport catalog are different recovery mechanisms. Preserve checkpoints/counters per mechanism. Do not treat same final card visibility as equivalence. No network duration estimate: no complete timing report reviewed here. |
| `telemetry.spec.ts`: same startup/send/reload sequence for HTTP 202 and 503 | One diagnostic resilience history with switchable intake status and two distinct message IDs, isolated captured event batches and one final reload. | Await first batch completion before switching status, assert both records/events and content exclusion, recovery queue behavior separately. Persistent retry state may make separate cases cheaper to diagnose; measure before selecting survivor. |

### Wrong layer and scheduling

1. `playwright.config.ts` assigns all of `sync.spec.ts` and `chat.spec.ts` to network projects. Inspection shows many tests there need no paired peer: startup shell, PDF artifact validation, archive/filter layout, desktop/mobile geometry, chat resize, local persistence and local signing failure. Move those cases to core/local stories; leave actual pairing and real delivery in network projects. This removes local work from the 13-project serial network queue without claiming any scenario is redundant.
2. `chat-storage.spec.ts` runs seven real IndexedDB tests but navigates to the full app before importing `ChatStore`. `storage-atomicity.spec.ts` similarly boots the app even for its first two storage-only transaction cases. Use a minimal same-origin browser harness for these cases, following `storage-offline-shape.spec.ts`; preserve real IndexedDB transactions, cross-page behavior and durable reopening. Cases using `useTincanban`, signed admission or UI publication still require app boot.
3. Typed fixtures can prepare unrelated layout boards through existing commands/storage rather than repeated form submission. Retain genuine board/card creation and schema editing UI in the lifecycle stories. Generate fresh identities and signed state through supported application APIs; copying only IndexedDB or a browser storage-state file is not an established valid peer fixture. Cached runtime workers, channels and crypto identity make global browser sharing risky.
4. Unit/API checks should own exhaustive combinatorial input validation. Browser stories retain validation messaging, disabled actions, pending state, failure/retry, wiring and persistence. Real browser storage and real transport tests stay at their integration layer rather than being replaced by mock-only unit assertions.

### Assertion audit: concrete overclaims

- `history-restore.spec.ts` second test says “retry works” but only injects failure, checks alert, closes and checks current placement. It never clears the failure or retries. A consolidated history must add recovery and reload before claiming retry coverage.
- `board-drag-drop.spec.ts` cross-column “exact placement persists” test checks only destination visibility; its destination starts empty. The same-column ordering test checks only the first card. Preserve these flows but strengthen full order/count and unaffected neighbors before using them to replace tests.
- `workspace-settings-json.spec.ts` “changes all settings” changes fields and document templates but asserts title, entity label, column and reload label only. Verify configured fields/templates through their user-visible consumers in the configuration story.
- Source-coverage uniqueness cannot reveal these assertion gaps. No conclusion about all 754 unit assertions follows from this limited browser review.

### Execution order for a later reduction pass

1. Resizing/archive and settings validation→repair histories: limited state coupling; retain assertion checklist and compare reports.
2. Filter layout: highest measured local group cost, repeated three-card setup proven in source. Consolidate desktop layout and successful move, keep race branches separate.
3. Minimal browser storage harness and local/network file split: remove irrelevant boot/queue work without weakening behavior.
4. Generic/job card lifecycles and paired typing/chat: named cards/users, explicit recovery and intermediate durable checks.
5. Transport consolidation last: transport state recovery and acknowledgement invariants make broad merged chains risky.

Measure phase setup, execution, retries, total runner seconds and elapsed CI separately. Compare before/after with the same runner configuration and passed-attempt coverage; changed assertion counts and unique risks must be reviewed. No savings target or reduced test count is asserted before a trial run. No scenarios were deleted or merged by this audit.

## Implemented first reduction pass

The follow-up plan above preceded implementation. This pass consolidates coherent histories, not arbitrary independent tests:

- Archive widths: four cases → one story, retaining every width/open/close/geometry/color assertion.
- Compact breakpoint: two cases → one resize/search/reset story.
- Settings JSON: four cases → one invalid→repair→apply→reload story. Added required Author validation/recovery, persisted Author value and template preview checks.
- Desktop filtered layout/search/move: three cases → one story; mobile, failed drag, incoming refresh and both filter cancellation directions remain independent. File total eight → six.
- Desktop ordering: four happy cases → one three-card/card-and-column story. Added full ordered arrays, unaffected neighbors, and durable final column order. Failure remains separate, now includes retry/reload. All three touch cases remain separate.
- History restore: two cases → one failed restore→retry→reload story. Recovery is now actually exercised.
- Seven ChatStore and two storage-only transaction cases retain real browser IndexedDB but use a script-free same-origin harness. Remaining four atomicity cases still boot the application.
- Eight local chat and eight local board/startup cases moved out of the serial network projects into `chat-local.spec.ts` and `board-local.spec.ts`. Paired chat now includes typing before message delivery on the same connection. Its offline, toast, replay and private-workspace assertions remain.

The selected eight-file reduction group went from 41 to 28 scenarios. Serialized uninstrumented runs on the same local machine, one worker, zero retries: **64.946 seconds before; 46.996 seconds after (27.6% shorter)**. Reports: `/tmp/match-story-before-timing.json`, `/tmp/match-story-after-timing.json`. This is one local pair, not a statistical benchmark or a prediction for all CI. Core test count grows when local network-project cases move into it; total count reduction and scheduling changes must be distinguished.

### Coverage comparison and collector correction

Initial comparison showed restore handlers disappearing from coverage despite both failure and success assertions passing. Raw Chrome data reported `restoreSelectedItemVersion` and `restoreItemVersion` count zero after reload; the standalone failed case without reload reported a call. Collection now checkpoints before explicit `page.goto` and `page.reload`, retaining old-context counts. Isolated probes confirmed calls survive goto, reload and an early page close after a checkpoint. Closed-page final context remains unavailable; earlier checkpoints survive. These checks were temporary plumbing probes, not extra product scenarios.

Corrected passed-attempt reports: `coverage/story-baseline-corrected/` (41 cases) and `coverage/story-after-corrected/` (28 cases), both with 154 loaded source files. Selected-group line coverage is 61.96% before and 61.44% after. This decrease was reviewed rather than hidden:

- Raw named-function calls lost from the sample are app/mesh teardown and cleanup, consistent with removing full application boot from storage-only cases. They are not asserted cleanup regressions; lifecycle/network tests retain their explicit cleanup behavior.
- Converted source locations also differ for Vue template handlers and field/range filter function bodies. Raw `updateField`/`updateRange` call counts were zero in both groups: the apparent baseline coverage is not evidence these interactions had been tested. Thus source-line attribution alone cannot certify equivalent assertion strength.
- Raw restore handler counts are two before and two after after the checkpoint fix; the new story now proves actual successful retry and durable restoration, unlike the original failure case.
- Added execution includes required-field validation, schema repair, and modal handling. `coverage/story-after-corrected/comparison.json` records converted location differences for review.

No percentages were padded by excluding production files or adding redundant tests. Main-thread sample coverage remains a review aid; assertions, raw counters, real IndexedDB/network checks, and the uninstrumented performance gate provide different evidence.

### CI failure discovered during reduction

GitHub run `37005478976` passed both core shards, verify and native Rust peer, but failed the existing workspace-roles snapshot-preparation failure case twice. The guest retained the injected terminal cause; the owner showed reconnecting with no alert. Local reproduction confirmed generic live recovery cleared the non-network admission error. A scoped `WorkspaceAdmissionFailure` now preserves the host cause while cleaning up and adopting durable mesh; ordinary network and already-admitted session recovery remain unchanged. Existing browser failure plus owner/editor happy flow passed, with unit checks for terminal cause after successful and failed handoff. The failing assertion was retained.

The first full reduced-core run passed 178 cases and failed the relocated Markdown-unavailable chat case after reload. Trace showed board readiness completed before Chat opened: this was not evidence of an empty workspace ID. Its initial text assertion passed on an optimistic pending message, then the test immediately reloaded before signing/storage finished. The scenario now awaits absence of the pending marker before checking durable text and reloading; all eight local chat cases passed twice without retries. No startup/hydration product change was made for this fixture issue.

### Final verification

Final core run: **179/179 passed**, two shards with one worker each, zero retries, alternate ports; shard durations 3.2 and 2.7 minutes. This is local elapsed time, not measured GitHub runner time. Unit coverage run: 756 passed, one skipped across 81 files; lines 51.44%, branches 41.30%, existing global floors passed. Full quality checks and initial JavaScript size gate passed (234.71 kB against 235 kB). Relevant network chat/sync cases passed (8 cases), as did the unchanged workspace-role admission failure and owner/editor happy flow. Full network matrix remains a CI responsibility; these focused runs do not certify every network scenario.

### Follow-up CI measurement isolation

Run 37021109106 passed verify, native peer, and core shard 2, but core shard 1 failed the responsiveness gate (271 ms, retry 239 ms) and second-tab readiness. The latter failed before concurrent writes: the second page still showed “Checking workspace access” after five seconds. It now explicitly awaits startup readiness with the same 15-second budget used for cold detailed-board reload; concurrent write and durability assertions remain unchanged.

Both CPU profiles contain roughly 289 ms cumulative self time in Playwright's `visitNode → captureSnapshot` stack. Cumulative samples cannot attribute the exact longest-task boundary, but show recorder work inside the measurement. Responsiveness now runs in a separate file with trace recording disabled; its CPU profile, 4× throttle, DOM identity checks, cold durability check and 200 ms gate remain. Failed storage/retry and two-tab durability keep failure traces. Optional source coverage also excludes the new performance file. This is measurement isolation, not evidence of a new production performance improvement.


## Interaction hot-path audit and correction

The next run, `37022516078`, still failed both core shards: move long tasks were 250/278 ms despite trace being disabled, and the two-tab case timed out during the final cold reload. Disabling trace alone was insufficient. The measured interval also included role-based accessibility queries, whose Playwright snapshots walked all detailed cards. The move benchmark now uses physical pointer input and CSS checks during measurement, captures long tasks before accessibility assertions, checks board/neighbor DOM identity, then checks durable reopening. The 200 ms budget remains unchanged. Cold detailed-board access checks use 15 seconds; concurrent-write assertions remain intact.

A separate isolated 55-card, 4× CPU probe measured Chat pointer Event Timing at 1064–1112 ms. Its CPU profile showed full Automerge save/load solely to retrieve the chat-room identifier. The audit found additional avoidable work:

- Chat room, owner and attachment metadata now read the authoritative active document directly; inactive workspaces still load durable documents. Actual network snapshot serialization remains.
- Content changes verify active workspace access without reloading every inactive workspace. Catalog, readiness, ownership/authority and identity invalidation still verify the whole catalog. Deferred-result tests cover stale role results and retained access errors.
- Local commands use an exhaustive typed capability map before dispatch rather than canonicalizing and diffing entire documents. Incoming network/import transition validation, ownership checks, command validation and signed change authorizations remain.
- Successful local writes no longer write a second legacy projected workspace. Catalog refresh reads active/archive entries together. Focus reconciliation reuses matching active heads while still replaying later journal changes. Catalog recovery now uses typed helpers; eight obsolete unsafe lint suppressions were pruned, with no new allowances.
- Board presentation indexes notes/leads and children, caches filtered/sorted column arrays, and skips narrative search construction for an empty query. Ancestry follows parent IDs with cycle detection rather than enumerating all entities for each path.
- Restore uses a causal Automerge view at the selected recorded hash rather than replaying full history snapshots. A concurrent-branch regression checks the selected version and retained history; the browser story checks failure, retry and durable compensation.
- Optional settings participants and hierarchy move dialog load on demand. Their loading does not defer Chat or Sync. No feature or bundle threshold was removed.

### Verification evidence

Quiet isolated final timing run, one worker, no trace/coverage, 55 detailed cards, 4× CPU: move longest main-thread task **70 ms**; Chat pointer Event Timing **64 ms**, click-to-dialog paint **64 ms**; Sync Event Timing **40 ms**, click-to-dialog paint **110 ms**. These are different metrics, not interchangeable INP claims. Earlier repeated Chat checks gave 64–72 ms. This is controlled local evidence, not measurement of the user's production workspace or fleet-wide field INP. Chat metadata failure leaves an error and the next card interaction works.

Selected affected browser histories: 47 cases covering access refresh, drag/filter cancellation and incoming refresh, archive, notes/search, restore, storage failure/atomicity, workspace catalog and hierarchy. Forty-six passed in the initial run; one filter case was interrupted by an App.vue hot update visible in its trace, then passed on frozen code. No product assertion was removed for that interruption. All four isolated performance/failure cases passed. Network Chat, Sync, workspace roles and member access passed: 14 cases, including owner/editor/visitor controls, decline, terminal admission failure, promotion and revocation. Controlled paired-chat delivery was 187 ms; this does not diagnose earlier production delivery incidents.

Full local quality checks passed. Unit coverage: 768 passed, one skipped, 85 files; lines **51.58%**, branches **41.43%**, all original floors retained. Initial JavaScript **234.90 kB Brotli** against **235 kB**. Core inventory contains 183 scenarios. A full local core rerun was unnecessary after these focused checks; the existing CI workflow retains the full browser matrix. Remote CI status and deployment are recorded separately from these local results.


### Remote runner follow-up: drag animation and cold Sync

Run `37028830991` passed verify, native Rust peer and core shard 1; core shard 2 failed move tasks at 220/225 ms and cold Sync appearance at 423/204 ms. Chat passed at 72 ms. The prior local results did not establish runner-equivalent responsiveness.

The move profile contains approximately 127 ms of Sortable sibling-animation geometry work. Sortable captures rectangles for every child, including add-gap nodes, and forces detailed-card layout. Card dragging now disables sibling FLIP when more than 40 draggable cards are actually rendered, counting once at setup. Smaller or filtered/collapsed boards retain the existing 180 ms animation; reduced-motion behavior and insertion-gap animation remain. The benchmark explicitly sets no reduced-motion preference and flushes pending observer records before closing measurement. An empty long-task list means no recorded task reached the browser's 50 ms reporting threshold, not zero processing time.

Sync's failed runner sample had **64 ms Event Timing**, despite waiting up to 423 ms for its lazy module and contents. The dialog now shows an immediate pending shell, with dismissal and explicit load-failure/reload recovery. The performance story separately reports first feedback and eventual controls readiness: the existing **200 ms** interaction/first-paint budgets remain; the controls-ready value has a distinct 5-second failure deadline. A loading shell is not counted as completed controls. The failure story verifies dismissal while loading, board interaction, error closure, reload and successful recovery.

Final isolated local checks: 16 affected drag/filter/modal stories passed, including the Sync failure history; the separate no-reduced-motion move check recorded a longest task of **70 ms** at 4× CPU. Modal sample: Chat **56 ms** Event Timing / **50 ms** ready; Sync **56 ms** Event Timing / **55 ms** pending feedback / **113 ms** ready. Another quiet sample recorded move 68 ms. These measurements do not claim cold content downloads complete in 200 ms on all machines. All seven network Sync scenarios passed after the wrapper change. Full quality and unit coverage still pass: 768 tests, one skipped; lines **51.55%**, branches **41.44%**. Bundle **234.93 kB Brotli** against unchanged 235 kB budget; one additional obsolete unsafe suppression removed. Core inventory now contains 184 scenarios.

### Initial bundle follow-up

Run `37033089458` passed quality and all 768 unit tests, then stopped at the size gate: initial JavaScript was 235.01 kB, exceeding the unchanged 235 kB budget by 13 bytes. Browser jobs were skipped. The preceding local 234.93 kB sample had insufficient headroom for build metadata/chunk variation.

Document attachment controls now load on demand from both generic item detail and legacy lead detail. The item-detail shell remains eager; a shared pending/error component provides feedback and explicit reload recovery. Existing editing and real-file preview/download stories plus delayed-load failure, dismissal, reopen and reload recovery pass (3 cases). Initial JavaScript is 233.8 kB Brotli, with approximately 1.2 kB headroom; the attachment chunk is separate. No threshold was raised. Core inventory contains 185 scenarios. Remote verification and release status remain separate from local results.

### Network follow-up: archive readiness and identity fixtures

Run `37034633358` passed verify, all 185 core scenarios, native Rust convergence/revocation, Chat, durable-mesh (20 cases), member-access, Sync (7 cases), workspace roles and workspace data sync. Runner measurements: move longest task 136 ms at 4× CPU; Chat Event Timing 88 ms / dialog ready 70 ms; Sync Event Timing 136 ms / pending paint 132 ms / controls ready 265 ms. Verify ran 768 unit tests; coverage lines 51.53%, branches 41.41%, unchanged floors passed; initial JS 233.67 kB. Workspace roles had one identity-fixture retry; scoped-sync failed and the remaining five network groups were cancelled by fail-fast. This run was not fully green.

The identity fixture wrote the owner profile before guest startup finished; it now waits for the verified owner UI before seeding, with five isolated passes and retries disabled. The scoped archive trace recorded immediate row count zero while the lazy Workspaces dialog loaded, so its archive loop never ran. The scenario now awaits actual rows and targets stable IDs. Exercising the real loop also exposed an invalid Given: enrollment preserves the old guest-owned board, but the new identity is a visitor on it and correctly cannot archive it. Setup now archives that bootstrap board through the normal authorized command before identity replacement, then proves only the enrolled owner board is available. The final new-ID, owner and durable-reload assertions remain. No permission check or timeout was removed.

Run `37041200463` passed verify, both core shards (185 scenarios), native Rust peer and eleven network groups, including scoped-sync (10 cases without retry) and scoped enrollment. Named succession failed both attempts after Claim ownership; quorum was cancelled by fail-fast. The isolated quorum check first exposed an obsolete `Online now` assertion; its replacement, `Connected to this tab`, still checks the device's live connection state. With that assertion corrected, one vote remained pending and the majority enabled Claim ownership, but claiming then produced the same authority failure as named succession. These ownership scenarios are not yet verified.

Both traces show the claimant becoming a visitor and publication failing with `Workspace authority is unavailable for write authorization`. Succession adoption changes the legacy credential owner while preserving the scope ledger's previous controller. Stored authority validation correctly rejects that contradiction. A complete fix must produce a verifiable succession transition across both authority representations; bypassing scope validation or deleting the role assertion would hide the defect.

The fix adds authenticated succession events to the scope ledger. Claims bind to the current controller and control epoch; existing policy, candidate grant, quorum, claim-signature and former-owner-grant verification remains. Bounded signed revocation evidence is checked against authenticated controller history. Gossip merges evidence for the same claim while rejecting competing claims at one epoch. Imports persist validated scope prefixes alongside each owner transition, then the final ledger; a future controller is never installed with an earlier credential. Legacy authority without a scope ledger retains its existing verified path. Browser validation receives an explicit timestamp through the WASM boundary.

Local verification on the final implementation: named and quorum browser histories pass with retries disabled; the quorum history retains one-vote-pending and majority-election assertions. Ten Rust scope cases cover valid claims, insufficient quorum, revoked candidates/voters, historical revocations, signed stale-policy replay after A→B→A, forged/wrong-scope claims and evidence merging/forks. Meta-mesh TypeScript checks, 279 JS tests, Cargo workspace tests (163 passed, 3 ignored), native and mobile tests, touched-file Rust formatting and the rebuilt WASM pass. tincanban quality gates pass; 769 unit tests pass with one existing skip, statements coverage 47.47% and lines 51.75%, unchanged floors. Initial JS is 233.9 kB against the unchanged 235 kB limit.

Seven isolated browser performance/durability/failure histories pass on the final WASM. At 4× CPU with 55 detailed cards, move longest task is 74 ms; Chat Event Timing 48 ms / ready 44 ms; Sync Event Timing 48 ms / pending paint 43 ms / controls ready 93 ms. These are local laboratory observations, not field INP. The deployed Keeper adapter already rejects mesh authority changes, including succession; this change preserves that fail-closed limitation and does not modify its separate dirty checkout.

A separate real UI race allowed another Archive trigger while a previous archive was pending; the first completion could clear the later confirmation. Archive triggers are now disabled during that operation. The existing failure history now defers persistence, checks disabled controls, rejects the save, checks error and reenabled controls, retries and verifies durable replacement and retained archived data. Parallel browser checks use separate output directories to avoid artifact cleanup collisions.

The final fallback history passed with retries disabled, retaining the strict new-ID exclusion and owner-after-reload assertions; the archive pending/failure/retry history passed on an isolated port. Core inventory remains 185 scenarios.

After the archive changes, full local quality and size gates pass: initial JavaScript 233.82 kB against the unchanged 235 kB cap. No full local browser matrix was repeated. A new CI run is required for the production archive guard and the previously cancelled network groups.
