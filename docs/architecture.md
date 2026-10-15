# tincanban architecture

tincanban is a local-first board application. Its data model and authorization are
application concerns; shared networking and cryptographic primitives live in
[MetaMesh](https://github.com/bobishh/meta-mesh).

The complete target for the nine audited device/authority/replica/history/attachment/
application-source/release issues is specified in
[unified device and replica architecture](../openspec/changes/unified-device-and-replica-architecture/proposal.md).
That change distinguishes current implementation evidence from the proposed contracts;
it is not a claim that the target is already implemented or deployed.

## Boundaries

| Area | Responsibility | Must not substitute for |
| --- | --- | --- |
| Vue components | Presentation, drafts, user events | Authorization or durable storage |
| Application modules (`src/app`) | Compose board, access, chat, and lifecycle operations | A public bag of every state field |
| Domain commands (`src/domain`) | Validate and apply board changes | Transport or peer discovery |
| State/persistence | Serialize local mutations and publish committed state | Permission checks based only on visible buttons |
| Authorization (`src/sync/changeAuthorization.ts`) | Validate local roles and signed incoming changes | Automerge merge semantics |
| Workspace replication (`src/sync`) | Connect tincanban documents and proofs to mesh sessions | Generic product-independent domain rules |
| MetaMesh | Identity, protocol framing, transport, shared runtime state machines | tincanban's card/board UI |

Automerge records concurrent changes. IndexedDB persists snapshots and public
proofs. Live sync exchanges missing document changes; attachments use a separate
content-addressed transfer. Browser upload reads the local blob store as bounded
chunks, encrypts each chunk independently, and durably stages each ciphertext with
its preparation prefix before publishing the existing v1 transfer journal. A
complete staged transfer can restart without the source file after verifying its
full digest; a partial prefix requires the original source. Downloads decrypt and
verify bounded chunks into the atomic local blob-store sink; only the preview or
download API materializes the completed file bytes. The wire manifest and final
progress schema remain v1. Optional per-stream reset cancels a stalled request
without closing its connection; older transport adapters retain a safe fallback.
Native loopback tests verify pending-read cancellation, QUIC reset/stop signals,
connection reuse and concurrent-reset cleanup. The authored session-recovery
browser scenario remains unrun. Credential/key migration, browser acceptance and
the full architecture goal remain open. Peer blob reads now request a response
bound derived from the 256-KiB chunk size. Current WASM reads in order into a
inline 16-KiB scratch buffer, checks the limit before appending more bytes, and resets
only the offending stream on overflow. Proof-page reads also request a 256-KiB
bound, enforce a 20-second deadline, and release/reset late or timed-out streams
without closing the connection. Cached legacy adapters may ignore the
optional bound; no memory-limit guarantee applies to them until compatible
rollout. A prior bounded-read attempt was 144 bytes over the transport WASM cap;
the inline-buffer artifact measures 2,299,791 Brotli bytes against the
2,300,000-byte cap, leaving 209 bytes. Native bounded-read tests pass 5/5 and
focused SDK tests pass 38/38. Focused proof-transfer lifecycle tests pass 43/43.
Final root tests pass 270 files / 2,770 tests with one opt-in file / two tests
skipped; six-category quality and combined app-size checks pass. Private JS is
234.60/239 kB, private CSS 10.74/10.75 kB, public JS 61.07/235 kB, public CSS
10.6/10.6 kB, and transport WASM is within its 2.3-MB budget. Browser
session-recovery acceptance and
compatible-adapter rollout remain open.
New browser attachments still hash and persist bounded `File.slice` chunks without
calling whole-file `File.arrayBuffer()`. The existing online idle preload also
warms the lazy stream-store module so a loaded client can attach a file after it
goes offline; the authored offline browser scenario remains unrun.
Same-device tabs refresh committed state through browser notifications rather
than pretending each tab is a different user.

Rusty blob storage is separate from snapshot inventory and checkpoint deletion.
Its read-only `blobCoverage` capability can return a pinned, signed receipt for
an exact bounded set of ciphertext IDs after validating stored hashes and key
epochs. A private attachment locator alone does not prove that the manifest and
chunks remain durably available. Client signature verification has focused
coverage; Rusty's full suite passes 72 tests, including an injected
directory-fsync failure that previously exposed premature receipt issuance. Five
focused client suites pass 42 tests. Normal replica push discovers file
descriptors and schedules encrypted upload or cold-coverage confirmation.
`Complete on Rusty` follows blob receipts, locator-index merge and current
snapshot flush. Status stays in the local active session with distinct failure
phases. The cold adapter checks signed manifest coverage without downloading
chunks, then flushes the index before file retrieval. The six-case native HTTP
suite exercises production scheduling before fresh-recipient download. Service
credential migration and browser acceptance remain open.

## Startup is not transport startup

The browser build has separate policy and transport WASM artifacts. Startup loads
policy before validating and hydrating local documents. Policy has no Iroh or
WebRTC dependency. Local-only workspaces do not start a transport node; invitations
and reconnecting known remote devices load the transport artifact when needed.
The access, admission, and scope workers use the same policy entry point.

A failed policy download blocks local access with an explicit runtime error.
A failed transport download leaves local data usable; retrying a network action
can initialize transport after assets become available. Hydration still follows
policy initialization because local authority checks require Rust policy.

Packaging checks and browser acceptance scenarios are tracked in
[policy/transport packaging tasks](../openspec/changes/split-policy-transport-wasm/tasks.md).

## Identity and access

A person owns workspaces. Devices have individual signing keys and certificates.
Enrollment authorizes another device for the same identity without copying the
root private key. Both devices should have the same ordinary workspace rights.
Some recovery paths still depend on the root key; this is a known limitation, not
a deliberate primary-device product role.

A workspace invitation gives another person a scoped role. Owner authority,
transfer history, grants, and revocations persist separately from disposable
connection routes. Do not infer owner rights merely from an imported document's
owner ID. Local creation must establish its authority as part of the application
flow, including a replacement board after the last workspace is deleted.

MetaMesh recovery words wrap a random root key in an encrypted envelope. They do
not independently reconstruct it. tincanban does not yet provide a complete backup,
recovery-envelope export, key rotation, or stolen-device recovery flow.

## Connection protocol

A session authenticates its remote identity and negotiates capabilities. Owner
workspace offers use `mesh-owner-workspace-offer` / `owner-workspace` and are
sent only to a supported same-person session. `mesh-iroh-gossip` carries actual
Iroh gossip packets. These are different messages and have different receivers.
Logs associate session closure and receive failures with a connection, workspace,
and browser instance. One device may have multiple workspace/instance sessions;
a temporary session replacement is not proof of a whole-device network outage.

## Remaining compromises

- The browser runtime and application still share some lifecycle and workspace
  orchestration. A complete product-independent runtime extraction is unfinished.
- Trusted-group succession handles conflicts by pausing writes; it is not a
  Byzantine consensus or stolen-device recovery mechanism.
- There is no central account service. Optional Rusty servers hold encrypted
  replicas; separate discovery/relay infrastructure supports device connectivity.
- Framework/component tests and browser regressions exercise behavior, but do not
  constitute an independent cryptographic audit.

For a short demonstration, use [the demo guide](demo.md). For the full current
feature/tool catalog, see [the protocol reference](protocol-and-tools.md).

## Original application evidence

The current working tree defines immutable `application_source` children, separate
from editable card titles, Role and Source text fields. A source command captures
its input, verifies the retained text digest and signs one independent record.
Original, refresh and imported-missing observations have strict bounded schemas;
a refresh references its original application without replacing that evidence.
Sources do not participate in child ordering. Ordinary edits, archive actions,
history review and network changes cannot overwrite or delete an existing source.

The shared Rust admission policy quarantines invalid signed source branches while
retaining their raw history and independent valid edits. It checks scope, parent,
closed schema and digest; rejects refresh cycles, disguised namespaces, same-ID
conflicts and map replacement/deletion that would hide original records.
Historical map replacement before source creation remains readable. Browser
Text encoding is checked through the same compiled policy, not just native
scalar-string fixtures. Small changes inspect their own operations and historical
parent paths; changes above 32,768 operations take the full source transition
check without expanding per-character operation structs. This limits an added
allocation; it does not implement bounded active history or archives.

The working tree now implements `job-intake@2` with an explicitly signed v2 source
append scope. It creates one new card and its original observation atomically;
the shared policy permits a refresh only against a prior original on the same
active card. V1 grants cannot append sources, but unchanged source metadata does
not block their ordinary status moves. Definition/grant versions and exact
permission lists must agree. New connections request v2 capability before owner
enrollment; existing connections keep their exact approval until the owner
explicitly enables vacancy evidence. A failed activation remains pending.

Website extraction no longer overlays submitted labels onto posting evidence.
The Worker captures only extracted company/title/text, time and digest; unavailable
or oversized content creates an explicit unavailable observation without partial
or fabricated text. Candidates read sources from the admitted document. Source
matching ignores editable labels/thread fields and refresh observations, requires
review for missing or conflicting selected originals, and can use an exact
retained original URL without a live page fetch. The source set and current
workflow are checked again after synchronization before a move. The v1 path for
cards without records still uses live URL lookup during migration.

The Worker coordinator now stores owner-signed retained-mail bindings and their
exact classifier decision under purpose-bound encryption. Original raw MIME bytes,
parsed event and routing identity participate in the event hash. Source, workflow,
grant, definition and epoch are checked against its admitted replica; current
Owner-device access, including revocation, is checked by shared Rust policy.
Binding history, current pointer and saved audit commit atomically. Corrections
reference the current pointer; a superseded binding cannot masquerade as current.
Saving does not queue execution. Explicit bound retry reuses the retained clear
classification, keeps date/forward-only guards and checks the current workflow
again after sync. Lost receipts leave the event pending; the durable action hash
prevents a second move. Applied audit and event success commit together only after
upload confirmation. The old unbound retry cannot schedule a bound event.

The working-tree HTTP API exposes version 1 review under `/v2/application-review/`:
discover, list, review, bind, bound retry and unbound retry. Every request binds its action, origin,
workspace, typed definition, routing ID, body hash and 60-second nonce to a complete
device-chain signature. After sync, native policy checks current Owner/device
rights, including before returning a cached response. A bounded encrypted nonce
ledger preserves exact outcomes and rejects altered replay. Discovery distinguishes
legacy routing IDs from typed definition IDs without renaming the Durable Object.
Mailbox replies contain bounded retained metadata and a Worker-signed observation
bound to the fresh request nonce and current grant; its signer uses the verified
signing context. Unchanged device access reuses a check only for the exact document,
authority, grant and certificate evidence while time remains valid.

Automation settings now load the signed mailbox adapter and review controller on
demand. Only an explicitly unsupported capability permits the older reader; denied
rights or invalid proof never fall back. Owners can inspect retained mail, page
through original-source candidates, save a separate signed selection and explicitly
retry it. Local validation ignores editable labels, rejects changed workflow/scope,
and permits honest unavailable or legacy original records. Lost save responses keep
the same pending proof; late results cannot publish after an identity/device switch.
The full board typography remains unchanged.

Four real HTTP/DO acceptance cases exercise routing, review/save/retry, unbound retry and mailbox
reads/replays. Their network-sync fixture is replaced; separate replica-engine tests
verify actual signed receipts. Full binding eviction/restart, old-reader and browser
acceptance remain open. Unbound retry now discovers the typed executor's actual route, negotiates its
advertised action, uses a fresh Owner request and rejects bound messages. Missing
capability alone permits the older reader; malformed action advertisements and
permission/network/proof failures do not. Untyped legacy route adoption and
activation routing still need explicit migration. These controls have not been
verified in a browser or deployed.
Immutable submission/ATS/thread references, manual first-Apply capture, legacy
migration, recovery-fork provenance and source detail/refresh UI remain incomplete.
Five browser scenarios are authored but unrun;
their job-page fixture endpoint and remaining product controls are not yet
implemented. No release or deployed phone behavior is established by this work.

## Automation approval continuity

Explicit configuration renewal now preserves the typed definition ID independently
of the durable routing ID and uses the requested future expiry. A retry without a
configuration reuses the exact existing signed grant and definition. Previous
expired signatures establish historical contract continuity only: Worker renewal
still validates its new live grant and admitted incoming document, preserves
pause/control state, pending ciphertext, cursor and applied-event deduplication,
and rejects altered old signatures. Ordinary restore still rejects expired grants.
The working tree now exposes a separate existing-instance API. Discovery binds
the workspace, typed definition and pinned executor root, preserving the actual
integration route. Identity reads return a fresh device-signed management
description, including expiry and explicit adoption state. They do not provision
an identity or require the initial enrollment allowlist. An expired contract
admits historical inspection only: a narrow inspector exposes pull, description,
serialization and current native Owner checks, without execution or upload ports.
It uses the shared replica engine's pull path and rechecks request freshness and
Owner authority around IO, including before returning cached responses. Native
causal admission validates complete ownership history before selecting an old
grant issuer; a genuine ownership transfer admits the successor and denies the
former owner. Ordinary restore still requires a live current-epoch grant.

Explicit legacy adoption attaches a signed contract to the same stored executor.
The new approval must be live and fully admitted. Existing raw history, controls,
applied-event deduplication and exact pending ciphertext/request survive. The
Worker retains its own cursor when the storage binding is unchanged; changed
storage uses the new scope's cursor. Replica chunks, active generation and
registration/routing publish in one SQL transaction; existing forwarding settings
are preserved. The browser requires renewed workspace-reading consent before
adoption, renewal or permission changes. Its management status never substitutes
for an execution acknowledgement. Three outer browser cases are authored, unrun.
Cold eviction/restart and older-reader compatibility remain open, as does browser
approval renewal across an ownership transfer.

Approval producers capture caller-owned board/config/identity/bytes before crypto.
Both new grant and definition use verified signing contexts; the production export
boundary checks native Owner rights and current device/workspace before signing.
Its evidence combines confirmed authority certificates with same-person local
ancestors. Verified signer chains are carried in activation authority and survive
the final snapshot export; the signer cannot be substituted by a context from
another device. These focused tests do not establish deployed/browser acceptance,
and remaining raw signing producers elsewhere still require migration.

Worker-authored changes now use verified signing contexts as well: the actual
private key must match its certified device, current admitted automation rights
and lifecycle are checked around signing, and the complete signer chain travels
with each change. A wrong private key leaves durable history and event state
unchanged in the native runtime acceptance case.

## Same-person device-state activation

Enrollment approval v3 and authenticated same-person state v3 carry the same
required six-component manifest: private identity catalog, signed profile
observations, workspace references, causal Rusty connections, confirmed service
management capabilities, and opaque encrypted identity-recovery envelopes.
Readers validate root-key binding, complete certificate chains, required schemas,
service signatures and profile authorization before planning any writes. Root
private keys, recovery words and receiving-device replication progress are excluded.

Catalog, credentials, management evidence and recovery merge plans capture exact
serialized inputs. One local IndexedDB compare-and-swap transaction activates the
bundle. Enrollment includes the serialized receiving-device profile and its prior
profile backup in that transaction. Local key serialization remains inside the
storage adapter; it is never a portable component. A concurrent write invalidates
the captured plan. A transaction failure preserves the prior bundle and identity.

Certificate and chat stores are projections. The same transaction saves an
activation job with its preflighted manifest; projection failures retain that job
for restart. Startup resumes activation after local workspace initialization.
Profile observations have an additional person-bound deferred queue: same-person
transfer verifies the original author signature and complete device chain without
using its `authority` wrapper as workspace rights. The queue preserves the original
signed record until the referenced document is installed. Projection then resolves
the document's current chat scope, checks current owner/grant/revocation authority,
confirms durable chat storage and acknowledges only that exact queue entry. The
document reference and signed chat scope are distinct values. The queue is bounded
to 512 unique observations / 1 MiB and is included in identity activation CAS.
Startup and the current identity/workspace recovery watcher retry pending entries;
one unavailable or rejected workspace does not prevent other identity updates.
Proof-store writes merge targeted mutations against the latest durable map; a stale
tab cannot discard certificates or resurrect removed grants. Corrupt or newer
evidence prevents writes and retains original bytes.

Reported focused projection evidence: 13 core projection tests, 7 queue tests,
7 author-only verifier tests, 7 lazy-loader tests and 4 recovery-watcher tests
passed. The three native HTTP cases include a cold recipient restoring the original
signed profile into its private deferred queue while source capture is unavailable;
the referenced workspace is unknown, so this is not evidence of shared projection.
The projection results are focused logic/protocol evidence. Pending-reason data
exists, but product diagnostics UI is not complete. Browser acceptance and
old-reader compatibility remain open.

Global name/photo state now lives in `PersonalRootDocumentV1.profileState` and
travels in the required `profile-observations@3` component, outside the catalog
component. Signed device operations use causal counters and complete certificate
chains; timestamps never select a winner. Original legacy observations remain
hashed and retained. Admission rejects missing superseded observations,
cross-field references and presentation shadows absent from recorded history,
including during conflicts. Older @1/@2 components migrate observations without
inventing signed operations; they cannot carry hidden @3 state.

Identity settings submits name and optional photo together. One compare-and-swap
commits signed operations, root presentation and local profile presentation.
The form captures its reviewed revision when editing begins; an intervening
profile update requires review before save can retry. Loading disables edits,
failed saves keep drafts, and conflicts expose explicit choices. These browser
scenarios are authored but remain unrun. Equal already-signed values do not create
additional operations. Shared workspace avatars are outward projections or a
display fallback; their timestamps cannot overwrite the private register.

Non-adoption activation validates the captured local profile and serialized key
bytes before planning writes, then includes those exact bytes in its CAS
conditions. Missing or corrupt local identity requires recovery and never creates
a replacement identity implicitly. SDK presentation refresh retains existing key
objects, permits only display-label changes and can require the exact captured
raw record. Enrollment continues through its guarded adoption transaction.

The causal model's 512-operation, 512-legacy-value and 1 MiB bounds are local
evidence caps, not the required archive/checkpoint policy. Historical archives,
cross-path browser acceptance and coordinated reader rollout remain unfinished.

The latest full app run passed 2,217 tests across 214 files, with one opt-in file
and two tests skipped. It followed a fix for a UI-copy-policy assertion and a
secondary-context fixture; the affected model/copy-policy files passed 432 focused
cases with targeted lint before the full rerun. The pure causal model's six tests
are included in the full count. Full quality passed types, lint, dead-code,
dependency, duplication and pattern checks (591 modules / 2,107 dependencies)
before the final duplicate-legacy/error-word/fixture edits; targeted lint passed
for their affected files. Vendor SDK package-index lint is outside root quality and
still reports four pre-existing untouched issues. Build-size checks after the
name/model changes passed: private JS 237.23/239 KB, private CSS 10.74/10.75 KB,
public JS 61.8/235 KB and public CSS 10.6/10.6 KB, plus Markdown and all three WASM
budgets. Native Rusty was not rerun after this profile increment; the prior three
HTTP cases remain earlier evidence. No E2E/browser verification or release-gate
completion is claimed.

Private identity-scope Rusty delivery now has a separate typed adapter. Identity
credentials carry `purpose: "identity"` and `personId` without a workspace ID;
portable preference wire v3 marks every operation purpose, while v2 reads only as
legacy workspace state. Device manifests use `private-rusty-connections@3` and
still accept its workspace-only `@2` form. Progress and pending ciphertext stay
local. `IdentityReplica` binds encryption to identity purpose, person, scope and
key epoch, and its signed records carry the complete identity-device manifest and
the confirmed management revision.

The production factory `createIdentityReplica` validates the persisted capability,
credentials and current device before pull or push. The ordinary device-sync loop
now provisions a separate identity scope for an existing board-only Rusty origin,
then runs identity replicas before board replicas and reloads settings during that
pass. Setup credentials are durable before network enrollment; successful policy
confirmation and storage enrollment activate the private connection against the
exact current profile, import private state and remove the setup intent in one
compare-and-swap transaction. Tombstones and credential conflicts prevent
automatic re-addition. Setup errors remain separate from board health.

Focused tests cover scheduler/setup retry and failure paths. Three native HTTP
integration cases cover storage policy, person-policy setup with an independent
root-issued device after controller pins are removed, and cold same-person photo
and opaque optional-component delivery while source capture is unavailable. Rusty
global person revocation also has server coverage for resource status, publication
challenge/staging, checkpoint
and enrollment paths despite valid resource capabilities. The application client
binds new scope policies to the parent person capability/revision and checks fresh
person policy before identity replication. Root-reported checks: 58 Rust tests,
formatting and required binary build passed; three native HTTP tests passed; six
focused client files passed 63 tests, plus 14 management-capability and 6 discovery
tests. These are focused working-tree results, not browser or deployed-phone proof.

Identity-state startup recovery checks the current person's pending-activation key
first and dynamically imports transfer validation only when recovery work exists;
four loader tests cover absent and pending state, identity changes and failed
recovery. Device-enrollment implementation loads after an explicit user action;
three tests cover startup without enrollment, selection and cancellation during
initialization. Fira Sans faces/prose rules ship with lazy detail and chat surfaces;
the JSON mono rule stays scoped to the lazy schema-JSON section. Packaging tests
are structural; no browser or rendered-bundle proof is claimed.

The first person-policy migration still requires the configured legacy controller;
after confirmation, further scope/board policy creation does not depend on its
ancestry or availability. Global revocation of management rights does not revoke
disclosed storage bearer tokens or downloaded plaintext. Product revocation and
migration/recovery UI, future-key/token rotation, old-reader rollback compatibility,
interrupted workspace-installation recovery, older approval migration and causal
global name/photo resolution remain open. Unknown optional identity components now
have focused opaque-retention logic and 13 reported tests for roundtrip, conflict
merge, atomic abort/newer-state preservation and bounded CAS import. Browser flow
and compatibility with older deployed readers remain unverified. No
deployment or complete recovery claim.

## Workspace commit boundary

Local commands and incoming replication share `withWorkspaceMutation`. Its queue
serializes one workspace in a runtime; the Web Lock
`tincanban-workspace-command:<workspaceId>` serializes independent tabs. The lock
covers loading the durable base, validation, merge, and commit. Browsers with
IndexedDB but no Web Locks reject writes instead of silently accepting unsafe
cross-tab writes. Other workspaces use separate locks.

`WorkspaceStorage.commitWorkspace` writes the snapshot and signed change
authorizations in one IndexedDB transaction. Local commands include their
change bytes, change proof, and transaction receipt in that same transaction.
Signing prepares evidence without publishing it. Reactive state, tab invalidation,
replication notifications, and a successful replication return follow completion
of the transaction. An abort preserves the previous document and proofs.

Pending item moves have a separate in-memory presentation. Stage selection and
board placement update immediately while commands remain serialized against the
durable document. Each completed or failed command removes only its own preview;
later moves remain visible, and failure restores the latest committed placement.
Previews never enter replication, history, or exported documents. Saving remains
visible until commit completes; closing or reloading during a pending write asks
the browser to confirm leaving.

Ordinary local commands extend the saved admission checkpoint when its raw history,
proofs, projection heads, policy build and current authority still match and all
stored changes are admitted. Current access checks remain in place. The new signed
change must depend on the exact admitted frontier; its root and affected-entity
transitions are checked without replaying historical transitions or signatures.
Access decisions are bound to exact signed authority and document heads, with
inheritance only after verified local transitions in the same workspace. Successfully
checked authority timestamps remain valid as time advances; unchanged access does
not expire on an arbitrary minute timer. Automation access expires at its signed
deadline, including when validation finishes after that deadline. Moving the clock
before the last validation time requires another check. Failed checks cannot be
inherited, and each new check uses a private copy of authority input.
Ambiguous operation targets use a complete check of that one transition. Changed
authority, proofs, policy, missing checkpoints or unresolved history use full causal
admission. Review actions and changed incoming replication retain full reclassification.
Once validated, the saved snapshot becomes an immutable local basis. Each ordinary
command writes its new change, proof, receipt and a chained delta with a small
frontier in one transaction. It neither serializes the full document nor hashes
the full evidence on each save. A failed write cannot advance the durable frontier.
Reload validates the basis and delta chain before reusing admission; these local
markers never authorize incoming peer changes. A warm tab reads a numeric indexed
tail from its last checked frontier and applies only those new changes, without
reading or hashing the immutable basis again. A new generation or changed rights
requires validating the replacement basis. Cold reads still validate the full
retained chain, so their cost grows with history. Reconciliation holds the shared
mutation lock through publication; an older read cannot overwrite a newer write.

The version 4 workspace journal includes `snapshots`, `authorizations`, `frontiers`,
`deltas` and `revisions` stores beside `changes`, `proofs`, and `receipts`. Snapshot and frontier
records contain catalog metadata. Successful commits require no separate legacy
catalog write; fresh readers recover title and archive state from the atomic journal.
The `deltas.sequence` index orders commands by workspace, generation and numeric
sequence. Upgrading versions 1 or 2 creates this index without replacing records;
version 3 retains the index while adding revision storage. Changed snapshots,
proof evidence and commands advance a small workspace revision in their own atomic
transaction. Idempotent retries keep that revision. Legacy command writes and
proof updates invalidate the incremental frontier in the same transaction.
Legacy local snapshots and the separate authorization database remain readable;
the next commit migrates their content into the journal transaction. Legacy
records are retained for recovery. Once an authorization record is migrated,
the journal is authoritative for that workspace.

Successfully committed incoming packets have a bounded, private in-memory copy
(eight workspaces, 32 MiB total). An identical packet under unchanged local authority,
policy and durable revision can reuse its committed result without loading raw
history, serializing documents or replaying signatures. Reuse after local deltas
additionally requires the same valid admitted generation and complete verification
of every supplied proof and claimed hash. Unknown hashes, discarded proof variants
and unresolved history cannot gain this extension. Changed bytes, signatures,
authority, proof evidence or replacement generations require validation again.
Unsigned certificate collection order is immaterial; signed payload order and
distinct certificate variants remain significant. Caller mutation cannot alter
the saved private copy. Optional cache maintenance cannot turn a durable commit
into a reported save failure. This cache never trusts a peer admission marker.

Rusty polling checks the durable workspace revision, current authority and bounded
chat export before building an outgoing snapshot. A successfully acknowledged,
unchanged revision skips document reads, full proof export, historical serialization
and hashing. Chat messages and profile changes invalidate reuse; transient typing
does not enter Rusty snapshots. Revision changes during snapshot construction,
missing revision metadata, failed revision reads and unacknowledged writes preserve
the full export/retry path. The optimization changes neither encrypted object
contents nor signed receipt validation or checkpoint admission.

Rollout requires reloading old tincanban tabs. An old tab holding the previous journal
schema can block its upgrade; the error asks users to close other tabs and reload.
A pre-migration build cannot safely consume new journal snapshots and
authorizations, so rollback requires a compatible reader or exporting workspace
state with its proofs before switching builds. No deployment is implied by this
storage change.

Authorization export still returns the complete history and retains the existing
record/byte limits. Paging, restart-safe transfer cursors, and any authenticated
history checkpoint remain separate protocol work. This commit boundary does not
fix transport timeout causes or establish replication coverage on Keeper.

## Causal write admission

The journal retains raw signed history separately from the authorized document.
Legacy journal replay excludes hashes already classified as pending or quarantined;
reopening storage cannot put them back into the admitted view. Uncheckpointed legacy
changes extend raw recovery/export history without gaining admission decisions, and
invalidate the prior admission checkpoint. The verified incremental path remains
unchanged; this legacy recovery path requires reclassification.
A full local admission already covers every classified raw hash. If all retained
journal hashes occur in that checkpoint's classifications, evidence reads reuse
raw bytes directly; they do not decode the historical document again. A new hash
still requires assembly and clears the old checkpoint.
New authority evidence reclassifies already-known hashes as well as incoming
changes. A valid old-grant write outside the signed revocation frontier becomes
quarantined; descendants with missing or unadmitted dependencies remain pending.
Invalid signatures and unauthorized visitor writes still reject admission.
Raw history, verified proofs, decisions, and the authorized snapshot commit
atomically before the UI or replication announces success.

The board shows quarantined changes for explicit review. Applying a reviewed edit
creates a new signed command against the current authorized document; it does not
rewrite the original or attach a renewed grant to its old hash. Receiver clocks
and transaction timestamps do not decide write authority.

Match negotiates `causal-write-admission-v1` in both handshake directions. Older
clients must upgrade. Other MetaMesh consumers require their own integration.
The core accepts detached pending change bytes, but Match currently transports
serialized Automerge documents. Its review UI covers pending descendants already
in retained history, without an orphan-byte transport or persistence path.
See [admission policy and limits](../vendor/meta-mesh/docs/causal-admission.md).
