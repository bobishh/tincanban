# Repair connected board journeys — investigation

Date: 2026-10-21. Status: explore. No application change in this investigation has been released.

## User intent and release gate

Keep one tracked list; add subsequent reports. Understand the real scenarios before implementing more migrations or recovery UI. Deliver fixes through CI. Never move tickets to Done until the user personally verifies the deployed browser behavior.

Latest steering: the user explicitly requested clearing Rusty and adding it from
scratch, replacing further attempts to resume the old credential transition.
Server reset completed at 2026-10-21 13:11:57 UTC: stopped the single writer,
backed up its complete state to
`/root/rusty-reset-backups/20261021T131157Z/state-before-reset.tar.gz`
(11,167,103 bytes), cleared stored scopes/publications/management state, retained
only the service identity, and restarted the same verified binary. Health is ok
at `ded16d6b…`; the signed discovery identity remains unchanged. Browser boards
were not cleared. Local frozen connections still require explicit forgetting
before a fresh owner setup; that reset must preserve board/profile/attachment
data and prevent replay of the removed configuration.

The user also reiterated removal of prefilled identity names and random device
labels such as Squirrel. Implement neutral unnamed presentation and an empty
initial name field, preserving explicit user names and existing signed identity
records. Form investigation was stopped after the user redirected focus to
Rusty; no test submission or human-check answer was sent.

Rusty is configured by the owner, visible to an editor as a board service/participant, and must exchange board changes for every authorized participant while owner browsers are closed. The user explicitly permits clicking to perform the eventual real owner-to-editor acceptance. Merely showing “Connected” is not acceptance.

## Current evidence

### Running versions

- Tincanban Verify 39499478014 and frontend/automation deployments 39501590107 / 39501590243 succeeded for `07c9768e8117c07d26cf5dbaed205196cd811e0e`.
- Rusty `/health` reports `6e394f57963dbbbb89a67387673e789fb1da83a7`, blind mode. Its root page contains only links to Tincanban and logs. `/admin/`, `/challenge`, `/ingest` return 404.
- The Rusty checkout is a separate repository (`../mesh-lighthouse`); it has pre-existing unrelated working changes. Its checked-out source is not proof of its deployed version.

### What changed in Rusty

Rusty commit `d811e9d` (2026-10-09, “Replace readable keeper intake with signed blind storage”) removed the readable keeper HTTP/pairing/intake implementation. Current `src/blind_tests.rs` explicitly expects legacy `/ingest`, `/challenge`, `/v1/pairings`, `/admin/` to return 404. `src/service.html`, introduced by `c06defe`, is a static landing page, not a replacement board administration surface.

The current service stores opaque ciphertext over HTTP; it is not a readable Automerge editor or an Iroh mesh relay. Board-only owner-signed storage access is now exchanged between authorized browser participants (`workspaceRustyExchange.ts`). That implementation and the user's expectation of a visible, useful board participant must be reconciled explicitly rather than hiding the architecture behind “Connected”.

### Domain and owner restrictions

- Rusty `src/main.rs` reads `RUSTY_PUBLIC_ORIGIN`, `RUSTY_CORS_ORIGINS`, `RUSTY_TRUSTED_OWNER`. There is no current UI for configuring them.
- Production configuration allows browser origin `https://match.meta-uber-engineer.dev` only. Live OPTIONS confirms that origin receives `Access-Control-Allow-Origin`; `https://example.com` does not.
- CORS is a browser origin rule, not board authorization. Owner signatures, service identity pins, person/device policy, scope policy and read/write capabilities remain separate.
- Adding an arbitrary browser application domain currently requires operator configuration. Do not silently expand that allowlist while fixing delivery.

### Pending credential transition

TinSink spans at **09:23:13–14 UTC** contain actual exception events, not merely generic status codes:

| Trace ID | Scope | Error |
| --- | --- | --- |
| `ad3c5f276b317a5f9666fc5da735e16e` | private identity | Rusty credential transition is pending; ordinary replication is frozen |
| `7832c11bf9b8a25ff7bf9b364991b137` | workspace `2fd842af…` | same |
| `f8e1dbb85b53d8d3d83eada531687afc` | workspace `e3d8e416…` | same |

The implementation intentionally freezes every ordinary reader/writer for that person at an origin (`replicaCredentialFreezeState.ts`), including another board. `connectWorkspaceReplica` asserts the same condition before connection setup. Thus a saved recovery for one resource can stop Connect and several other scopes. A bare error does not tell the user which operation, board, device or next action is responsible.

Two existing operations must not be conflated:

1. Recover conflicting connection credentials for one scope, retaining old keys/outbox and confirming a fresh snapshot.
2. Revoke an identity device across an origin, rotating all relevant scopes and handling existing automation writers.

At 09:22:58 UTC, TinSink replayed a retained `rusty.credential-recovery.previous.failed` checkpoint from frontend version `1b946d9…`: `automation.management.discover.fetchHeaders` failed to fetch `automation.meta-uber-engineer.dev`. This is historical evidence re-emitted on reload, not proof that today's failed step is the same. Commit `d3198c3` already removed automation as a prerequisite of per-device conflict recovery; device revocation still has a different coordination path. Read the exact current transition before choosing a repair.

### Repeated connections on one computer

The user's acceptance context is multiple browser sessions/identities **on one computer**, not a claim about physical hardware inferred from user-agent labels.

Fresh read-only WebMCP trace captured **09:47:57 UTC** covers 500 events from 09:47:22.914 to 09:47:57.287:

