# Cloudflare automation worker

This Worker accepts bounded job submissions and forwarded email, stores each event in a per-integration SQLite Durable Object, and classifies events with Cloudflare Clef-flash. It keeps challenge nonces, idempotency keys, event state, retry count, and classification results durable across Worker restarts.

The public event response means **durably queued**. After a signed owner automation grant and fully admitted encrypted snapshot are activated, clear Clef decisions can create a Lead or move a uniquely matched application to Applied, Interview or Rejected. Each action is authored as an Automerge change, admitted against the current signed causal authority, persisted before Rusty upload, and reported as applied only after the signed upload receipt succeeds. Email matching uses a pre-classification snapshot; moves require a valid original `Date` header at least as new as the card workflow and reject concurrent workflow changes. Rejected applications never move backward. Ambiguous matches, uncertain classifications, expired grants, stale workflows, and unavailable proof stay in review or retry. Clef cannot authorize writes. The Worker never falls back to an Editor grant.

Unchanged snapshots reuse the last confirmed upload. Wire JSON uses canonical key
ordering and omits absent optional grants on owner proof wrappers; signed payloads
remain intact. This prevents a first self-echo from creating an extra encrypted
object when the verifier returns `grant: null` and proof merging omits it. Older
pending ciphertext remains reusable across this normalization upgrade only when
its full snapshot, including authorization and chat, matches current state. Actual
document/proof/chat changes still require upload; expired grants still prevent sync.

The working-tree instance API also supports `refresh-access` for a previously
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
require explicit route adoption/removal. This is working-tree protocol evidence,
not a claim of coordinated production deployment.

## Application sources

The current working tree supports `job-intake@2`. Its owner-signed automation scope
is version 2 and declares `board.application.source.append` in addition to v1's
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
rejects bound events. The working-tree `/v2/application-review/{discover,list,review,bind,retry,retry-unbound}`
API authenticates a fresh complete-chain Owner request, exact action/body/origin and
60-second nonce, then checks native current Owner/device rights after synchronization.
Encrypted bounded nonce outcomes cannot bypass later device revocation. Discovery
keeps typed definition and legacy routing IDs separate. Mailbox responses carry
bounded retained subjects/reasons and a verified-context Worker observation bound
to the request nonce. Browser settings now lazy-load mailbox and explicit selection/
save/retry controls; their visual and browser acceptance remains unrun. Full eviction/
restart, old-reader and untyped legacy routing adoption remain open. Unbound retry
uses the exact discovered route and fresh Owner proof; it cannot bypass an existing
binding. Action support is advertised separately; malformed capability metadata
never enables an older API fallback. Historical expired grant integrity can be
used only for renewal with a separately validated live approval. Pause state,
pending ciphertext and event dedup survive renewal; ordinary expired restore
continues to fail closed. Public expired-instance management is still pending. Immutable submission references and
legacy migration also remain open; runtime tests do not establish browser or
production deployment acceptance.

## Archive transport evidence

The shared archive SDK has focused Workerd execution evidence in
`tests/archiveTransport.runtime.test.ts`: the native/browser encrypted fixture,
archive sealing/opening, pinned storage, batch and aggregate receipts, complete-set
verification, and live generation invalidation run through the same implementation.
`historyArchiveCoverageSet.ts` streams sorted expected ciphertext IDs into leaves
of 64 and branches of 8, promotes a short tail with unary branches, derives stable
request IDs from the captured transition/authority/root/summary, and verifies the
signed final root against the entire expected set. A signed subset is rejected
even when its root object is present. Server aggregation composes receipts issued
earlier; it does not reread every object or claim continued availability after
later corruption. Focused evidence: Workerd archive tests 2/2 and the shared SDK
suite 46 files / 499 tests. This is transport/runtime evidence only.

