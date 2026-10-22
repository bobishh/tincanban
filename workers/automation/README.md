# Cloudflare automation worker

Production Worker preserves the signed public HTTP API and forwards requests to
Reflux. Reflux reactions own classification, participant identity, state and
retryable writes. The Worker has no production execution fallback. Its Durable
Object adapter remains for isolated domain tests and local development; with
`REFLUX_ORIGIN` configured, it neither opens participant state nor processes alarms.

`REFLUX_SERVICE_TOKEN` authenticates this HTTP bridge. Owner signatures and the
configured public origin remain required by the existing domain handlers. Gateway
failures retain their HTTP status and return bounded JSON errors. Legacy website
challenge/intake requests go to the existing public Reflux intake route. See
[reaction engine](../../services/reaction-runtime/README.md).

The contracts below describe the shared participant domain. Reflux persists its
nonce, idempotency, replica and upload receipt state. Completion still requires a
signed Rusty upload receipt; uncertain classification and unavailable authority
retain review or retry state.

When `REFLUX_ORIGIN` is configured, email ingress sends the normalized event and
retained MIME to Reflux over the authenticated private ingress route. The stable
event ID and raw-MIME digest support exact retries; Reflux owns durable queuing and
deduplication. Only a durable event-ID conflict rejects mail permanently. Gateway,
timeout and malformed-outcome failures throw so the mail platform can retry; the
email path never falls back to Durable Object processing.

Reflux routes these signals to the **Job search automation** reflex, with its own
workflow and run history. The reflex references the existing board participant;
identity, grants, sync state and pending writes remain shared. Its creation and
source activation must complete before mail ingress can acknowledge delivery.

Unchanged snapshots reuse the last confirmed upload. Wire JSON uses canonical key
ordering and omits absent optional grants on owner proof wrappers; signed payloads
remain intact. This prevents a first self-echo from creating an extra encrypted
object when the verifier returns `grant: null` and proof merging omits it. Older
pending ciphertext remains reusable across this normalization upgrade only when
its full snapshot, including authorization and chat, matches current state. Actual
document/proof/chat changes still require upload; expired grants still prevent sync.

The instance API supports `refresh-access` for a previously
approved Worker after its Rusty scope policy advances. A fresh signed current
Owner request carries the existing public storage pin and a Rusty-signed floor-2
receipt. The Worker verifies both authorities and commits only the policy revision,
writer-floor marker and replica binding under a durable generation comparison.
It preserves the grant/expiry, control state, pending ciphertext and request IDs,
deduplication and cursor, including expired or paused/deleted instances. The reply
is a nonce-bound signed Worker identity with public storage confirmation; it does
not renew authorization, activate work or synchronize. Repeating the action is
idempotent. Browser writer migration preflights compatible instances, durably
retains receipt/route evidence and waits for those confirmations before local
activation. Older Workers need a compatible rollout first; live untyped grants
require explicit route adoption/removal. Each deployed component reports its own
release identity; automation does not require a matching frontend or Rusty release.

## Compact history maintenance

The protocol provides `prepare-history-baseline` and
`activate-history-baseline` under fresh signed current-Owner requests. Preparation
persists a separately admitted scope trust anchor, confirms the exact original
outbox, uploads any remaining admitted snapshot, then freezes execution with a
durable transition ID and signed source frontier. It preserves grants, expiry,
event deduplication, storage keys and desired state. Identity inspection remains
available while alarms and other authoring/maintenance paths stop.

The Owner drains these originals before publishing an archive-backed compact
snapshot. Activation receives into an isolated candidate, verifies the Owner
attestation and bounded signed tail through Native admission, and proves every
frozen head exists in the authenticated archive catalogue. One generation-checked
transaction publishes the encrypted candidate, writes the exact completed marker,
and removes the freeze. Unavailable archives, uncovered branches, pending uploads
or rejected evidence preserve the original durable state and freeze for retry.
Fresh-nonce retries bind the original transition, pinned storage and baseline ID;
they do not renew an automation grant or manufacture an Owner signature.