- 09:47:32.259: heartbeat for `out-509` fails, “failed to read stream chunk: connection lost”.
- 09:47:32.270: current session for `pvSpl-Wy…`, instance `slot-0`, issues workspace, closes with cause “heartbeat failed”.
- 09:47:34.496: incoming session `in-538` starts again for the same device/instance/workspace.
- Four `workspace.frame.rejected` events report `Mesh stream concurrency limit exceeded` across three workspaces.
- 15 dial failures; several stale instance routes time out, another reports missing addressing. Successful gossip delivery and workspace receive events also continue.

This is real channel churn, not only a cosmetic indicator. Prior transport cancellation tests did not establish that the entire multi-workspace/tab topology is stable. Investigate peer-shared read slots, queued idle reads, duplicate connection lifetime, stale route scheduling and control/data stream contention before changing limits or adding status debounce.

### TinSink coverage gap

`src/sync/meshTrace.ts` exports mesh events only when verbose console logging is enabled (`syncTrace=1`). Otherwise events stay in a bounded local buffer of 500. Existing tests intentionally assert that ordinary browsing exports no repeated mesh events. This contradicts the user's expectation that connection failures are automatically diagnosable remotely.

Since 08:00 UTC, TinSink contained 212 browser log records at the observation time: 207 startup records, three pairing-route checks, one automation request start, one replayed recovery failure. The latest browser export was 09:33:46 although the local buffer continued recording channel failures at 09:47. Rusty continued exporting live server errors. Diagnostics therefore need separate controls for useful failure/lifecycle telemetry and verbose packet/console noise.

Rusty server errors often expose only `operation=request`, status and byte count, without route category or scope for management/publication. Those 403/404 records alone cannot identify the user's intake request or credential fault.

### Misleading public delivery on private boards

`useAppPublicBoards` installs editor public delivery without checking publication status. `usePublicBoardDelivery.deliverBoard` calls `currentEditorCredential` **before** `deliverPublicBoard` can fetch the public projection and recognize 404/private. That credential check also emits “Editor workspace grant is no longer active” for missing local credential/authority, mismatched workspace/person/role/epoch or revocation. It does not prove expiration.

The catch path treats any error while role remains editor as retryable; Settings displays the raw error as “Public board delivery” and always offers “Retry public delivery”. Thus an unpublished board can show an unrelated publishing failure before its private status is even checked. The error and button do not provide an actionable diagnosis of private sync or access.

### Public form / intake

Local legacy website `../meta-uber-engineer/assets/contact.js` still names Rusty `/challenge` and `/ingest`. That alone is **not** evidence of the live form contract.

The actual live homepage loads hashed contact script `contact.02a70808…js`. Its current config is `/assets/contact-config.json`, HTTP 200, pointing to **`https://reflux.meta-uber-engineer.dev`**, integration `97697bb3-3c06-4ab7-bb6a-69450b281a88`. It uses `POST /v1/challenge` and `POST /v1/intake/{integrationId}`. A bounded challenge request with that exact ID returned 200; no form submission was sent and no challenge was solved. GET on those POST-only endpoints returns 404 and does not reproduce a failed form POST.

Therefore the reported form 404 still requires correlation of the actual failed request. Do not “fix” Rusty's intentionally removed legacy path based on a stale local website file. Reflux owns the active public intake; automation Worker also forwards the v1 contract to Reflux.

### Layout

- Board directory is a `DialogWindow` child `.dialog-window-content`; the wrapper globally sets padding to zero. Directory has no compensating surface padding. Its `.workspace-item-actions` stretches across each row; Active badge moves to a separate line, increasing active row height. Breakpoints are viewport-based even when the window is resized independently.
- Desktop Sync displays full-width participant rows then selected device details underneath. This wastes width and hides relevant detail below the fold. Desired exploration direction: compact participant master list beside selected participant/device details; explicit Rusty board state separate from human-device presence; narrow windows stack responsively.

## Acceptance scenarios to agree and implement

1. Owner adds Rusty by address; service identity and authorization checked; success means a confirmed usable copy, not only a saved URL.
2. Owner's current connection is frozen by an interrupted operation: identify exact saved intent and failed phase; resume the appropriate existing operation. Another board's operation must be visible; a new Connect must not be a dead end.
3. Owner configures this real issues board; Codex remains a distinct editor. Rusty becomes visible to Codex. Owner browsers close; editor edits reach another authorized participant through Rusty. Visitor receives changes but cannot write or configure storage.
4. Same-computer owner/editor sessions with several admitted workspaces: sustained idle heartbeats, edits in both directions and close/reopen one tab do not cause repeated disconnects or exhaust peer stream budgets.
5. Private board: no publication failure or retry action. Genuine editor-access loss is presented as access/sync state with an applicable next action; no publication permission is implied.
6. Intentionally public board: publication status, pending updates, denied access and unavailable host have distinct truthful states and targeted retry.
7. Real public form: load deployed config, obtain challenge, submit an explicitly authorized synthetic fixture, show outcome and inspect retained event. No success claim merely from a 200 challenge.
8. Rusty operator/owner can inspect configured board/scope storage status and failures in a useful surface; no private plaintext or tokens are exposed to arbitrary visitors.
9. Normal diagnostics enabled: connection closure, reconnect failure, exhausted resources and recovery failures reach TinSink with bounded correlation. Routine per-packet detail does not flood storage or require a special URL to diagnose incidents.
10. Board directory and Sync: usable default-size, maximized and narrow windows, including rename validation/pending recovery. Verify behavior and inspect screenshots; do not add full application tests solely for labels or CSS constants.

## Work tracking

See `tasks.md`. New user reports extend that list. Existing unfinished application edits made before the explore correction remain uncommitted and are not accepted as the chosen repair.

## Explicit decision: remove the global Rusty owner pin

