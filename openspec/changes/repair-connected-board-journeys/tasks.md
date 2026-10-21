## 1. Establish actual scenarios and cause

- [x] 1.1 Inspect current CI/deployed version and distinguish earlier rollout from new work.
- [x] 1.2 Trace Rusty legacy intake/admin removal, current storage role and domain/owner configuration.
- [x] 1.3 Read TinSink span exception events for the frozen identity/workspaces; distinguish replayed historical failures.
- [x] 1.4 Capture current same-computer channel failure/reconnect/stream-limit sequence through read-only WebMCP.
- [x] 1.5 Trace private-board publication error ordering and inappropriate retry UI.
- [x] 1.6 Establish live form script/config/endpoint; verify challenge without submitting user data.
- [ ] 1.7 Correlate reported form 404 with its exact POST/request outcome. Current deployed Reflux source verified as 7eced2c; a no-side-effect validation POST returns 400 with correct CORS. Retained 48-hour application logs contain only GET probes returning 404, successful challenge requests and that validation POST. Original failed POST and full human-check submission remain unverified.
- [x] 1.8 Identify the owner's pending removal and failed automation phase; record the user's subsequent explicit decision to reset and reconnect instead of resuming it.
- [x] 1.9 Reproduce multi-workspace stream contention and establish full-frame idle reservations as one confirmed cause; keep remaining production route churn under 2.5.
- [x] 1.10 Complete proposal/design after exploration, review pending-operation/reset changes against evidence, and incorporate the explicit reset decision.

## 2. Repair board and service journeys

- [x] 2.1 Repair directory spacing, compact actions, active badge and responsive window layout; existing functional browser cases passed and live c4 directory screenshot inspected.
- [x] 2.2 Give desktop Sync a useful participant/detail layout and distinct Rusty board state; live 494d owner/editor views show participant/detail columns and independent Synced board/profile storage states.
- [x] 2.3 Complete the user-requested fresh Rusty setup: server reset backed up; owner local Forget archived old bindings/intent, fresh Connect succeeded, board/profile Synced, and distinct Codex/editor automatically received read/write access. Owner-offline exchange remains under 2.4/4.5.
- [ ] 2.4 Make owner-configured Rusty visible and usable to authorized editors/visitors while owner is offline.
- [ ] 2.5 Fix actual same-computer multi-session channel churn without hiding failures or raising arbitrary limits.
- [ ] 2.6 Fix live public intake routing/outcome and verify authorized end-to-end submission.
- [ ] 2.7 Provide useful Rusty board/status inspection. Service 7a54051 is live after CI 39637244954 and deployment 39637637822; frontend b581df7 is live. Actual editor inspection shows app issues Synced/read-write and the two other boards Access required. Live verification found Open board using a workspace ID; repair its admitted board-ID mapping and verify the actual deployed link before completion.
- [x] 2.8 Gate publishing errors/actions on real publication state; focused behavior tests and deployed c4 private-board Settings confirm no public-delivery error/action.
- [x] 2.9 Export bounded useful failure/lifecycle diagnostics to TinSink independently of verbose packet logging; actual c4 dial/session failures with runtime/workspace/peer correlation observed in ClickHouse after 13:36 UTC.

- [x] 2.10 Remove deployment-wide `RUSTY_TRUSTED_OWNER` and controller-device admission pins; keep per-resource ownership, signatures and revocation. Verify unrelated owners, restart isolation and scoped editor delivery; deploy through Rusty CI.

- [x] 2.11 Repair the confirmed TinSink ClickHouse metric-log merge memory failure. The targeted vertical-merge setting is live and persisted in infrastructure; 321 merges since 14:10:07 have zero errors and 124806697-byte peak memory at 17:36 UTC. ClickHouse durably received 1319 live Rusty records in the preceding fifteen minutes. No queued evidence was deleted and the container memory limit was not raised. This closes the merge fault; separate browser keepalive losses and sustained browser delivery remain tracked below.
- [x] 2.12 Preserve manual Rusty actions across background-sync busy transitions. Controlled pending-GET recovery passes Chromium/WebKit; 58 logic tests pass. 4cc7139 Verify and both deployments succeeded; live health confirms the exact SHA. User browser acceptance remains pending.