State reader 5 and workspace snapshot reader 2 are required; the signed descriptor
and encrypted basis/coverage evidence survive restart and are reverified offline.
[Worker runtime tests](tests/replica.runtime.test.ts) cover frozen execution,
Native verification and activation. Browser acceptance in
[attachment-session-recovery.spec.ts](../../e2e/attachment-session-recovery.spec.ts)
covers compact history, cold receivers and offline recovery. These checks do not
establish which automation Worker version is active in production.

## Application sources

The registry supports `job-intake@1` and `job-intake@2`; new browser approvals use v2.
The v2 owner-signed automation scope declares `board.application.source.append` in addition to v1's
three permissions. Card creation and its immutable original posting observation
are one signed CRDT change. The source comes from extracted URL content, independent
of display labels; missing/oversized evidence is recorded as unavailable without
invented original fields. Existing v1 approvals are preserved until explicit owner
upgrade, and v1 cannot append sources. Ordinary moves still accept unchanged
source metadata children.

Matching uses admitted original records when present, including exact retained
URLs. It does not refetch or overwrite the original, use refresh text as historical
evidence, or match editable card/thread fields. Missing/conflicting evidence needs
review. Source IDs and workflow are checked again after sync. Pre-source v1 cards
retain their URL lookup during migration.

The coordinator implements private owner-signed retained-mail binding and explicit
bound retry. The proof covers exact routing and definition IDs, original event,
source digest, retained classifier decision, grant, access epoch and dated workflow.
Current Owner/device authority is checked through compiled Rust policy after sync.
Immutable encrypted history, current binding pointer and saved audit commit in one
SQL transaction; correction requires the current parent. Saving does not queue an
action. Retry never reclassifies the message or bypasses date/forward-only rules.
Lost upload receipts retain a pending event and exact signed action hash; applied
audit and event success commit only after confirmed upload. The old unbound retry
rejects bound events. The `/v2/application-review/{discover,list,review,bind,retry,retry-unbound}`
API authenticates a fresh complete-chain Owner request, exact action/body/origin and
60-second nonce, then checks native current Owner/device rights after synchronization.
Encrypted bounded nonce outcomes cannot bypass later device revocation. Discovery
keeps typed definition and legacy routing IDs separate. Mailbox responses carry
bounded retained subjects/reasons and a verified-context Worker observation bound
to the request nonce. These are signed API/client operations. Settings intentionally
has no retained-email processing feed, manual application-selection queue or
save/retry controls; the broader Inbox/mail UI remains specification only.
Unbound retry uses the exact discovered route and fresh Owner proof; it cannot
bypass an existing binding. Action support is advertised separately; malformed
capability metadata never enables an older API fallback. Historical expired-grant
integrity can be used only for renewal with a separately validated live approval.
Expired instances remain inspectable through current-Owner management; ordinary
execution and restore still fail closed. Pause state, pending ciphertext and event
deduplication survive renewal. Untyped legacy routing requires explicit adoption.
API and durable binding behavior are covered in
[applicationBindingStore.runtime.test.ts](tests/applicationBindingStore.runtime.test.ts),
[applicationReceipt.runtime.test.ts](tests/applicationReceipt.runtime.test.ts) and
[replica.runtime.test.ts](tests/replica.runtime.test.ts); they do not establish a
production rollout or an Inbox UI.

## Archive transport evidence

The shared encrypted archive transport runs under Workerd in
[archiveTransport.runtime.test.ts](tests/archiveTransport.runtime.test.ts):
sealing/opening, pinned storage, batch/aggregate receipts, complete-set verification
and live generation invalidation use the shared SDK implementation. Coverage trees
stream sorted expected ciphertext IDs into leaves of 64 and branches of 8. A signed
subset is rejected even when its root object is present. Receipt aggregation
composes previously issued receipts; it does not promise availability after later
storage corruption.

The preparation journal persists `captured`, `archived` and `covered` phases. Its
[Durable Object storage adapter](src/historyPreparationStorage.ts) encrypts SQL
values with context-bound AES-GCM, rechecks ciphertext and the live guard inside
`transactionSync`, and scans bounded pages. The adapter's CAS, interrupted-resume,
rollback and context-substitution cases run in
[historyPreparation.runtime.test.ts](tests/historyPreparation.runtime.test.ts).
This reusable preparation adapter is separate from ordinary automation scheduling.