User explicitly requested removal of `RUSTY_TRUSTED_OWNER` and its check. Original multi-integration design permits multiple unrelated controllers, with no compulsory personal domain, board or owner. Current service instead pins one root and controller ancestry at deployment, before any per-resource authorization. A native HTTP scenario reproduced a second legitimate owner receiving 403 during person-policy bootstrap.

Implementation scope: remove environment parsing, router/global state and controller ancestry admission; allow each valid root/device proof to establish its own person/resource policy. Keep exact current capabilities, signed request bindings, cumulative revocation and recorded scope/publication ownership. Legacy scope/publication ownership must also prevent foreign first management-policy creation. No stored ciphertext or policy format is changed.

Public delivery must resolve the board owner's public key from its authenticated management evidence, never treat the requesting editor as owner. A full HTTP editor scenario additionally exposed an existing error: editor delivery required owner management revision despite carrying a separate signed delivery grant. Owner management revision remains mandatory for owner commands; editor commands instead bind the current delivery policy/grant/generation and source frontier. HTTP content update and staging succeed; foreign ownership claims and editor withdrawal fail. Old publications without any owner management record require their owner to establish that record before editor delivery can resolve the owner key; no arbitrary editor identity is accepted as fallback.

Evidence files: `/tmp/rusty-owner-red.log`, `/tmp/rusty-owner-suite.log`, `/tmp/rusty-editor-http.log`. Red scenario failed with 403; implemented suite reached 103 passing tests. Isolated source checkout `/tmp/rusty-remove-global-owner-pin`; deployment configuration change `c46631e57f7487063f224acff8314092ea76d150` removes the owner environment dependency and retains the currently deployed OTLP endpoint. Source/deployment completion still pending at this note.

### CI timing observation

Rusty CI run 39583199614: verify and formal models finished before the image build. `publish-container` invokes plain `docker build` on a separate ephemeral runner, with no remote layer cache import/export; the Dockerfile dependency-cache layer is therefore rebuilt each run despite its comment. This repeats Rust dependency compilation after native verification. CI passed; this is an observed independent build-cost cause, not evidence that remaining tests are cosmetic.

### Rusty activation incident and blue/green constraint

Owner-pin source CI 39583199614 passed all jobs and sealed source `4cce5409ca36669728bac9a1334577f3ba50020a`. First deployment 39583769416 pulled the image successfully, stopped the old writer at 10:20:47 UTC, then invoked `kamal deploy --skip-push`, which invokes `build:pull` again in pinned Kamal 2.10.1. That step removes the local image tag and pulls again. Its second pull stalled after the old writer was stopped, producing 502. The attempt was cancelled/force-cancelled; the exact previous writer from its captured storage-handoff record was restored. Health confirmed source `6e394f5…` and the old global pin still returned 403 for two independent signed status requests.

Adapter repair `4dd5004dab4e6709149971aed87885423299e9f6`: pull and verify the immutable image on the actual host before stopping storage; use `kamal app boot` to activate that prepared image without another registry roundtrip. A Node behavioral test failed before this change, then passed. It covers operation ordering, failed preparation leaving the old writer untouched, wrong prepared digest leaving it untouched, and activation reader-floor failure restoring it. Source binary is unchanged; manual CI deployment 39585175471 consumes the same sealed successful source run rather than rebuilding it.

Kamal normally starts a candidate, waits for health, routes traffic to it, then stops the previous container. Current Rusty additionally holds an exclusive filesystem lock for its whole process; two complete processes cannot open the same volume concurrently. Full blue/green therefore needs a deliberate storage concurrency/ownership design, not simply deleting the stop or bypassing the lock. Options to evaluate include a separately stable storage process behind independently deployable HTTP frontends, or a shared transactional store with compatible concurrent readers/writers. The immediate repair retains the current storage format and locking. A larger storage change requires an evaluated migration and rollback design.

### Production proof: owner pin removed, service restored

