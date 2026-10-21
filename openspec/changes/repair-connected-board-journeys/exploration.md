# Repair connected board journeys — investigation

Date: 2026-10-21. Status: explore. No application change in this investigation has been released.

## User intent and release gate

Keep one tracked list; add subsequent reports. Understand the real scenarios before implementing more migrations or recovery UI. Deliver fixes through CI. Never move tickets to Done until the user personally verifies the deployed browser behavior.

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