The Owner browser uses the actual WASM capture handle to retain original signed
records, emit the source-derived catalogue and verify encrypted locator/data
coverage before confirming a compact basis. The Worker participates through the
freeze/receive/activate protocol above; its restricted Automation grant cannot
produce an Owner attestation. An encrypted locator directory supports cold readers
without a sender-local flat locator list. Native/HTTP interoperability is exercised
by [rustyManagement.native.test.ts](../../src/sync/rustyManagement.native.test.ts);
browser acceptance covers lazy entity history, restoration through a fresh signed
command, two archive generations and private offline recovery. Retained original
classifications are evidence, never a serialized authorization flag.

## Job priority

Opportunity policy `lead-clef-v2` asks Clef for company recognition, company
stability, stack match and work profile match alongside relevance, role and
seniority. The owner-configured board `employee_profile` is read from the admitted
replica after synchronization and passed as structured context. Intake cannot
supply or override this profile. Company evaluations require supplied evidence;
no current financial facts are invented from a company name.

Each assessment choice retains its probability map. A winner below 0.7 or a
margin below 0.2 becomes unknown; unknown earns no points. Strong/partial/weak
map to 10/5/0. Shared weights are 20/20/30/30 percent. Decisions contain the score
and selected board priority option ID (default P0/P1/P2/P3 bands without a job
policy). The structured assessment and compared profile are stored intact in
Source text, with human source text separately bounded. Board projection uses the
same evaluator; profile changes invalidate stale stack/work points. No additional
write permissions are granted, and priority never bypasses relevance/authority
checks. These changes require both frontend and Worker rollout.

## Local setup

Use Node.js 22.12+ (Node.js 22, 24, or 26+) and pnpm. Install within this directory so the local `allowBuilds` policy permits only the `esbuild` and `workerd` build scripts used by the test runtime.

```sh
pnpm install
pnpm types
pnpm check
pnpm test
pnpm test:runtime
```

`pnpm dev:e2e` starts the local-only browser-test Worker on Wrangler's default local port. Its separate `wrangler.e2e.jsonc` config exposes `POST /__test/configure` and `POST /__test/email` and contains test-only secrets; never deploy it.

`pnpm dev` runs local Wrangler. The AI binding reaches Cloudflare Workers AI and may incur usage charges when an event alarm performs classification.

Set local secrets in an ignored `.dev.vars` file:

```dotenv
HUMAN_CHECK_SECRET=replace-with-at-least-32-random-bytes
PROVISIONING_TOKEN=replace-with-a-long-random-operator-token
IDENTITY_STORAGE_SECRET=replace-with-at-least-32-random-bytes
EVENT_STORAGE_SECRET=replace-with-at-least-32-random-bytes
TELEMETRY_TOKEN=project-server-write-key
```

Do not commit these values. `IDENTITY_STORAGE_SECRET` encrypts the automation identity seed and device entropy before Durable Object storage. `EVENT_STORAGE_SECRET` encrypts accepted website payloads and both parsed email fields and original MIME bytes before storage. Rotating either secret without re-encrypting the stored value prevents it from loading.

When `OTEL_EXPORTER_OTLP_ENDPOINT` and the project-scoped server
`TELEMETRY_TOKEN` are configured, the Worker emits standard OTLP/HTTP JSON logs
and spans to TinSink. It identifies as project `tincanban-automation`, source
`server`, and includes the sealed release SHA as its service version. The token
stays in the Worker secret binding. Exception messages, stacks and causes are
bounded and redacted; accepted email content, board text, payloads and credentials
are not exported as diagnostic context. Rusty HTTP requests carry W3C trace context
from the Worker span. This source wiring and runtime tests do not establish
production delivery; the TinSink pipeline records its independent full-chain and
deployed-row verification.

## Integration routing

`INTEGRATIONS_JSON` is an environment variable containing an array of configured integration metadata. Each entry has this shape:

