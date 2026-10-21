## 1. Establish actual scenarios and cause

- [x] 1.1 Inspect current CI/deployed version and distinguish earlier rollout from new work.
- [x] 1.2 Trace Rusty legacy intake/admin removal, current storage role and domain/owner configuration.
- [x] 1.3 Read TinSink span exception events for the frozen identity/workspaces; distinguish replayed historical failures.
- [x] 1.4 Capture current same-computer channel failure/reconnect/stream-limit sequence through read-only WebMCP.
- [x] 1.5 Trace private-board publication error ordering and inappropriate retry UI.
- [x] 1.6 Establish live form script/config/endpoint; verify challenge without submitting user data.
- [ ] 1.7 Correlate reported form 404 with its exact POST/request outcome.
- [ ] 1.8 Establish current owner's exact saved credential operation and failed phase before choosing recovery.
- [ ] 1.9 Reproduce sustained multi-workspace/tab stream contention and establish its cause.
- [ ] 1.10 Complete proposal/design after exploration; review started pending-operation patch against actual findings.

## 2. Repair board and service journeys

- [ ] 2.1 Repair directory spacing, compact actions, active badge and responsive window layout.
- [ ] 2.2 Give desktop Sync a useful participant/detail layout and distinct Rusty board state.
- [ ] 2.3 Complete the user-requested fresh Rusty setup: server reset is backed up and complete; explicitly forget frozen local Rusty bindings, preserve browser boards/profile/files and retained reset evidence, then reconnect from owner and verify editor delivery. This replaces further attempts to resume the old transition.
- [ ] 2.4 Make owner-configured Rusty visible and usable to authorized editors/visitors while owner is offline.
- [ ] 2.5 Fix actual same-computer multi-session channel churn without hiding failures or raising arbitrary limits.
- [ ] 2.6 Fix live public intake routing/outcome and verify authorized end-to-end submission.
- [ ] 2.7 Provide useful Rusty board/status inspection; clarify which controls belong to owner UI versus operator config.
- [ ] 2.8 Gate publishing errors/actions on real publication state; report private access failures with an applicable action.
- [ ] 2.9 Export bounded useful failure/lifecycle diagnostics to TinSink independently of verbose packet logging.

- [x] 2.10 Remove deployment-wide `RUSTY_TRUSTED_OWNER` and controller-device admission pins; keep per-resource ownership, signatures and revocation. Verify unrelated owners, restart isolation and scoped editor delivery; deploy through Rusty CI.

## 3. GitHub Actions storage (delegated, explicitly authorized)

- [x] 3.1 Inventory live artifacts and explain account storage versus caches; inspect largest public/private repositories.
- [x] 3.2 Delete obsolete artifacts; retain exact current deployment and necessary rollback/reader assets.
- [x] 3.3 Add automatic cleanup and short diagnostic retention, preserving release dependencies.
- [x] 3.4 Structurally verify and publish only reviewed storage workflow changes; record actual reclaimed bytes.

## 4. Verify and deliver

- [ ] 4.1 Retain meaningful behavior scenarios/units; no app launches solely for labels, icons or styles.
- [ ] 4.2 Complete production follow-up for previously deployed Quick note keyboard/save/retry, ITEM removal and shared ink focus.
- [ ] 4.3 Deploy completed app/service fixes through their appropriate CI pipelines; verify actual running versions.
- [ ] 4.4 Add Rusty to the real issues board from the user's owner identity (clicks authorized); confirm distinct Codex editor visibility.
- [ ] 4.5 Verify real participant data exchange via Rusty with owner sessions closed; include read-only visitor behavior.
- [ ] 4.6 User personally verifies deployed browser behavior before any ticket moves to Done.
- [ ] 4.9 Update the vulnerable Markdown parser blocking CI, verify rendering and deliver the audited release.
- [ ] 4.7 Repair redundant cold Docker dependency compilation in Rusty CI; retain behavior/release proofs and bound cache storage.
- [x] 4.8 Repair duplicate image pull after Rusty writer shutdown; verify prepared image before handoff and restore previous writer on activation failure. Record blue/green constraints and options before a storage architecture change.

- [ ] 4.10 Select the sealed automation cohort from its actual packaging attempt after a partial CI rerun; preserve SHA/run/reader validation.

## New reports

Append new user reports here or to the relevant section. Do not discard earlier unfinished scope when new reports arrive.

- [ ] Round badges render with square ink frames in production; verify count/presence circles after CSS minification.
- [ ] Rusty visible on one board but missing on another: distinguish owner board setup from participant access delivery; verify both actual boards.
- [ ] Verify the same editor on two separately owner-configured boards after switching/reopening and with owner sessions closed. Live comparison: Ecky issues has read/write access; app issues has no owner-configured entry and retained device removal is pending.
- [ ] Stop unconfirmed deletion of legacy Rusty connection records on first read/mutation; cover skipped-release startup and late legacy writes. Establish whether the real missing board record can be recovered from retained operation evidence or another owner device, without importing obsolete credentials automatically.
- [ ] Red CI: repair real same-identity Rusty credential transfer under multi-workspace contention; preserve its functional acceptance scenario.
- [ ] Fix the public-delivery owner-identity regression exposed by testing the deployed Rusty revision; preserve per-board authority across editor delivery and restart without a global owner pin.
- [ ] Remove automatic identity-name prefill and random device labels, including old pending-removal presentation; preserve intentional names and signed identity data.

- [ ] Verify readable mobile named-successor selection and device scrolling on the deployed client; isolated WebKit proof passed.
- [x] Find current Swift best-practice skills and lint/format/concurrency tools from primary sources; installation was not requested.

### Actions cleanup evidence (2026-10-21)

Deleted 840 obsolete artifacts, 11,299,821,020 bytes (10.5238 GiB). Preserved eight current/rollback release artifacts (223,218,463 bytes). Cleanup published in tincanban `076915e`, gonzo-yuppie `1f66337`, cultiwars `a58f3cc`. Dry-run and real runs succeeded in all three repositories. Actual runs: [tincanban](https://github.com/bobishh/tincanban/actions/runs/39581820965), [gonzo](https://github.com/bobishh/gonzo-yuppie/actions/runs/39581825746), [cultiwars](https://github.com/bobishh/cultiwars/actions/runs/39581829717). Diagnostic retention one day; sealed release retention 90 days with live/current/rollback protection. Already uploaded source artifacts retain their previous November 3 expiry; next complete release creates new cohorts with 90-day retention. No application deployment was performed by cleanup.
