# Design

## Shared code, separate authority

This is a separate deployed service, not a mode that gives Rusty access to keys.
Rusty's current native binary uses `meta-mesh-core` for protocol verification and
serves ciphertext. The current readable executor is TypeScript `AutomationReplica`
using `ReplicaEngine`, the shared Rust/WASM admission core and application commands.
They are not currently two configurations of one complete server. No measured
"90 percent reuse" claim follows from their shared dependency.

Reuse the existing layers at their actual boundaries:

| Layer | Owner and reuse rule |
| --- | --- |
| Identity, signatures, grants, causal admission, encrypted delivery/history, receipts | meta-mesh; same implementation and supported protocol for every adapter |
| Board schema, allowed item commands, application-source evidence and automation constraints | application domain; browser and executor import the same definitions |
| Readable authorized replica, pending-write recovery and command application | one reusable participant implementation extracted from AutomationReplica; no Cloudflare/Node forks |
| HTTP, process lifecycle, durable transactions, scheduling, secret loading, telemetry exporters | thin runtime adapters; explicit capabilities, no policy reimplementation |
| Rusty ciphertext storage and public publication endpoints | Rusty service; no readable participant or item-command handler |

Use the existing TypeScript participant initially; retain the same shared native
policy via its Node-compatible adapter. Rewriting item behavior in Rust would
duplicate application semantics and is outside this change. Runtime configuration
selects installed adapters and approved identities; it cannot manufacture grants,
enable decryption in Rusty, or disable admission checks.

Executor source can share the existing application repository/domain imports;
separate process, persistent volume, image, CI workflow, deployment lock and secrets
establish service independence. Do not create a repository merely to copy current
source there. If extracted packages later move repositories, consume immutable
package artifacts; never copy source at release time or require a frontend release.

## Data flow and keys

`form/email → intake + CLEF → items commands → executor participant ↔ blind Rusty`

Intake retains bounded encrypted external events and source deduplication state.
CLEF supplies observations and candidate matches, not authorization. The executor
reads the current admitted board and applies only commands permitted by its
existing owner-signed automation grant. Its identity is distinct from Rusty's
storage receipt identity and from the human owner. Reading keys and signing keys
live only in the executor's private durable state/secret configuration and approved
clients. Intake authentication permits submission to configured integrations; it
does not grant arbitrary board reads, management, owner or editor rights.

Keep original job URL/title evidence, action time and source IDs. Editable card
titles are not authoritative matching evidence. If action is understood but target
is ambiguous/missing, retain a review-required result using existing backend
representations; do not add Inbox UI or guess a target.

## Items API

The executor exposes authenticated `POST /v1/items/commands` and
`GET /v1/items/commands/:commandId`. This is a command/result API, not a second
board CRUD/read model. Reuse existing item IDs and domain command types; the
transport envelope adds only integration/source/idempotency/progress information.
Do not expose generic arbitrary-field patching that bypasses grant constraints.

A submission contains a stable source event key, an idempotency key, integration
binding and normalized action/evidence payload. Producer authentication binds the
caller to that integration. The executor derives workspace/board/grant from its
approved configuration; caller-provided IDs cannot broaden scope. Payload size,
supported action and required evidence are validated before durable acceptance.
Use a canonical payload digest to detect changed retries. A duplicate key with
identical bytes returns the original command/result; changed content conflicts.

Return `202` only after durable queue commit, with command ID and a result URL.
Authentication, validation and conflicts return distinct failures. A durable
acceptance receipt does not mean the board has changed. Result states distinguish
queued/running/retryable/review-required/applied/rejected, and
record the actual admitted item ID/change and verified storage receipt when
applied. Result access has the same integration scope as submission. Preserve
trace context across intake, queue, executor and storage without exposing source
mail, access tokens, keys or full private board documents in logs.

## Durable execution and resource limits

Serialize authoring per integration/board; cap concurrently loaded replicas and
command body/queue sizes. Unload idle replicas and release native/WASM handles.
Persist exact signed pending changes and encrypted upload bytes before network
effects. Restart or a lost receipt resumes those bytes rather than signing a
second mutation. Only verified matching Rusty receipts mark storage completion.
Use the existing replica/outbox and admission algorithms behind storage/scheduler
ports. A durable journal records command state and retries; it must not introduce
a second competing source of item state.

Pull and admit current board state before writing. Check current grant lifecycle,
action/field/column scope, target identity, source time and manual changes. Stale
events cannot undo newer manual outcomes. Expired/revoked/paused/deleted grants
stop new authoring; an old accepted job or a service credential cannot override
them. Retry transient transport failures with bounded backoff. Malformed or
ambiguous business events do not enter an infinite retry loop.

Ordinary browser↔Rusty replication remains independent of intake discovery and
executor health. Persisted owner-authorized transitions retain their existing
safety barriers; their recovery must target the migrated executor rather than
silently abandon an incomplete authority transition.

## Existing state migration

Transfer only the existing approved participant: identity/certificate,
registration, replica/chunks, signed activation/grants, replica/history keys and
bases, exact signed pending writes, and storage/history transitions. Old letters,
event queues, source bindings and request nonce ledgers are not imported. This
cutover does not inspect, reconcile or replay historical mail. Use authenticated
encrypted transfer; verify bytes and authority on import. Never create a fresh
identity with silently widened rights to avoid transferring the approved actor.

Fence old execution durably before enabling the new writer. Intake may continue
durably queueing during the fence. Import must be idempotent and checkpointed;
the new service cannot execute until it has acknowledged complete state. Retain a
migration marker/epoch and forward compatible management/intake calls to the
active writer. A restart or rollback cannot revive old DO execution. Keep legacy
state until verified import and recovery evidence exists; then remove retired
readable key/state paths from Cloudflare through an explicit cleanup checkpoint.
No permanent dual-write fallback or inactive CRDT dependency remains in intake.

The owner's manually created Tesla cards and manually moved Amazon card remain
ordinary admitted board state. Historical letters and queued intake never enter
the new executor, so this cutover cannot replay them. New intake retains the
normal durable command/retry path after activation; this exclusion applies to
the old backlog, not new accepted commands.

## Delivery and production evidence

Executor owns its immutable container, private volume, bounded process resources,
health/readiness, rollout and rollback in its own CI workflow. Intake owns its
Cloudflare release. Rusty and TinSink own theirs. Infrastructure configuration
stays in the existing infra repository; no central orchestration repository.
Protocol compatibility, not matching SDK commit hashes, permits independent
release. Component health reports the actual artifact and SDK provenance.

CI covers accepted/rejected commands, duplicate/restart/lost-response recovery,
authorization changes, migration interruption and old-writer fencing. Do not run
local test/build loops: execute authored checks in CI after implementation.
Production acceptance uses a clearly identified authorized automation event and
checks its actual resulting item, signed change, durable receipt and correlated
trace. Do not manufacture or replay a Tesla/Amazon application outcome merely to
obtain a green check. A test fixture alone cannot establish the real integration
is repaired. Record remaining gaps explicitly until the real path succeeds.