```json
{
  "id": "applications",
  "workspaceId": "workspace-id",
  "scope": {
    "version": 1,
    "boardId": "board-id",
    "columns": { "lead": "lead-column-id", "interview": "interview-column-id", "rejected": "rejected-column-id" },
    "fieldIds": { "company": "company-field-id", "role": "role-field-id", "jobUrl": "url-field-id" },
    "expiresAt": "2027-01-01T00:00:00.000Z"
  },
  "emailAddress": "applications@example.com",
  "allowedForwarders": ["owner@example.com"]
}
```

IDs are exact, stable document IDs. `emailAddress` selects the integration from the incoming SMTP envelope recipient. `allowedForwarders` matches the outer SMTP envelope sender exactly after lowercasing; it does not trust a `From:` header inside forwarded content and does not prove which Gmail account forwarded the message. Forwarding services may rewrite that sender, so configure only a value verified from a real delivery to this route. Until that behavior is verified, keep email intake disabled. Set the `CORS_ORIGINS` comma-separated list to the exact browser origins allowed to call the HTTP API. Keep the list empty for server-to-server intake.

The JSON describes routing and stable scope bindings; it is not a signed owner grant. The Worker does not accept a scope as authorization to mutate a board. Activation requires cryptographic grant validation and causal admission.

## Owner-managed activation

The ordinary setup is **Settings → Workspace → Automations → Add automation**.
Owner selects the supported type, names the instance, enters the Worker origin,
and explicitly accepts reading access to the whole workspace. Rusty must already
be connected. The browser enrolls an independent Worker identity, signs the
versioned type definition and exact 30-day Automation grant, commits the public
approval/desired state to CRDT, then privately sends the admitted snapshot and
storage access to the selected Worker. Operator bearer tokens never enter this UI.
Email forwarding shows its private route and activation/confirmation status.
Retained message subjects and processing reasons are available through the signed
API, not a Settings message list.
A clear classification can still need review when vacancy-page matching fails,
the original email date is missing or stale, or the next status is not authorized.
These stops preserve the current card instead of reporting a completed move.
Thread references and exact vacancy URLs take precedence. Otherwise the Worker
reads the saved vacancy URL and matches the email against its original company
and role. Card titles and Role fields cannot authorize a match. Company labels
and company tokens in URLs narrow the page lookup; up to eight distinct pages
are fetched with the existing HTTPS, redirect, timeout and size checks. Missing,
unavailable or ambiguous sources stay in review with an explicit reason. This
also means a renamed role in the rejection still needs review if it differs from
the employer's published vacancy title.
After resolving a source problem, the signed application-review API can retry the
retained event. It preserves original MIME bytes, the event ID and applied-event
deduplication, and rechecks the current grant, matching, original email date and
concurrent workflow before writing. Settings does not expose this as a retry button.

Deployment variable `AUTOMATION_OWNER_IDS` is a comma-separated allowlist of public
root person IDs permitted to enroll instances. Empty disables browser enrollment.
It is deployment authorization, not a workspace setting or secret. Activation
still independently validates current owner authority, scoped grant, definition
signature and every causal document change; the allowlist cannot authorize board
writes. Instances bind durably to one owner/workspace and cannot be reassigned.
Legacy operator endpoints and `INTEGRATIONS_JSON` remain compatible with existing
integrations; new UI instances derive routing only from validated activation.

- `GET /v2/capabilities`: supported type/version pairs and enrollment availability.
- `POST /v2/integrations/{uuid}/identity`: signed owner enrollment.
- `PUT /v2/integrations/{uuid}/activation`: `{ ownerRequest, packet }`; owner
  signature binds origin, instance, workspace, freshness and canonical packet hash.
- `POST /v2/integrations/{uuid}/observation`: signed owner query; returns Worker
  certificate and signed nonce-bound acknowledgement of admitted CRDT control heads.

