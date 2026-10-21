## Context and evidence

`exploration.md` records source/history, live TinSink exception events, read-only WebMCP mesh traces, deployed form routes, and completed server/CI proofs. Confirmed faults are distinct: a pending credential operation freezes ordinary writers; several admitted workspaces exhaust shared stream budgets while sessions close/reopen; a missing editor credential is checked before a private board can return 404; mesh diagnostics remain local unless verbose logging is enabled; window content lost padding and desktop information layout wastes width.

A live form challenge succeeds at the deployed Reflux integration endpoint. This is not proof that the reported form submission succeeds. A service-global Rusty owner pin contradicted the intended multi-controller service; removal is now deployed and independently authenticated status reads are proven.

## Goals

1. Board changes remain durable and reachable to authorized participants while owner devices are offline.
2. Recovery identifies the retained operation and preserves its exact evidence until signed confirmation.
3. Users see applicable actions and accurate distinctions between local persistence, live peers, durable storage and public publication.
4. Incident evidence reaches TinSink with bounded volume and useful correlation under existing consent.
5. Useful desktop/narrow-window layouts retain normal board and device actions.
6. Completed fixes reach production through CI with exact running-version proof.

## Decisions

### Deliver known fixes while investigating unresolved causes

Apply the confirmed UI, publication-ordering and diagnostic corrections first. Retain unresolved intake POST, current owner journal phase and sustained mesh contention as explicit investigation tasks; no claim that a changed indicator or successful challenge repairs them. No automatic freeze removal or credential regeneration; the explicit user-requested reset below is a separate confirmed action. Keep existing stream limits.

### Publication is optional; discovery precedes writer authorization

A read of public board visibility requires only the currently selected board/source identity to remain unchanged. A confirmed private/404 result ends quietly without resolving editor publication credentials. For a public projection, resolve current editor grant/certificates lazily, then retain current authority checks before challenges, signing, staging and final confirmation. Missing or revoked authority blocks delivery with an applicable Sync action; it does not enter an endless network retry loop. Network failures remain retryable. A result for an obsolete selected board or source must not become the current board's error.

### Diagnostics have separate incident and verbose policies

Keep the bounded local trace and opt-in per-packet console/export detail. Ordinary consenting clients automatically export warning/failure records and selected session/node lifecycle events with workspace, peer, connection, tab, run and instance correlation. Bound repeated incident export per time window and report suppressed counts; do not record board content, keys or bearer credentials. Existing telemetry disabled/errors-only/sampling settings remain authoritative. Transport failure causes supplied as Error objects retain stack/type; plain reason strings receive a safe error code rather than being discarded.

### Windows respond to their own width

Directory content owns padding, spacing and compact row actions. Active state sits beside board identity rather than adding a large action row. Desktop Sync uses a compact participant list beside selected devices/details; narrow windows stack without hiding storage/recovery actions. Both use existing ink surfaces/focus and scrolling primitives. Browser acceptance exercises actual actions and pending/failure states, with screenshot inspection; do not boot an app solely to assert CSS or button labels.

### Inspect configured board storage from Rusty

The removed readable keeper admin UI cannot be restored by exposing blind-store
scope inventory anonymously. Restore a read-only browser status handoff instead:
Rusty's page opens an allowed Tincanban frontend in the same browser, with a fresh
request ID and two-minute deadline. Tincanban asks explicitly before sending names
and current sync outcomes for boards configured on that exact Rusty origin. The
original opener, exact target origin, deadline and identity/device remain bound
through confirmation. No keys, tokens, scope credentials, board contents or
management capability are transferred. Other Rusty origins remain excluded.

Rusty accepts a response only from its original popup at the selected frontend
origin and matching request ID. Board results remain in that page's memory and
carry their check time; refresh starts another explicit request. This is a view
of the approving browser's confirmed exchanges, not a claim about all offline
devices. Service availability is checked separately through existing health.
No backend login session, public private-board listing, global owner pin, storage
migration or new write authority is introduced. With no configured frontend,
Rusty explains the missing operator setting rather than guessing a domain.

### Preserve exact recovery, allow the requested fresh start

The two retained operations differ: conflict recovery for one scope (which may be identity scope) and identity-device revocation across an origin. Read the valid freeze/journal, signer and scope/device references without exposing keys. Explain what is pending and offer the matching existing resume action; do not create another credential epoch from a generic Connect click. Preserve incompatible/missing/foreign-signer evidence and surface a useful failure. Report journal-confirmed progress separately from unconfirmed remote state.

For a new device removal, inspect every automation cohort before installing the local origin freeze. Recheck exact credential bindings when committing; retain normal replication progress made while inspection runs. Capture the inspected proofs into the saved journal before any automation freeze or revocation. A retained transition resumes its own captured intent. Different worker epochs and different service identities need distinct errors; neither permits silently skipping the worker or replacing keys.

