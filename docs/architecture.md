# tincanban architecture

This document describes the implementation in this repository. It is not a
production readiness report. Detailed requirements live in the
[device and replica contracts](../openspec/changes/unified-device-and-replica-architecture/specs/device-and-replica-contracts/spec.md);
named scenarios and required evidence live in the
[acceptance map](../openspec/changes/unified-device-and-replica-architecture/verification-map.md).

Shared replica packaging, workspace commit/handle ownership and browser/native
input budgets are tracked in
[enforce sync contract boundaries](../openspec/changes/enforce-sync-contract-boundaries/proposal.md).
Its [tasks](../openspec/changes/enforce-sync-contract-boundaries/tasks.md) distinguish
authored checks, implementation, CI verification and production rollout.

## Boundaries

| Component | Owns | Does not establish |
| --- | --- | --- |
| Vue UI and application controllers | Drafts, presentation, user actions and lifecycle composition | Permission merely because a button is visible |
| Domain commands and shared Rust policy | Signed changes, causal admission, current roles and revocations | Availability of remote copies |
| IndexedDB repositories | Local identity, private preferences, workspace journal, recovery intents and file chunks | A hosted backup |
| MetaMesh | Shared identity primitives, verified signing, protocol framing, transport and replication engine | Board UI or job-processing rules |
| Rusty | HTTP storage of opaque encrypted objects and signed durable receipts; separate selected-board public publication records and assets | Decryption, private-source admission, card classification or application editing rights |
| Approved automation Worker | Readable authorized workspace replica, intake, classification and scoped commands | Owner rights beyond its signed grant |

Desktop and phone keep their own documents and device keys. Iroh exchanges device
changes, proofs and files directly. Browser and automation HTTPS adapters use the
shared `ReplicaEngine` against Rusty. Identity state has a separate encrypted
Rusty scope from board state. Each device keeps its own cursor and pending outbox.
Browser clients sharing an origin and identity serialize complete replica operations
with a scope-specific Web Lock, including background attachment snapshot flushes.
The lock spans reading progress, network work and committing progress; individual
storage transactions retain their independent generation/CAS checks. Different
scopes remain independent. Hosts without Web Locks serialize within their JS realm;
durable CAS still rejects competing writers. A recent confirmed board connection
stays steady during an ordinary poll; failed, paused or overdue sync does not count
as a connected board. Profile delivery and direct device links remain separate.
Private Rusty connections and device-local cursor/outbox state use one authoritative
record per identity, `tincanban.private-replica-state.v2.<personId>`. Retired connection
arrays, preference registries and their fingerprint remain intact: a valid current
record does not prove those older sources were migrated. Ordinary reads, writes
and recovery activation never read, import, delete or include them in transaction
conditions. They cannot override current tombstones or become active credentials.
Recovering older access requires separate verified owner/service confirmation.
An older causal settings revision cannot reset the physical progress generation.
Unchanged access retains its cursor and exact outbox; changed access requires fresh
confirmation and cannot silently replace a pending upload. The retired untagged v2
private-preferences wire format is rejected.
Public visitor access uses the existing board ID and source state. Rusty serves a
board-scoped readable representation from a namespace separate from encrypted
workspace records. It cannot inspect private history to prove a writer's
projection matches admitted source. Honest owner, editor and approved automation
clients derive delivery from locally admitted state and bind signed source heads;
that frontier is a writer assertion, not server-side CRDT admission proof.
Revocation applies to an offline writer after its authoritative signed checkpoint
arrives. Current source paths include native and Worker delivery; final acceptance
and production rollout remain separate evidence gates.

The visitor contract gives public and invited visitors the same board presentation.
Canonical routes are
`/boards/<board-id>/<title-slug>`; the ID resolves the board and the slug is only a
label. The legacy ID-only route remains supported. Private URLs select a board
candidate but never grant access; normal identity, workspace and role checks still
apply. Fresh anonymous public reads do not initialize private identity/workspace
storage. Caveat remains on handwritten board cards and controls; shared detail and
chat prose uses the compact Fira reading tokens defined by the visitor contract.