## 3. GitHub Actions storage (delegated, explicitly authorized)

- [x] 3.1 Inventory live artifacts and explain account storage versus caches; inspect largest public/private repositories.
- [x] 3.2 Delete obsolete artifacts; retain exact current deployment and necessary rollback/reader assets.
- [x] 3.3 Add automatic cleanup and short diagnostic retention, preserving release dependencies.
- [x] 3.4 Structurally verify and publish only reviewed storage workflow changes; record actual reclaimed bytes.
- [x] 3.5 Activate Rusty's guarded automatic cleanup and 90-day source / one-day diagnostic retention. Cleanup-only b70aac4 passed main CI 39635698505 and deployment 39636057327. Automatic runs 39636057319, 39636256827, 39637637753 and 39637812506 succeeded; live 7a54051 retains this cleanup. Reviewed manual deletion removed 44 obsolete artifacts / 124,284,016 bytes with exact before/after receipts and preserved live/rollback release pairs.

## 4. Verify and deliver

- [ ] 4.1 Retain meaningful behavior scenarios/units; no app launches solely for labels, icons or styles.
- [x] 4.2 Complete production follow-up for previously deployed Quick note keyboard/save/retry, ITEM removal and shared ink focus; isolated production save/reload and failed-save draft/retry passed, live 494d typing/shared contour inspected and probe cleared without saving, card header has no ITEM.
- [ ] 4.3 Deploy completed app/service fixes through their appropriate CI pipelines; verify actual running versions.
- [x] 4.4 Add Rusty to the real issues board from the user's owner identity (clicks authorized); Bo/owner and Codex/editor confirmed Synced on deployed 494d at 14:37 UTC.
- [ ] 4.5 Verify real participant data exchange via Rusty with owner sessions closed; include read-only visitor behavior.
- [ ] 4.6 User personally verifies deployed browser behavior before any ticket moves to Done.
- [x] 4.9 Update the vulnerable Markdown parser blocking CI; rendering/audit checks passed and c4 containing markdown-it 15.0.3 is deployed.
- [x] 4.7 Repair redundant cold Docker dependency compilation in Rusty CI; retain behavior/release proofs and bound cache storage. Real warm main CI 39635698505 reused the dependency layer; root service compile took 17.22 seconds and cache export 3.7 seconds. Prior cold dependency compilation took 162.9 seconds; no behavior tests or release checks were removed.
- [x] 4.8 Repair duplicate image pull after Rusty writer shutdown; verify prepared image before handoff and restore previous writer on activation failure. Record blue/green constraints and options before a storage architecture change.

- [x] 4.10 Select the sealed automation cohort from its actual packaging attempt after a partial CI rerun; actual c4 producer attempts covered by eighteen focused checks; 494d frontend and automation both deployed with SHA/run/reader validation intact.

## New reports

Append new user reports here or to the relevant section. Do not discard earlier unfinished scope when new reports arrive.

- [x] Round badges render with square ink frames in production: longhand CSS repair passed minification and functional proofs; live c4 directory/board screenshot shows round column counts.
- [ ] Rusty visible on one board but missing on another: distinguish owner board setup from participant access delivery; verify both actual boards.
- [ ] Verify the same editor on two separately owner-configured boards after switching/reopening and with owner sessions closed. Current live comparison: app issues is owner-configured and Synced/read-write for Codex/editor; Ecky issues and Job search retain access rejected after the server reset. Broader owner-tab permission is still pending.
- [ ] Stop unconfirmed deletion of legacy Rusty connection records on first read/mutation; cover skipped-release startup and late legacy writes. Establish whether the real missing board record can be recovered from retained operation evidence or another owner device, without importing obsolete credentials automatically.
- [ ] Red CI: repair real same-identity Rusty credential transfer under multi-workspace contention; preserve its functional acceptance scenario.
- [ ] Fix the public-delivery owner-identity regression exposed by testing the deployed Rusty revision; preserve per-board authority across editor delivery and restart without a global owner pin.
- [ ] Remove automatic identity-name prefill and random device labels, including old pending-removal presentation; preserve intentional names and signed identity data.