Owner requests expire in 60 seconds. Browser checks Worker identity, origin,
instance, workspace, grant, nonce, freshness and exact desired heads before showing
confirmed state. Network failure, expired grant and unsynced controls stay pending.
Pause/resume/remove write only CRDT; no HTTP pause switch competes with the owner
record. Durable alarms poll controls every 15 seconds even with an empty queue.
New intake rearms overdue alarms after exhausted platform retries. Admission of
an authored change is reused for its exact document, proofs and authority; control
reads do not repeat that expensive verification. Changed evidence invalidates
the cache, and live grant expiry is still checked. Production retains the Free
plan's default CPU limit.
Pause preserves queued events without spending retries or AI calls. Removal is a
terminal tombstone; retries and stale snapshots cannot resurrect execution.

The registry retains `job-intake@1` and `job-intake@2`; the UI creates v2 instances
with website intake enabled initially.
For an owner-enrolled instance, an operator provisions a private email route in
`EMAIL_ROUTES_JSON` (Worker secret), containing `{ id, address, mailbox }`. Addresses
must contain a cryptographically random 32–48 hexadecimal character suffix:
`jobs-<random>@inbox.example.com`. The recipient acts as a bearer capability;
never put it in public routing JSON, source control, public logs or CRDT.
Cloudflare must route that exact address to this Worker. Legacy recipient routes
continue to require their exact envelope sender allowlist.

Settings displays the private address only to the authenticated workspace owner.
**Enable email and Applied** signs a revised definition and grant for the same
instance, executor and board. Old grants without Applied remain valid. Renewal
admits merged history before saving, retaining outbox and event deduplication.
Storage-changing renewal requires the exact original pending upload to be drained
first; it never replaces uncertain ciphertext with a new encryption. Explicit
`prepare-storage-rotation` and `rotate-storage` management freeze authoring, drain
originals, verify the signed policy transition and retain every old reading key
before publishing fresh credentials. Renewal preserves the same Rusty origin.
The mailbox provider keeps originals and forwards only the existing job filter;
Gmail's verification message remains available for owner confirmation, without AI.

Clear application receipts move matched Leads to Applied. New receipts containing
one extractable public vacancy can create a card directly in explicitly granted
Applied; vacancy announcements can create Leads. Email vacancy assessments use the
same admitted employee profile and priority rules as website submissions.
Ambiguous company/role matches and insufficient vacancy metadata remain in review.
An added instance does not require a release; an added type/version does.

Private activation contains storage credentials, a content key and workspace
history. It is sent only to the approved HTTPS origin (loopback HTTP for tests),
never CRDT or public routing JSON. Rotating encryption secrets without migrating
stored state prevents restore. Each instance uses its own identity, SQLite queue
and encrypted replica chunks with atomic generation publication.

## HTTP and email entry points

Existing-instance management is separate from the UUID-only enrollment API:

- `POST /v2/automation-instances/discover`: fresh signed exact workspace,
  definition and pinned executor identity; discovers configured existing routes
  without provisioning an identity or changing an integration ID.
- `POST /v2/automation-instances/identity`: current native workspace Owner proof,
  read-only Rusty pull, then `automation-instance-identity@1` device-signed
  description bound to the request nonce. Expired approvals remain inspectable;
  they do not permit Worker execution. Ownership transfer/revocation apply before
  returning even an exact cached response. The initial enrollment allowlist does
  not authorize this path.
- `POST /v2/automation-instances/activate`: fresh owner proof and exact packet;
  `adoptLegacy:true` explicitly adopts an untyped existing replica. Typed renewal
  preserves its definition ID independently of its routing ID. Both preserve
  history, pending upload, Worker progress and forwarding settings; replica and
  registration publish atomically. Existing typed/deleted contracts cannot be
  adopted or resurrected.