The [architecture design](../openspec/changes/unified-device-and-replica-architecture/design.md#current-working-tree-boundaries)
contains the component diagram and protocol contracts. There is no central account
service; discovery and relays remain infrastructure dependencies.

## Identity, private state and authorization

A person has a root identity. Devices have individual keys and certificate chains.
**Add my device** enrolls another device under that person; a workspace invitation
instead grants a scoped role to another person. Enrollment does not copy the root
private key. A root-key holder is still needed to create a full identity backup;
an enrolled device can use supported recovery and board operations without
becoming a privileged primary device.

Enrollment and subsequent same-person synchronization use one manifest containing
catalog references, signed profile state, portable Rusty credentials, management
capabilities and encrypted recovery evidence. Unknown required components prevent
activation. Local cursors and pending ciphertext are not portable credentials.

Private preferences use a transactional causal record with tombstones and explicit
conflicts. Wall-clock timestamps do not select a credential or profile winner.
Activation validates the complete input and commits identity/private-state changes
through compare-and-swap. Certificate and chat projections retain restartable jobs;
an unavailable board does not authorize fabricating its owner or dropping its
pending profile observation.

Device certificates prove identity. Explicit person/resource capabilities govern
Rusty management. After the initial legacy-controller migration, later authorized
devices need the current capability rather than the original controller's online
presence. Revoking management rights alone does not revoke disclosed bearer tokens
or erase plaintext. The explicit credential-transition path freezes writers,
preserves pending ciphertext, rotates future access and retains historical keys.

Verified signing contexts bind the actual device key, full certificate evidence,
operation scope and current authority. Workspace admission checks signed causal
history, not the incoming document's owner field or a peer's claimed checkpoint.
Old-grant writes beyond a revocation frontier can be quarantined; dependent changes
remain pending. Review creates a new currently authorized command and preserves the
original evidence. Clocks and unsigned certificate-list ordering do not grant rights.

## Persistence, startup and history

Local commands and incoming replication enter `WorkspaceStorage.withWorkspaceTransaction`.
Storage creates a live context bound to the workspace, repository, lifecycle and
captured revision/frontier/baseline. A per-workspace Web Lock covers the read,
admission and commit. The final short IndexedDB transaction compares that captured
basis before writing snapshot/delta, evidence, proofs, receipts and revision.
Unchanged document heads do not bypass revision checks. A closed or consumed
context cannot authorize another commit. Recovery and received-history activation
use the same live claims for their explicit authorized replacements.

Authority records use a separate database. Their adapters hold the workspace lock;
the first actual authority write durably invalidates journal admission first.
An unchanged catalog does not invalidate it. Failure after invalidation can require
another admission pass even if authority remained unchanged; this is not an atomic
transaction across databases. Reactive state and replication success follow durable
commit. An aborted command preserves previous command rows and pending upload.
Optimistic card placement remains presentation state until its command commits.

Loaded documents belong to the caller; caches retain their own clones. A returned
delta document is paired with the frontier actually read, even if another request
evicts or replaces the cache during an await. Discarded caller handles are released;
active or returned documents transfer ownership to their recipient.

An admitted immutable basis plus a chained delta journal avoids saving and hashing
the complete document for every ordinary local command. Reuse requires unchanged
policy, authority, proofs and admitted dependencies. Incoming or unresolved history
still needs admission. Warm reads consume the indexed tail; cold reads validate the
retained basis and chain. Current journal stores and migrations are defined in
[`storageJournal.ts`](../src/storageJournal.ts), rather than a second schema list here.

Owner-authorized history compaction bounds active work at 512 admitted changes or
4 MiB. Signed baselines and retained original archives preserve earlier history.
Replacing redundant Rusty snapshots after eight retained objects is a separate
storage operation; it does not by itself bound the document's inner history.
Neither operation makes total retained storage constant. Earlier revisions are
loaded on demand, and restoring one creates a new authorized change.
See the [history and recovery contract](../openspec/changes/unified-device-and-replica-architecture/history-archive-contract.md).

Startup loads policy WASM before local admission; policy has no Iroh/WebRTC
dependency. Transport loads when a network action needs it. A transport failure
must not invalidate saved local data. A policy failure prevents access and needs
an explicit error. Local-first does not include a service worker guarantee for a
cold offline launch. Old tabs can block a storage upgrade and must be reloaded.

## Recovery is three different operations

| Operation | Carries | Required source outside that package |
| --- | --- | --- |
| Settings → Identity → Recovery backup | Encrypted root recovery, profile, workspace references and private Rusty settings | Board history and file bytes |
| Sync → Backups → ordinary `.tincanban` export | Workspace data, retained history and public proofs | Private identity/credentials; do not assume complete archived or file coverage |
| Sync → Backups → Private recovery backup | Encrypted workspace evidence, retained archives, available attachments and reading keys, with declared coverage | Same authorized identity; any parts reported missing |

Recovery words unlock their corresponding encrypted file; words alone are not a
hosted copy of the identity, board or attachments. Seed-only older identity files
restore only their declared limited scope. Identity restoration does not manufacture
a missing board or prove Rusty still holds its files.

Identity adoption validates before replacing local state and preserves a backup
of the replaced profile. Workspace recovery inspects and authenticates its complete
package, requires consent before replacement, retains the previous journal and
resumes interrupted secondary projections on startup. A missing archive or file
makes coverage explicitly incomplete. Peer-received archives can be backed up
without Rusty credentials when their original evidence is locally available.

Implementations are [`identityDeviceRecovery.ts`](../src/sync/identityDeviceRecovery.ts)
and [`workspaceHistoryRecovery.ts`](../src/app/workspaceHistoryRecovery.ts).
A complete recovery package is not a stolen-device incident response: preventing
future access also requires current revocation and credential-transition authority.
An offline device cannot learn a revocation that has not reached it.

## Files and transport

Files use content-addressed descriptors separate from workspace changes. New local
files are hashed and persisted through bounded `File.slice` reads. Rusty transfer
encrypts bounded chunks and retains preparation, exact ciphertext and request IDs
across uncertain delivery. A complete prepared transfer can resume without the
original file after digest verification; an incomplete preparation still needs its
missing source bytes. Historical prepared ciphertext retains its original key
context while current credentials authorize transport.

A private locator is not proof of remote coverage. Upload receipts, index merge
and confirmation of the current snapshot precede **Complete on Rusty**. Downloads
verify/decrypt chunks into an atomic local sink; partial cache entries never become
readable files. Product preview/download may materialize a completed file within
the application limit. Current workspace/device authorization is checked around IO.

The SDK core exposes one ingress profile: a 4 KiB header and a 16 MiB complete
ordinary pairing frame, with tighter kind-specific limits and explicit payload
units. Raw history streams use a separate finite reader. Logical owner offers up
to 24 MiB use authenticated bounded pages only when the peer advertises support.
Read concurrency, partial reassembly and deadlines are bounded; expiry releases
partial transfers while retaining authenticated peers. Browser adapters require
the matching bounded WASM API. Stream reset cancels the affected stream. The relevant
contracts and scenarios are in [`proof-transfer.md`](proof-transfer.md) and the
acceptance map. A connection indicator alone proves neither file delivery nor
recovery coverage.

## Automation and original application evidence

The approved Worker can read its workspace and issue only granted commands. CLEF
classifies within that workflow; Rusty does not run CLEF. Browser and Worker share
replication behavior but retain different storage, execution and network adapters.
Public `@meta-uber/mesh-replication/rusty-replica` exports own Rusty HTTP,
envelope/AAD and pinned receipt verification. Product admission, history receive
and attachment-index implementations live in `src/product-replica`; they do not
import browser sync orchestration. Automation imports that explicit product layer
and SDK exports. Startup storage and admission code imports narrow public
subentries such as `src/product-replica/workspaceAuthorizationRecords.ts` and
`src/product-replica/workspaceAdmission.ts` instead of the broad product barrel,
keeping unrelated history receivers out of the startup graph. A transitive
dependency rule enforces these boundaries in CI.
Unchanged acknowledged revisions skip full historical export; uncertain writes
retain the exact outbox and require signed receipt validation.

Original `application_source` observations retain URL-extracted posting evidence
separately from editable card labels. Missing or ambiguous evidence stays pending.
Signed retained-event binding and retry recheck current owner/device, workflow,
grant and deduplication state; saving a binding does not itself execute a move.
Renewal preserves the executor's routing identity and pending work without widening
permissions. The universal Inbox and declarative CLEF processing remain
**specification-only**; no new mail review queue belongs in Settings.

## Readiness and release evidence

Keep four statements separate:

| Statement | Evidence needed |
| --- | --- |
| Implemented | Current source path and its contract |
| Scenario passed | Named test, exact revision, environment and retained output |
| Deployed | Successful CI release from the service's owning repository and matching production artifact/capability |
| Works on the user's phone | That phone loads the intended build and completes the observed flow |

`release/implementation-gate.json` records source readiness only. It is not a CI
result or production acknowledgement. Tincanban frontend/automation, Rusty, and
TinSink each verify and release their own artifacts through their owning pipelines.
There is no shared activation cohort or cross-service build-SHA gate. A green run
for one service does not certify another or prove end-to-end diagnostic delivery.
Running CI and deployment results belong in
[GitHub Actions](https://github.com/bobishh/tincanban/actions), not an accumulating
list of test totals in this architecture document.

As of the 2026-10-16 investigation, the user's existing phone repeatedly stopped at
`initial-workspace-load` / **Reading saved boards**. TinSink recorded the start but
no completion or failure. The inner cause and recovery on that phone remain
unconfirmed. A fresh browser test cannot close this report.

## One manual recovery acceptance chain

This chain is a product acceptance target, not a report that it has passed:

1. On the source device, record board/card IDs, current rights and an attachment's
   name, size and digest. Save the identity recovery file and a private workspace
   backup whose inspection reports complete coverage; keep both sets of words.
2. In a fresh browser profile, restore the identity package. Confirm the same person
   and a valid receiving-device identity. Restore the workspace package or retrieve
   an actually available authorized remote copy; references alone are insufficient.
3. Close the source device. Open the board, earlier history and exact attachment on
   the receiver. Verify content and file digest, not just a preview or connection icon.
4. Interrupt a transfer/recovery step, close and reopen the receiver without clearing
   storage, then resume. Previously committed data and retained pending work must
   survive; missing coverage must remain explicit.
5. Confirm permitted editing still works and an unauthorized/revoked action is
   refused. Record the build, interruption point and observed outcome. Only that
   evidence can close the complete chain for this device.

Existing identity, enrollment, archive and interrupted-file scenarios cover parts
of this chain. Their separate successes do not establish one combined new-device
restore or the reported production-phone case. See the [demo](demo.md) and
[protocol reference](protocol-and-tools.md) for the broader product/tool catalog.