- [ ] Verify readable mobile named-successor selection and device scrolling on the deployed client; isolated WebKit proof passed.
- [x] Find current Swift best-practice skills and lint/format/concurrency tools from primary sources; installation was not requested.
- [ ] Deploy actionable guidance for the screenshot's cold board-link 404: ask the owner for an invitation or a new link instead of asserting that the board was unpublished or removed. Preserve private-board refusal. Source copy repaired; original visitor failure cause remains unproven and no wording-only browser test was added.

- [ ] Fix unnamed photo-only profile save without requiring a name or changing name-choice provenance; caught by the complete Rusty phone photo-delivery scenario.

- [x] Old per-device Rusty-removal badge remains after explicit local Forget even though fresh board/profile replication now works. Reviewed local stop deployed in b581df7 and applied to the exact ingest origin in the authorized Bo/owner tab at 16:49 UTC. Active pending badge disappeared; retained history says Removal stopped and remote revocation unconfirmed. Current board/profile connections remain. Stale-confirmation/identity guards and 21 logic checks plus browser cancel/stop/reload scenarios pass.
- [ ] Fit OTLP batches to the deployed 64 KiB body contract. Live probe: single record 200, 869147-byte long-error batch 413; focused SDK regression generated a 917693-byte request. Byte splitting, bounded concurrency, multibyte exception limits and in-flight opt-out are deployed in verified 4cc7139; 51 focused tests and all ten browser telemetry journeys pass. Sustained production failure export still needs proof; startup records alone do not establish it.

### Actions cleanup evidence (2026-10-21)

Deleted 840 obsolete artifacts, 11,299,821,020 bytes (10.5238 GiB). Preserved eight current/rollback release artifacts (223,218,463 bytes). Cleanup published in tincanban `076915e`, gonzo-yuppie `1f66337`, cultiwars `a58f3cc`. Dry-run and real runs succeeded in all three repositories. Actual runs: [tincanban](https://github.com/bobishh/tincanban/actions/runs/39581820965), [gonzo](https://github.com/bobishh/gonzo-yuppie/actions/runs/39581825746), [cultiwars](https://github.com/bobishh/cultiwars/actions/runs/39581829717). Diagnostic retention one day; sealed release retention 90 days with live/current/rollback protection. Already uploaded source artifacts retain their previous November 3 expiry; next complete release creates new cohorts with 90-day retention. No application deployment was performed by cleanup.

Rusty follow-up: audited da05887 deleted 44 artifacts / 124,284,016 bytes using
fresh health and active-run checks before every delete. Exact before-minus-after
IDs equal the successful deletion receipts. Current a910b70 source/deployment
12355281096 / 12354269049 and compatible ded16d6 rollback source/deployment
12345546680 / 12345961648 remain nonexpired. New inventory: nine artifacts /
20,306,006 bytes. Live binary 05bf3ea0 and SDK 9d92a47 remain unchanged; health
is `ok`. This raises actual cleanup across the four repositories to 884 artifacts
and 11,424,105,036 bytes. Rusty automatic workflow activation completed in b70aac4; main retention and subsequent automatic runs succeeded. The quoted inventory records the manual cleanup checkpoint, not a claim that later release artifacts cannot replace the selected rollback.

- [ ] Preserve useful OTLP failure evidence while the next export is pending: live b581df7 exported startup records, then discarded hundreds of records while clearing the last error at each new request. Independent bounded log/trace failure state is implemented in c4547f1, whose CI failed and did not deploy. The actual quota leak is reproduced: installed OTel leaves no-store response bodies unread. Narrow upstream drain backport passes real HTTP Chromium/WebKit delivery, rejection and recovery; verify sustained production export after deployment.
- [ ] Repair CI failures without weakening behavior checks: a3460ce CI passes the unchanged startup budget/build/seal and native WebKit guarded publication lifecycle. Its offline-invitation failure interrupted the first workspaceAccess module download before app.ready; the fixture now awaits whenReady before losing network. Original single-click retry, received data and stable route pass in 15.5 seconds. Corrected CI and deployment remain pending; no routing/protocol/authority guard or timeout changed. Search retains the original 200-ms budget and five lifecycle units.