Each body is `{instanceRequest,body}` under
`automation-instance-request@1`, with a maximum 60-second proof lifetime and a
complete device chain. Read requests are bounded to 384 KiB; activation is bounded
to 24 MiB. Discovery/identity responses carry no private keys, storage credentials,
retained email content or raw workspace history. Capabilities advertise
`instanceManagement.version: 1` with actions `discover`, `identity`, `activate`,
`refresh-access`, `prepare-storage-rotation`, `rotate-storage`,
`prepare-history-baseline` and `activate-history-baseline`.
Independent encrypted, 128-live-request nonce ledgers bind exact outcomes and
reject nonce reuse for different proof/body content. Interrupted activation can
retain a valid approval while reporting missing Rusty confirmation; retry the same
existing instance. The signed management paths have Native/HTTP and Workerd
acceptance; browser flows cover ordinary enrollment, approval renewal and explicit
legacy adoption. Exact production revisions require this Worker's deployment
evidence; they do not imply a coordinated frontend or Rusty release.

- `GET /health` reports Worker readiness.
- `POST /v1/challenge` with `{ "integrationId": "applications" }` returns an HMAC-signed arithmetic challenge.
- `POST /v1/intake/{integrationId}` accepts the bounded website submission plus `humanCheckToken` and `humanCheckAnswer`. Optional `Idempotency-Key` makes client retries return the original event; distinct keys remain distinct events. A challenge nonce can be used once.
- `POST /v1/integrations/{integrationId}/identity` requires the operator bearer token and returns an independent automation identity's public keys and device certificate. Private seeds stay encrypted in that integration's Durable Object.
- `PUT /v1/integrations/{integrationId}/activation` requires the operator bearer token and a signed, scope-matched grant plus admitted snapshot.
- `GET /v1/integrations/{integrationId}/events/{eventId}` requires the operator bearer token and returns redacted event status and decision summary.
- `POST /v2/integrations/{uuid}/email`: signed owner request with the dedicated `email` action; returns private forwarding address, Gmail confirmation link and redacted recent event status. A public status observation cannot be replayed to retrieve this private setup.
- `GET /v1/integrations/{integrationId}/email`: equivalent operator-authenticated setup/status endpoint.
- Cloudflare's `email()` accepts either a private capability recipient or a legacy recipient with an approved outer sender. It never trusts mail header target IDs.

New intake returns HTTP 202 after the Durable Object has stored the event. Clef or page-fetch failures stay retryable and move to `failed` after eight attempts. Unrelated, ambiguous, or not-yet-authorable decisions remain `review`; no response calls those events applied.

## Production deployment

[Deploy tincanban automation](../../.github/workflows/deploy-automation.yml)
runs after `Verify` succeeds for a main-branch push. It downloads and validates
the automation artifact from that exact run, checks automation reader floors,
then stages and activates the automation Worker version only. Frontend and Rusty
use their own release pipelines; a successful automation deployment neither
deploys nor certifies either component.

[Recover one tincanban component](../../.github/workflows/recover-release.yml)
can restore the automation artifact from an exact successful main `Verify` run.
It validates and activates only the selected component. Recovery does not
coordinate a frontend or Rusty release.

The configured production route is
[`automation.meta-uber-engineer.dev`](https://automation.meta-uber-engineer.dev).
`/health` reports readiness plus this Worker's source SHA, artifact SHA-256,
Cloudflare version ID and reader/writer capabilities. Local builds without release
bindings return null release identities. Source presence or a source SHA alone
does not establish the active deployment; use this Worker's deployment artifact
and live version confirmation. Production uses `wrangler.jsonc`;
`wrangler.e2e.jsonc` is local-only and never published. `workers.dev` is disabled.
Configured browser CORS permits `https://match.meta-uber-engineer.dev`,
`https://tincanban.meta-uber-engineer.dev`, and the public intake form at
`https://meta-uber-engineer.dev`.

Operator-authenticated identity provisioning can happen before routing is configured; it returns only public identity and device-certificate data. Challenge, intake, event status, and activation remain closed until a configured scope and signed approval exist. Each integration must use the owner's exact workspace, board, columns, fields, and signed expiry. Do not add placeholder scopes.

On 2026-10-12, Cloudflare Email Routing for `inbox.meta-uber-engineer.dev` and an exact private-recipient Worker rule were provisioned. The public `jobs@inbox.meta-uber-engineer.dev` address is not an intake capability. Production uses the private route secret. Gmail forwarding confirmation and a real delivered board action must be verified separately before claiming end-to-end readiness.