The shared preparation journal now persists `captured`, `archived` and `covered`
phases. The Worker Durable Object adapter encrypts each SQL value with AES-GCM and
context-bound AAD, snapshots ciphertext before crypto awaits, rechecks raw
ciphertext and the current guard inside `transactionSync`, syncs commits and scans
bounded key pages while decrypting one record at a time. Three focused Workerd
tests exercise the shared journal against actual Durable Object storage, including
resume, competing CAS writers, rollback after an injected second write, encrypted
at-rest values and scope/context/secret substitution
(`/tmp/tincanban-history-preparation-workerd-final.log`). The full Worker runtime
suite passes 10 files / 125 tests. The adapter is not
connected to `AutomationReplica`. Journal inputs remain caller-provided. Native
`VerifiedHistoryArchiveCapture` now consumes verified preparation, retains matched
original JSON and emits a source-derived catalogue; SDK tests consume its shared
vector, reopen encrypted journal state and rerun actual WASM causal admission.
A live WASM capture handle and ordinary Worker producer/scheduling remain absent,
as do signed Owner transition and baseline activation. The Native catalogue alone
does not authorize activation or confer trust on serialized classifications.

The same SDK now prepares a separate portable encrypted locator directory after
data coverage. The encrypted SQL acceptance case loses a directory upload reply,
reopens its journal, reuses the exact root ciphertext and cold-reads original bytes
with the sender's storage disabled. Directory pages and data use separate complete
coverage proofs under identical source/authority/private/storage bindings. This
removes the cold reader's dependency on a flat sender-local locator list. It does
not connect archive preparation to the ordinary automation scheduler or activate
history baselines.

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

Use Node.js 22+ and pnpm. Install within this directory so the local `allowBuilds` policy permits only the `esbuild` and `workerd` build scripts used by the test runtime.

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
```

Do not commit these values. `IDENTITY_STORAGE_SECRET` encrypts the automation identity seed and device entropy before Durable Object storage. `EVENT_STORAGE_SECRET` encrypts accepted website payloads and both parsed email fields and original MIME bytes before storage. Rotating either secret without re-encrypting the stored value prevents it from loading.

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
Email forwarding shows the latest message subjects, processing states and reasons.
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
After resolving the source problem, **Retry processing** requeues that saved email event with
an owner signature bound to its exact event ID. It keeps the original MIME bytes
and event ID, preserves applied-event deduplication, and rechecks the current
grant, matching, original email date and concurrent workflow before writing.

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

Current UI registry contains `job-intake@1`. Website intake is enabled initially.
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
Owner-signed renewal can update the content key, key epoch and opaque scope at
the same Rusty origin; pending uploads are re-encrypted before durable publication,
and the new scope starts from the owner's supplied cursor.
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
`instanceManagement:{version:1,actions:["discover","identity","activate"]}`.
Independent encrypted, 128-live-request nonce ledgers bind exact outcomes and
reject nonce reuse for different proof/body content. Interrupted activation can
retain a valid approval while reporting missing Rusty confirmation; retry the same
existing instance. The current working tree has native HTTP acceptance for these
paths; eviction/restart, browser and coordinated deployment acceptance remain open.

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

The `Deploy production` GitHub workflow publishes both frontend and automation
only after `Verify` succeeds for a push to the current `main` commit. Automation
uploads a version tagged with that commit, deploys it to all traffic, preserves
operator variables, and checks `/health`. It uses the production `wrangler.jsonc`;
the local `wrangler.e2e.jsonc` is never published.

The Worker is deployed at [`https://automation.meta-uber-engineer.dev`](https://automation.meta-uber-engineer.dev); `/health` returns `{"status":"ready"}`. Its `workers.dev` route and preview URLs are disabled. Browser CORS allows `https://match.meta-uber-engineer.dev` and the public intake form at `https://meta-uber-engineer.dev`.

Operator-authenticated identity provisioning can happen before routing is configured; it returns only public identity and device-certificate data. Challenge, intake, event status, and activation remain closed until a configured scope and signed approval exist. The production proof activated one exact owner-approved scope and applied a synthetic Lead through Clef; no applicant or email content was used. Future integrations must use the owner's exact workspace, board, columns, fields, and signed expiry. Do not add placeholder scopes.

On 2026-10-12, Cloudflare Email Routing for `inbox.meta-uber-engineer.dev` and an exact private-recipient Worker rule were provisioned. The public `jobs@inbox.meta-uber-engineer.dev` address is not an intake capability. Production uses the private route secret. Gmail forwarding confirmation and a real delivered board action must be verified separately before claiming end-to-end readiness.