Final deployment [39586773312](https://github.com/bobishh/rusty/actions/runs/39586773312) succeeded using adapter `8530151af029e8516a4db4d5a26f9c94d4db4e26` and sealed source binary `4cce5409ca36669728bac9a1334577f3ba50020a`. Live health reports that source. Service identity remained `wUGJxX-8fK6VGGw1sd9YL1gIBv8AsdEkn7FBrlu2OHM` across activation. Two fresh independent root/device identities each queried their own person-management status: before activation 403, after activation 200 with cryptographically verified Rusty-signed receipts bound to their exact identity/device/resource/request and authorization hash. No board or resource policy was created by this read probe. Evidence: `/tmp/rusty-owner-production-baseline.json`, `/tmp/rusty-owner-production-after.json`, `/tmp/probe-rusty-independent-owners.mjs`.

The second deployment failed during preparation; the previous writer stayed healthy. Its remote authenticated image pull timed out fetching a GHCR OAuth token. A direct scoped authorization probe with stored host credentials returned 403; anonymous authorization succeeded. Adapter `c7b5798…` changed preparation to a public digest pull with temporary isolated Docker configuration, avoiding shared/expiring host credentials. Its first execution exposed an additional adapter error: inherited stdin prevented SSH from receiving its script, so preparation performed no work and the subsequent image verification failed before shutdown. Adapter `8530151…` fixes stdin to a pipe; a focused test fails without that contract. A separate real host pull then downloaded and confirmed the exact digest before final CI activation. No shared server credentials or package visibility were changed.

This release does not establish repair of the separate owner credential freeze, real owner-to-editor Rusty configuration delivery, same-computer mesh churn, intake, or remaining UI issues. Tickets remain Doing until the user personally verifies browser behavior.


### App implementation evidence (2026-10-21, pending CI deployment)

- Directory sizing follows the window content container. Board identity/owner and
  compact action groups no longer inherit full-height row action styling; Active
  stays beside the title. Desktop Sync places participant selection beside a
  selected person's device cards, stacking when its own window narrows.
- Four isolated real-route browser scenarios pass: board discovery/search/pin/
  rename including empty-name failure; desktop selection, maximize, device
  scrolling and resize; mobile independent list scrolling; offline status.
  Default/maximized/narrow screenshots inspected. CSS and application type checks
  pass. Browser server used unused port 4277, not an existing user server.
- Publication visibility is read before resolving editor delivery authority.
  Private 404 finishes quietly without reading publication credentials; confirmed
  public missing authority blocks with Open Sync, with no timer retry loop.
  Closing Sync retries a blocked delivery once. Disposal prevents late authority
  work. 31 focused delivery/coordinator/diagnostic tests pass; recovery scenario
  was confirmed failing before the close-Sync retry was added.
- Mesh warnings and selected lifecycle events export independently of verbose
  packet logging under existing device consent. Limit: 120 automatic records per
  minute per page with next-window suppression count; local ring remains 500.
  Safe correlation attributes and exception redaction are exercised. This adds
  evidence collection; it does not establish a transport churn fix.
- A read-only TinSink query found no intake/challenge/reflux spans in the last
  day. This absence does not prove the form route succeeded or failed. Actual
  submitted POST and owner saved transition phase remain unresolved.
- These changes do not include the earlier unfinished generic pending-operation
  UI patch; that patch remains uncommitted pending owner-operation evidence.


### Owner session and bounded contention evidence (2026-10-21)

The user explicitly allowed inspecting the owner Chrome tab for Rusty. The live
Job search tab runs 07c9768, is owner, and reports both profile and board sync
paused. Its retained device-removal entry is for Valiant Squirrel
(`kNWC3ygQVcavZzs3cXe5GM6cRf3GNanGl-_M8p5VQSM`); progress reports
`Automation instance Rusty storage epoch or service pin does not match this scope`.
Reviewing its saved confirmation listed only `https://ingest.meta-uber-engineer.dev`
and no workspace-removal entries. Review was cancelled without confirming a new
removal. This establishes a device-revocation operation, not a generic credentials
conflict. Its exact transition-journal confirmations still require inspection;
the combined epoch/pin error does not distinguish those two mismatches.

Source maps that error to `inspectAutomationRoute`, called during complete Worker
cohort discovery before `confirmTransitionPerson` begins Worker freeze/drain and
person revocation. A local origin freeze and journal are currently created before
that discovery. Thus a discovery failure can leave ordinary replication paused;
this ordering is a confirmed design flaw. It is not proof of the live journal's
remote mutation phase, and does not authorize deleting it or its captured keys.

A deterministic mechanism probe used the pinned SDK unchanged: three separate
raw connections sharing one synthetic browser endpoint, each with a document
response and heartbeat acknowledgement read. All responses finish in 25 ms;
maximum active reads stays two. Four reads succeed, two are immediately rejected
with `Mesh stream concurrency limit exceeded`. No offline transport or leaked
connection is needed. This reproduces legitimate cross-workspace burst rejection
under the shared peer budget, not the complete browser reconnection loop.
The peer-wide two-frame/32-MiB bound is intentional in core ingress policy;
removing it or arbitrarily raising it is not the selected repair. Idle response
reads also reserve the entire frame slot before bytes arrive; scheduler/admission
and liveness must be evaluated together.

CI 39591271795 passed the receive mutation contract, application quality, unit
coverage, adapters and production build before npm audit rejected markdown-it
15.0.2 (GHSA-gfr2-rv44-r23c and GHSA-vfgh-jcmw-g37q). Patch 15.0.3 is the published
fix; nine rendering tests pass and the updated lockfile audit reports zero
vulnerabilities. A new CI release is required; this is not a deployed fix yet.

### Continued recovery and CI evidence (2026-10-21)

Owner retried the original saved removal on the issues board. It failed again
with the same combined automation storage epoch/service-pin error; its saved
intent remained pending. No successful unfreeze or participant replication is
established. The recovery view now describes the validated journal's phase and
offers resuming that original operation on its original signing device. It does
not expose captured keys or delete the journal. Detailed worker errors distinguish
an epoch mismatch from a different service identity.

New removal preparation performs read-only automation inspection before creating
the origin freeze. The inspected credential bindings must still match at commit;
normal replication progress during inspection is retained. Regression tests
confirmed the old ordering froze replication on inspection failure. Focused
recovery/freeze/journal/worker/controller checks pass (74 tests). Existing retained
operations still resume their original journal; this preventive ordering repair
alone does not recover the live owner's transition.

CI 39592370531 fails the real same-identity credential-transfer scenario in
`complete-device-state.spec.ts`. Both attempts fail to receive private Rusty
settings; traces also contain stream-concurrency rejections. A local rerun can
pass while still logging those rejections, so the defect is intermittent. At
11:45:29.656 UTC the owner browser logs three workspace stream-limit rejections
for peer qz0YtH; one millisecond later its heartbeat reports an empty pairing
header. The stream rejection handler closes its send side without an ACK. The
empty header is therefore an observed consequence of that rejection sequence,
not evidence of a corrupt saved board.

The deployed stylesheet contains invalid `border-image:!important` declarations:
Lightning CSS 1.33.0 drops `none` from the shorthand. That leaves global square
ink active on count and presence circles. The source longhand
`border-image-source:none` survives production minification. Compiler validation,
production build and existing desktop/mobile board filtering/moving scenarios
pass; a production screenshot confirms circular count and presence outlines.

Current connection setup takes a single workspace ID and enrolls only that
board. Authenticated mesh metadata carries board-specific access to authorized
participants, independently of private identity settings. A report that Rusty
appears on only one of two boards requires checking owner configuration on both
against received editor access; automatic enrollment of all owner boards is not
implemented or established as the cause of this particular report.

Owner issues-board inspection confirms no configured Rusty entry, only Add
Rusty, while the retained Valiant Squirrel removal is still pending. Thus the
absence on this board precedes editor delivery; a new setup is blocked by the
same origin-wide freeze. This does not establish configuration on every other
board, nor successful recovery of this one.

The transport candidate separates bounded header waits from payload admission.
Native WASM inspects the bounded pairing header before requesting a payload
reservation; header bytes share the existing 32-MiB peer budget and two payload
frames remain the cap. A separate finite header-wait allowance prevents idle
responses from occupying both payload slots. Legacy WASM retains conservative
full-frame accounting. Two regressions fail before the change and pass after;
44 transport tests, three native ingress tests and app types pass. The real
Chromium/mobile WebKit private-credential scenario completes in 18.3 seconds
with zero concurrency/header-missing warnings on either page; its baseline
passed while emitting 13 matching warnings.

That scenario also exposed an enrollment helper race: it closed the host after
only the recipient displayed completion. It now waits for both actual terminal
confirmations. The functional credential/capability/progress assertions remain;
no timeout increase or test removal was used. Production mesh stability and
owner-offline participant replication still require deployed verification.

The separate three-identity board-storage scenario also passes after staged
admission (38.2 seconds): close the owner, cold-start editor/visitor with relay
WebSockets blocked, publish an editor change, observe it on the visitor through
Rusty, verify zero visitor PUTs, then stop Rusty and observe Unavailable. This is
isolated acceptance evidence, not recovery of the real owner browser.

Pinning app CI to the actual live Rusty source 4cce540 exposes another regression:
the public-delivery native scenario fails with `Publication owner management
policy required`, while all eight native storage/management/archive scenarios
pass. A publication created without a board management record does not retain
the owner's public identity for later editor delivery after the global owner pin
was removed. The requesting editor must never become that owner. Correct
per-board owner identity retention and safe treatment of existing records are
required before the public-delivery path can be considered repaired.

Rusty repair `ded16d6b8f74cc0ebcc566154a0430e5c85a6f67` retains the verified
per-board root identity in service-signed auxiliary evidence without changing
publication schemas. Legacy signed board/person management evidence remains a
valid source of that identity. It rejects editor self-promotion, foreign claims
after an interrupted commit, copied/tampered evidence and conflicting owners.
Review caught a retry durability gap; retries now reconfirm all parent directories
even when the owner file is already visible. All 109 server tests pass, and the
previously failing application public-delivery native scenario passes unchanged
against the repaired binary. See `rusty-owner-review.md` for scope and limits.
Rusty CI 39598858224 is pending; this is not an activation claim.

MetaMesh PR 5 merged preserving candidate `5b02ed1…`; its formal, complete
Rust/WASM/TypeScript verification, Apple/mobile and consumer checks all passed
(CI 39596778353). The application pins that exact published commit.

### Two-board live comparison (2026-10-21)

The same Codex/editor browser identity shows `ingest.meta-uber-engineer.dev`
on Ecky issues (`6c5432fe-9361-46ad-9c2f-31977c94a609`), with Board access,
read and write, and a confirmed last sync. On app issues
(`5962c240-cc49-4841-8353-5d172a48724e`) the editor has no received connection.
The owner's Chrome view of app issues also has no configured Rusty record,
only Add Rusty; it still reports Valiant Squirrel removal pending with the
automation storage epoch/service-pin mismatch. Both app clients remain on
07c9768. The discrepancy is therefore visible before participant exchange on
this particular board, not proof that editor access is generally unsupported.

`connectWorkspaceReplica` enrolls exactly its workspace argument.
`withWorkspaceRustyAccess` selects configurations for that workspace and sends
role-limited access to authenticated participants. Configuring one board does
not configure every board owned by that identity. Verify two separately
owner-configured boards through the same editor, including switching/reopening
and owner-offline edits; never infer that a server visible on one board was
successfully added on another.

Rusty deployment 39599470611 has since completed successfully; live health
reports ded16d6b8f74cc0ebcc566154a0430e5c85a6f67 with the unchanged service
identity. Application CI 39599019212 passed native public delivery and Chromium
credential transfer, but its WebKit archives/attachments enrollment scenario
failed. The application frontend has not activated the new source yet.

The WebKit trace shows the first history archive waiting 9.54 seconds, while
the repeated action appears successful after only 16 milliseconds: its previous
success notice remains visible during the prerequisite sync. Enrollment then
starts while the second generation is being published, and correctly rejects a
changed history descriptor. A controlled pending HTTP request reproduces the
stale completion deterministically. Hide that completion while the current
archive is busy; the same complete two-generation phone enrollment, backup and
owner-offline restore scenario then passes in 48.3 seconds. Native ancestry
verification and existing timeouts remain unchanged.

Owner-record absence alone does not establish that configuration never completed.
Historical review identifies a separate data-loss path in
`afd592f34b665b26a309c7ed7995d51710bf36e1`: it replaced v1-to-v2 migration with
deletion of retired records. With no v2 state, `read` creates an empty v2 state
and then deletes the legacy keys without a migrated marker or evidence that
all source connections were retained. A client skipping the intermediate release
can therefore lose old connection records. Late legacy-tab writes can also be
deleted after v2 exists. This is a source-confirmed regression; the real missing
app-issues record's provenance is not yet established. Preserve legacy source
records rather than automatically importing obsolete credentials or discarding
their removal evidence.

The repair removes the automatic purge from ordinary repository reads/mutations.
The names-only compatibility predicate for old recovery journals remains; legacy
bytes still cannot become credentials or transaction dependencies. Four deletion
regressions fail before this repair. All 54 focused repository/conflict/transition
tests pass afterward, covering skipped-release reads and saves, late older-tab
records, retained removal tombstones and recovery activation. This prevents
further deletion; it does not recreate records already removed by a prior client.

### Fresh reset and reviewed client follow-up (2026-10-21)

The requested server reset completed at 13:11:57 UTC. A full pre-reset archive
was retained outside the active volume; only the service identity key remained
in active storage. The unchanged service key means old service-signed management
capabilities remain cryptographically valid even though their revisions no
longer exist on the server. Explicit local Forget therefore archives exact old
settings/journals and removes their active authority atomically. A device-local
reset-origin marker prevents peer replay of old capabilities; fresh direct server
evidence is required. It does not revoke another participant or erase browser
boards, profile, attachments, or other origins. Owners and admitted participants
may forget their own access; only owners can configure fresh board storage.

The existing native Rusty journey now covers a real server reset with its key
retained, frozen local intent, Cancel, Confirm, fresh Add, new board/profile
scope IDs, uploads to both scopes, unchanged person/device IDs, and preserved
board data. It passes in 32.8 seconds. Seventy-two focused logic tests cover
atomic journal conflicts, profile/admission guards, other origins, editor-only
local reset, stale peer replay and fresh server authority. New connections are
not a claim that the real owner/editor setup has been completed yet.

Fresh profiles no longer generate adjective/noun names. Neutral internal metadata
keeps the protocol compatible; an atomically persisted provenance marker leaves
the actual Name field blank until the user chooses a name. Explicit profile saves
clear that marker in the same transaction. Existing chosen names and signed
identity/certificate data are retained. Historical generated device labels are
replaced only in presentation. Sixty-two focused tests and three existing browser
journeys cover failed persistence, reload, explicit choice, and pending device
removal at desktop/mobile sizes.

The reported mobile one-letter member name comes from the old four-column layout:
the long role consumed the remaining name column. The deployed c4 layout places
the role below the name. The existing WebKit mobile selection/scroll journey with
a named successor and twenty devices passes in 4.4 seconds; its inspected image
shows readable names and role without horizontal compression.

Application CI 39603430548 passed all jobs after rerunning its failed verification
job. Frontend deployment 39607136695 activated c4dc4d1 with MetaMesh 5b02ed1.
Automation deployment 39607136580 failed before activation: it requested an
attempt-two cohort although packaging had already succeeded in attempt one.
This requires explicit artifact-attempt selection with the original seal checks.
The production Quick note keyboard/save/reload journey and its failed-save draft
retention/retry journey also passed in isolated production contexts (8.2 seconds).
The real issues-card note was saved and observed after reload; ITEM is absent
from that card header. Tickets remain Doing pending the user's browser review.

### Follow-up verification and remaining delivery faults (2026-10-21)

All known Chrome/IAB sessions were updated to c4 without discarding drafts. The
new local traces contain no stream-budget/empty-header errors in the inspected
windows, but retained instance slots still produce repeated Iroh dial failures
while another authenticated session exchanges workspace frames. The scheduler
was missing signed lease expiry when deciding which retained sibling to probe.
A focused regression proves that expired sibling routes are skipped only while
the same board/device has a working session; unexpired siblings and expired
offline bootstrap remain available. Safe local route attempt/suppression fields
will establish whether the particular production slots have expired; that exact
causal attribution remains unverified. Seventy-nine session/startup/credential
tests pass. No stored routes, stream limits or admission checks were removed.

The first names/reset CI exposed a real blank-name photo-save regression and an
ambiguous roster assertion. Photo-only saves now preserve unnamed provenance and
use the signed photo transaction with a captured revision guard; combined chosen
name/photo saves retain the atomic profile/root commit. The complete Rusty phone
photo journey passes in 32.9 seconds; all four avatar journeys, large-history
mobile cold reopen, profile pending/conflict handling and sixteen focused units
pass. Roster verification now proves exactly one self/owner remains after signed
revocation, without comparing potentially identical display names.

Reset review also found the reported legacy-deletion case could retain a freeze
without any current connection. Explicit Forget now accepts origin-bound freeze,
setup or signed management evidence without active v2 credentials; it archives
those sources and writes removal tombstones for known scope references. Unknown
origins without any connection/intent still reject. Seventy-three related reset/
management/preference tests pass. The full native WebKit publication/file/restart/
withdrawal journey passes in 27.3 seconds after dropping its redundant manual
sync-button timing check and fixed sleep; publication proofs are retained.

Actual c4 browser warning records are now confirmed in TinSink/ClickHouse, with
workspace, peer and runtime correlation and captured failure stack. The collector
logs expose a separate delivery problem: ClickHouse intermittently rejects log
and trace insertion with code 241 at its 1.80 GiB total memory limit while the
collector retries its persistent queue. Read-only inspection showed about 547 MiB
RSS and small failed inserts, so the source of tracked memory pressure needs
investigation before changing limits. HTTP 200 alone is not durable row proof.
The new private-board Settings view contains no public-delivery failure/retry;
the live c4 directory has compact separate actions, content padding and an inline
Active badge. Screenshots were inspected. Board tickets remain Doing.

### TinSink memory pressure: confirmed cause and live repair

ClickHouse 26.8.11.7-lts runs with 2 GiB / one CPU. `system.metric_log`
contains 2109 columns. `system.part_log` identified repeated horizontal metric
merges peaking near 1.54 GiB with code 241, while failed OTel inserts required
only about 1.6 MiB. A live 33-part merge contained only 110536723 uncompressed
bytes; this was per-column pipeline overhead rather than a large telemetry
payload. Reducing merge block rows did not help. Aligning Compact/vertical byte
thresholds at 128 MiB also left this merge horizontal; capping its fan-in at four
still reached 1.27 GiB. All those trial overrides were reset.

The deployed version's `MergeTask.cpp::chooseMergeAlgorithm` requires a Wide
result, at least eleven ordinary columns, and both row and byte thresholds.
Its default 131072-row gate keeps smaller Wide metric merges horizontal. At
14:10:07 UTC the operator set only this table's
`vertical_merge_algorithm_min_rows_to_activate = 0`, retaining the normal part
format, collection, data, retention, and container memory limit. The first
successful vertical merges peaked at 14–25 MiB. Over the first five minutes,
eleven metric merges completed with zero errors; small Compact horizontal
merges peaked below 76 MiB. No other table reported a failed merge in that window.
The collector emitted no errors after the change. Fifty actual c4 browser
warnings at 14:11:18 UTC reached `otel.otel_logs`, with workspace/peer/source
revision correlation, in addition to continued live Rusty records.

The existing table metadata is 310 KiB. The targeted ALTER requires a 512 KiB
query-size limit for that operator session only; the global/user limit remains
unchanged. `operations/metric-log-merge-budget.sql` records the exact change and
rollback. Published infrastructure `a3c8251` declares the matching metric-log-only
XML setting and accessory config mount. The current container also has that XML;
`extract-from-config` confirms it. A future accessory recreation needs the new
infrastructure pin; that delivery remains to be completed with the pending Rusty
pipeline change. No server restart, table deletion, collection disablement, or
telemetry filter was used.

### Latest client CI precondition repair

Verify 39611380824 finished with fifteen successful jobs. Its only failed job
was core 1/4: three chat scenarios asserted an automatic nonempty Name before
the user's requested explicit-name flow. Both shared preconditions now expect
blank; chosen-name/message reload persistence and failed-write draft/retry
scenarios remain. The full nine-case chat suite passed in 28.2 seconds. An AST
and text audit covered all e2e Name/value assertions; no further automatic-name
preconditions remain. Commit `494d566` starts Verify 39614133884. Live owner
reset/reconnect still waits for this verified client release.

### Live fresh Rusty reconnect and the diagnostic body contract

All sixteen 494d566 Verify jobs passed. Frontend 39617669841 and automation
39617669938 succeeded; `/health` reports source 494d566, SDK 5b02ed1 and cohort
87787e4e63bb50700915ab5e36521fb9596158dbf581491fad291157f44579c9.
After checking there were no drafts, the authorized Bo/owner issues-board tab
loaded that release. Explicit Forget archived its old origin-bound settings and
operation, then fresh Connect to the existing ingest origin succeeded. Board and
profile show Synced with advancing receipts. The distinct Codex/editor IAB tab
automatically received the connection and shows Synced / Board access · read and
write. Screenshots of both views were inspected. Old per-device removal progress
still displays the abandoned server phase; this is separate stale presentation.
Owner-offline/visitor exchange and the second real board remain unproven. The
existing Chrome permission covers only Rusty on this board; expanded permission
for the remaining test was requested. The board ticket was updated and stays Doing.

ClickHouse repair continued without merge errors: thirty-four successful metric
merges through 14:30 UTC, peak under 93 MiB. A tagged single-record production
diagnostic returned HTTP 200 and was found in `otel.otel_logs`. However, actual
browser incidents continued locally without regular collector rows. SQLite
admission showed only fifty records against a 50000-record hourly budget, so
project quota was not the cause. TinSink's source enforces a 65536-byte request
body. A synthetic fifty-record long-stack batch produced 869147 bytes and the
live route returned 413; an existing-SDK focused regression produced 917693 bytes.
This proves an additional export-contract defect. It does not establish the
exact payload of every earlier missing browser request.

The client now sizes batches with the official OTLP JSON serializers, splits
oversized bodies, and retains the official authenticated HTTP exporters. Each
signal has at most two export requests; after a transport failure the unsent tail
is counted as dropped, while completed successes are preserved. Later SDK batches
can try again. Existing per-request timeout, processor timeout, record budget,
record-count batching, incident sampling and server limits stay unchanged.
Exception message/stack limits now count UTF-8 bytes, retaining whole characters
and existing redaction. Opt-out stops unsent split bodies, with no double counting
of the queued records already abandoned by shutdown. A focused opt-out regression
failed before this cancellation guard; all 51 relevant units now pass. All ten
browser telemetry journeys pass, including a fifty-error burst through a 64 KiB
intake, chat reload, outage, access rejection and opt-out. Types and targeted lint
pass. This exporter change is not deployed at this checkpoint.

### Recovery tap lost during background synchronization

The exporter candidate ad0a6ee passed fifteen CI jobs; its remaining failed
automation job contains a mobile Chromium recovery trace. The conflict remained
visible, no recovery management/upload request occurred after the tap, and no
failure message appeared. Playwright observed Recover disabled, then enabled
while waiting for actionability; it dispatched the touch immediately afterward.
The app disables this button with the same `busy` flag used by ordinary background
sync and guards its click handler with that changing flag. A background pass can
therefore disable/cancel an already-targeted mobile click. The live owner Forget
button also needed a second press during ordinary sync. A local Chromium replay
passed in 13.5 seconds; the CI trace, not a repeat-pass claim, establishes the
missed-action case to repair.

Manual mutations must reserve one user action, retain the identity/device/active
workspace guard captured at request time, wait for any existing background pass,
then run the existing guarded operation exactly once. Background triggers must
not start another pass while that action waits. Only the stable manual-operation
flag disables its controls; background `busy` remains available for health/status.
No signing, ownership, journal, scope or storage precondition is relaxed.

The corrected browser scenario now deliberately holds an ordinary profile GET,
requests recovery while that background pass remains pending, observes the
reserved action, and confirms no recovery upload starts before releasing the GET.
It then exercises the existing snapshot 503, reload and successful retry with the
original board and key retained. Native WebKit passed in 15.0 seconds; Chromium
passed in 13.5 seconds. The four native Rusty journeys passed in 1.6 minutes.
The six relevant logic suites passed all 58 tests, including rejection when the
identity or active workspace changes while a request waits.

### Forgotten Rusty origin retained in device-removal progress

The real fresh owner connection and editor board delivery both reached Synced on
494d at 14:37 UTC. The remaining device-removal warning was a different local job:
explicit Forget archived Rusty credentials and management journals but omitted
the per-identity device-removal job's selected-origin phase. That stale phase did
not prove a failure of the new connection.

Explicit Forget now archives the exact saved job alongside the other reset
records and removes only the selected server phase. Other servers and workspace
removal intent remain. No access is reported revoked by this reset. The job lock
precedes the existing origin/freeze locks; the same atomic comparison checks the
saved job before committing. A newer job aborts the entire reset. Preferences
notification refreshes the displayed progress without reloading the board. The
native reset journey checks cancel preservation, archived exact intent, fresh
scopes and retained browser data. Past resets are not silently reinterpreted;
already-stale jobs still require an explicit reset after the fix is deployed.

### TinSink persistence and Rusty build cache checkpoint

Infrastructure a3c8251 persists the metric-log vertical-merge setting. Rusty
a910b70 passed verification and deployment, pins that infrastructure revision and
reports the expected build SHA through health. Its release build successfully
exported the Linux amd64 intermediate build cache. This first cold build took
162.9 seconds for dependencies, 18.4 seconds for the application and 142.9 seconds
for cache export. A source-only warm build has not been measured; no speedup is
claimed yet. The frontend exporter byte-budget correction remains pending its
next successful CI/deployment, so full-chain diagnostic reliability remains open.

### 4cc rollout and read-only Rusty inspection

4cc7139 Verify 39624989598 and frontend/automation deployments 39626963174 /
39626963166 succeeded. Live health returns that exact SHA, artifact 90f3bad3 and
SDK 5b02ed1. The Codex editor tab loaded the new version. Its startup records are
durable in ClickHouse with service.version 4cc7139, but subsequent local warning
events are not yet confirmed there; add diagnostic export state to the existing
read-only WebMCP trace so this gap can be investigated without private browser
storage inspection or changing device consent. Do not treat startup-only rows as
proof of continued connection-failure delivery. Metric-log evidence now contains
141 completed merges since 14:10:07 UTC with zero errors and peak tracked memory
112712071 bytes; the configured ClickHouse memory ceiling remains unchanged.

Old commit 4c0d15d documents the removed admin surface: owner sign-in, board names,
replication state and operator origin/reset controls. d811e9d removed that whole
readable keeper with the blind-store replacement. The current status restoration
does not reinstate its plaintext storage or broad admin authority: the Rusty page
requests an explicit, nonce/deadline/opener/origin-bound snapshot of the approving
Tincanban browser's configured-board statuses. The client output is an explicit
field allowlist; no keys, storage tokens, scope credentials or board contents
cross the browser window boundary. Conflicting credentials remain visible as
Sync paused even when no active configuration can be selected.

Native Rusty browser inspection passed Chromium and WebKit in 15.8 seconds each:
no board names appear before approval, a confirmed board reaches Synced, a later
HTTP 403 becomes Access required with an owner action, and both captured message
payloads contain none of the fixture's actual secret values. Screenshots of both
outcomes were inspected. Four focused client checks cover request validation,
exact-origin filtering, expired/changed opener and paused credentials. Service
message validation rejects foreign source/origin/nonces, replay, oversized data
and unsafe IDs; a Rust unit verifies embedded config cannot close the JSON script.
109 existing service tests and the extra config unit pass. Service revision
359d998 is published on codex/rusty-storage-status with its own verification run;
Tincanban CI pins that exact revision for the existing native acceptance project.
Activate the service UI only after Tincanban confirmation support is deployed.

### CI receive-observation race, 2026-10-21

Verify 39628988046 failed the existing durable-storage rejection scenario twice
at its all-attempts-failed assertion. The retained Playwright traces distinguish
an unfinished persistence attempt from an invalid saved-state acknowledgement:
both runs observed two failed attempts followed by a third with `failed=false`,
`persisted=false`, `responseSent=false`. A later observation also caught a fourth
pending attempt. Every final attached attempt had failed with neither persistence
nor a response. There is no saved-state acknowledgement in this evidence.

The test already waits for one storage rejection, but parallel streams can start
another receive before its immediate all-attempts assertion. Await that same
strong condition instead: at least one matching receive, every observed receive
rejected, none persisted or acknowledged. Keep injection active during the wait,
then restart the actual node, recover storage and require replay plus a persisted
response. The corrected full scenario passes locally in 33.7 seconds against the
real Iroh transport; no production protocol/storage code changed for this race.

The Actions audit also found Rusty outside the previously deployed cleanup scope:
52 artifacts occupy 144,583,189 bytes, mostly repeated sealed source/deployment
copies. Its source retention is 14 days while deployment retention is 90 days;
the currently active source seal expires on November 4. Extend guarded cleanup
to Rusty's actual seals/health and retain the active plus distinct compatible
rollback source/deployment pairs. This is a separate release-recovery gap from
the already reclaimed 11.30 GB in the other three repositories.