The user subsequently requested erasing Rusty storage and starting afresh. The
server reset is complete with an external pre-reset archive and unchanged service
key. This supersedes further attempts to resume the original removal on that
origin. Explicit local Forget must archive exact settings, freeze, transition,
conflict, enrollment and completed-operation evidence in the same guarded
transaction that removes active local delivery access. Missing active settings
do not invalidate an otherwise origin-bound pending journal. Other origins and
browser board/profile/files remain untouched. The participant may forget only
their own device-local access; fresh board configuration remains owner-only.

Keeping the service key leaves old signed management revisions cryptographically
valid. A local reset-origin marker therefore refuses peer-imported authority
until directly observed fresh server evidence exists. The marker is local and
not shared as board authority. Fresh explicit Add creates new board and identity
scopes; automatic provisioning cannot resurrect removed scopes.

### Unnamed identity and photo updates

New identities have no automatically chosen user-facing name. Neutral protocol
metadata plus a local provenance marker keeps Name empty until explicitly chosen;
existing deliberate names and signed certificates remain unchanged. Saving only
a photo must preserve that empty-name state. A combined explicit name/photo save
retains the atomic profile/root operation; photo-only edits retain revision guards
and must not silently convert neutral metadata into a user-chosen name.

### Admit headers before payload reservations

An idle response wait must reserve only the bounded header, not an entire maximum-size payload. The native reader inspects frame kind and wire limit before requesting payload admission from the shared peer budget. Header reservations and payload reservations share the existing 32-MiB limit; at most two payload frames and a finite 32 header waits are admitted per peer. Small heartbeats can proceed while other scopes await data. Cancellation, deadlines and transport close release reservations only after underlying read cancellation; older WASM without staged admission retains conservative full-frame accounting.

Preserve the actual multi-workspace credential-transfer acceptance test. Require both successful transfer and no concurrency/empty-header warnings. Enrollment helpers must await terminal confirmation on both participating devices before closing their windows. This establishes the repaired admission mechanism; sustained production operation and owner-offline participant exchange remain separate verification.

### Rusty configuration and runtime status

The earlier explicit local reset preceded the deployed fix that also retires
the per-device server-removal phase. Do not repeat Forget against a now working
connection to remove that stale badge. Offer a separate reviewed local stop of
the exact pending origin: archive the captured job, remove only that origin from
retry scope, and retain an explicit unconfirmed-removal history entry. The same
job lock and transactional comparison prevent a newer attempt or other identity
from being overwritten. No server request or connection preference changes.
An older open confirmation cannot revive the stopped origin; resuming it needs
an additional explicit scope review.

Board-level connection access comes from an owner-attested record delivered across participant identities; identity replication remains private. Editor/visitor views show the same configured service and truthful local durable-copy status. A visitor can read updates but cannot publish edits or configure storage. Only the owner changes board storage. Operator domain/CORS configuration remains separate from board permissions. Useful Rusty status must distinguish configured, waiting, reachable, current, blocked and unavailable from human peer presence.

### Activation and artifacts

Retain a single writer for the existing filesystem format. Pull and verify the exact sealed public image before stopping the previous writer; activate that prepared image without another registry login/pull. Preparation failure leaves the old writer running; activation failure restores the captured previous writer. Full blue/green needs a storage concurrency design because the current process holds an exclusive volume lock. Do not bypass it.

Actions diagnostics expire after one day; retain only current/rollback release cohorts and in-flight release dependencies, with automated fail-closed checks. Build-layer cache optimization is separate from retaining uploaded diagnostic artifacts.

## Verification and rollout

- Begin each logic change with a failing focused Given/When/Then test; UI outer scenario first, browser execution after implementation.
- Verify private visibility before missing editor authority, active public delivery, revoked authority, temporary server failure, obsolete-source completion and retry cancellation.
- Verify ordinary diagnostic export, bounded suppression/reset, opt-out enforcement and verbose disable races.
- Verify directory actions/rename failure and desktop/narrow Sync selection/scrolling on isolated real routes.
- Reproduce multi-workspace same-computer channel contention before an SDK fix; verify sustained edits, idle heartbeats and close/reopen, not only status text.
- Complete owner configuration in the real board, confirm a distinct Codex editor sees Rusty, close owner sessions and prove editor-to-visitor exchange. Keep this separate from synthetic protocol proofs.
- Correlate the real form submission outcome and retained event with its actual deployed integration.
- Deploy via appropriate component CI, inspect live source/receipts, keep tickets Doing until user browser verification.

## Remaining questions for investigation

The owner's saved operation is confirmed as Valiant Squirrel device removal; its automation discovery fails before completing recovery. The user has replaced old-journal recovery with an explicit fresh reset; failed intake POST remains unestablished. Server reset alone does not clear browser bindings or prove fresh participant delivery. Idle full-frame reservations reproduce legitimate cross-workspace rejection, and staged admission passes the real credential-transfer scenario without its warnings. Other route/session interactions and sustained production stability are not established by that focused proof.
