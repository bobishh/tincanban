# History baseline and archive contract

Status: full implementation contract. Content-addressed archive, purpose-bound
encryption codecs, portable locator directories, Native original capture/catalogue
and storage correspondence, admitted-state rebase and local Owner-attestation
foundations exist; host integration,
baseline activation, and deployed capability remain incomplete. Requirement 6
stays open. Existing opaque Rusty snapshot checkpoints do not satisfy this contract
and must not be interpreted as history baselines.

## Trust and retained evidence

A baseline is a new current-state attestation by the verified current workspace
Owner. It is not a replacement author signature for any covered change. A cold
receiver explicitly trusts that Owner's state attestation, verifies its authority
and content binding, and then verifies the bounded active tail. Independent replay
of earlier authorship/classification loads authenticated original archive evidence;
it is a separate, potentially history-sized operation. The UI and APIs must keep
`owner-attested state`, `verified original change`, `pending` and `quarantined`
distinct. A host-provided admission flag, local checkpoint/cache signature, storage
receipt or Automation/Editor grant cannot authorize a baseline.

Preparation runs full current causal admission once, outside ordinary-write/no-op
paths. The admitted projection alone supplies the next active document. Original
raw bytes, author proofs, pending dependencies, rejected bytes, authority evidence
and classification provenance enter the archive without being rewritten. Excluded
records never become admitted merely because the active state advances. Archive
verification must never fabricate an original proof from the Owner attestation.

This bootstrap trust is consequential: the cold receiver does not independently
prove historical semantic admission without replaying the archive. Policy and
presentation must expose that boundary, rather than claim unchanged full-history
verification at constant startup cost. In particular, historical source identities
used to execute automations need their original authenticated evidence; baseline
presence alone cannot stand in for that evidence.

## Versioned records

All records use exact schemas with unknown required versions rejected. Hashes below
are base64url SHA-256 of canonical UTF-8 JSON or exact binary bytes, as specified
by each field. Canonical JSON uses ordinal object-key order; arrays retain their
defined order. No locale ordering or wall-clock conflict resolution is allowed.
All archive routing metadata remains inside purpose-bound client encryption.
Counters, epochs, byte lengths and indexes are non-negative safe integers at most
`2^53 - 1`; epochs are positive. A SHA-256 digest is exactly 43 canonical
base64url characters. Invalid encodings cannot normalize into a different signed
record. Native and browser fixtures must agree on identical canonical bytes.

The implemented archive foundation currently defines two exact codecs. An index
page is canonical UTF-8 JSON with `kind: "workspace-history-index-page"`,
`version: 1`, `context: {workspaceId, historyEpoch, indexId}`, and `height`. A
height-zero page has only `entries: [{key, objectId}]`; a branch page has only
`children: [{objectId, height, count, first, last}]`. Its root is
`{objectId, height, count, first, last}`. Object IDs and page digests are canonical
unpadded base64url SHA-256 of exact object bytes or canonical page bytes as
applicable. Schemas reject unknown or missing fields, invalid canonical encodings,
scope mismatch, invalid ranges, and counts beyond the safe-integer limit.

Index keys sort by JavaScript ordinal string order, which compares UTF-16 code
units. Rust implements the same comparison with `encode_utf16`; Unicode scalar or
UTF-8 byte ordering would disagree for some astral keys. The shared fixture
`vendor/meta-mesh/packages/mesh-replication/fixtures/history-archive-v1.json`
contains a multi-page index with both an emoji and U+E000 and is verified by the
JavaScript and Rust tests against the same root and object bytes.

Exact binary data uses `ArchiveBytesReference` JSON:
`{kind: "workspace-history-bytes", version: 1, root, byteLength, partCount}`.
The referenced index has at most 64 entries per leaf and keys parts with
zero-padded, 16-character lowercase hexadecimal indexes beginning at zero. Each
part is at most 256 KiB and independently content-addressed; the reference binds
the ordered part root, total byte length, and part count. Reads can fetch parts
lazily and validate each part; complete length/count validation occurs when the
reader drains the full byte stream. Index pages are at most 64 KiB, with at most
64 children and depth at most 32.

Archive readers now supply optional `ArchiveObjectReadBinding` metadata to the
storage port: workspace, history epoch, index ID, object kind, part index and part
count. Local plaintext stores may ignore it; encrypted readers must select and
authenticate the exact private locator binding. Equal plaintext hashes at distinct
part positions do not identify the same encryption binding. The repeated-part
test first reproduced absent binding metadata; both the SDK and actual native HTTP
read now distinguish those positions without changing the content-addressed index.

The JavaScript local repository persists each immutable object as canonical JSON
`{kind: "workspace-history-object", version: 1, objectId, data}`, where `data` is
the object's bytes in canonical unpadded base64url. It hashes and verifies the
object bytes, then publishes with compare-and-swap from an absent value and a
current-context guard; a racing writer is accepted only after rereading and
verifying identical content. This repository is local immutable storage, not a
coverage receipt or network publication protocol.

The implemented encryption codec wraps a page, record, or binary part in
`{version, scopeId, keyEpoch, nonce, ciphertext}`. AES-256-GCM additional
authenticated data is the `MESH-HISTORY/1/archive-object\0` domain followed by
canonical JSON binding `purpose: "archive"`, scope ID and key epoch to workspace,
history epoch, index ID, plaintext object ID, kind and part position/count. Page
and record plaintexts are at most 64 KiB; part plaintexts are at most 256 KiB.
The opaque ciphertext ID is SHA-256 of the canonical encrypted envelope. The
encrypted object carries no workspace, history, index, or plaintext object ID
routing fields. The shared fixture
`vendor/meta-mesh/packages/mesh-replication/fixtures/history-archive-crypto-v1.json`
is opened by browser and Rust tests and recovers exact original proof bytes,
including noncanonical JSON whitespace and Unicode. Rust currently provides the
open/verify path; the JavaScript codec seals and opens. The codec returns ciphertext
for a journal to persist and retry; it does not itself persist or retry it.

Native `prepare_workspace_history` runs the full causal admission evaluator over
the supplied source. Its private, non-deserializable `VerifiedHistoryPreparation`
token retains the typed proof records plus exact Automerge document and pending
change bytes, and carries the derived admission projection, current owner, verified
owner-device chain, sorted source heads, authority digest and source revision. It
rejects non-owner or revoked signers and bounded-input violations. Unauthenticated
writes stay out of the admitted projection; changes with missing dependencies stay
pending. Its source-current check binds authority, document, typed proof evidence
and pending bytes, while receiver wall-clock metadata is outside that revision.
The typed input representation alone does not preserve original JSON encodings.
Native `capture_workspace_history` now consumes that token and separately supplied
original control/authorization JSON. Its non-deserializable
`VerifiedHistoryArchiveCapture` retains those bytes after duplicate-key-safe
comparison with the prepared evidence. Only the unsigned outer authorization's
absent null `grant`, and the control container's absent defaulted empty collections,
may normalize for comparison. Missing nonempty control evidence, unknown fields,
duplicate JSON keys or reconstructed fields inside signed payloads reject. No
retained original is rewritten. The capture revision hashes the Native admission
revision, history epoch and length-delimited exact original JSON bytes. Original
JSON is bounded to 128 MiB combined, including at most 64 MiB control bytes.

The Native capture writes a `workspace-history-catalogue@1` through a bounded-object
sink. Its root references `change/<original-hash>`, `control`, `document`,
`pending/<ordinal>` and `proof/<ordinal>` entries. Original proof/control JSON,
the exact Automerge save and every pending original are retained separately.
Duplicate pending originals are not dropped. Each change's hash/dependencies come
from parsed Automerge bytes; its observation comes from the Native admission plan,
with policy ID `mesh-causal-admission@2` and bound admission/authority/capture
revisions. A pending-only record retains its compressed original encoding when
present. Loaded change bytes are extracted from Automerge; the complete original
save is also retained to preserve its encoding. Proof references and dependency
bytes have separate bounded trees rather than lifetime-sized inline lists.
Metadata records/pages stay within 64 KiB; binary parts within 256 KiB; index
buckets have at most 64 children and depth at most 32. The writer's page buffering
is bounded; the preparation and its change/proof maps still scale with the source
history. A sink failure returns without changing or retiring the source, and a
retry derives identical plaintext objects. This is not an active-history bound.

`examples/history_capture_fixture.rs` reproducibly generates the shared
`history-capture-v1.json` vector. SDK tests lazily read one pending change and its
original proof without reading the source document, then separately reconstruct
the full original input and rerun actual WASM admission, checking all three
classifications. Another test stages Native-produced bytes through the existing
IndexedDB journal and reopens/decrypts without resealing. Native HTTP acceptance
uploads that vector through the app repository, confirms real Rusty coverage and
cold-reads pending bytes, original signature and control evidence. These are
Native format/transport integration tests, not a live WASM preparation handle or
ordinary application/Worker scheduling. Per-entity history indexing, network Owner
transition admission and activation remain incomplete. Native local signing
proposals and exact signature confirmation are implemented separately below.

Rusty now provides a separate opaque archive namespace. Discovery advertises
`encryptedArchives@1` with a 262,160-byte maximum ciphertext and
`archiveCoverageBatches@1` with a maximum batch of 64 objects. Archive PUT/GET
uses `/v2/scopes/{scope}/archives/{ciphertextId}?writerVersion=2`; write and read
bearer tokens remain distinct. PUT returns a Rusty-signed storage receipt bound to
service, scope, key epoch, ciphertext ID, policy revision and request ID. Archive
coverage uses `POST /v2/scopes/{scope}/archive-coverage` with sorted unique
`{objectId,keyEpoch}` entries. Its signed batch receipt confirms only those
objects after hash/epoch checks and scope/archive directory fsync. It does not
aggregate batches or bind a complete catalogue root by itself. The separate
aggregate endpoint and expected-set verifier described below compose these
receipts; neither receipt kind grants baseline authority.

Archives remain outside snapshot inventory and checkpoint pruning. Scope quota
includes snapshots, blobs and archives; checkpoint retained-capacity and scratch
accounting include archive bytes. The archive count limit is 1,048,576 objects per
scope. First archive use after process start scans the directory to initialize
byte/count accounting; warm cache invalidates before uncertain writes and refreshes
after durable writes. A durable bounded accounting index across restart remains
unimplemented.

The shared `historyPreparationJournal.ts` now persists the first three preparation
phases: `captured` retains exact source bytes privately; `archived` freezes the
ordered encrypted-object set after checking the append chain and source; `covered`
stores a verified aggregate receipt. Its canonical state header stays at most
16 KiB regardless of object count. Each staged object retains its binding,
ciphertext, ordinal, previous-record digest and request ID in a four-record
compare-and-swap. Staging retries reuse exact ciphertext and request IDs. Freeze
rechecks the source and full append chain, derives the expected set from sorted
cursor pages of at most 64 with a limit-plus-one lookahead, and coverage verifies
storage receipts plus the signed complete set. Lost stage/coverage commit replies
reopen from durable state; retries do not reseal ciphertext. The journal has no
deletion API.

The app adapter `src/sync/historyPreparationRepository.ts` stores these records in
the separate private IndexedDB database `tincanban-history-preparations-v1` and
uses bounded `MeshStore.scan` pages. The Worker adapter stores each SQL value under
AES-GCM with context/key-bound additional data, snapshots ciphertext before crypto
awaits, rechecks raw ciphertext and the live guard inside `transactionSync`, then
waits for storage sync. Its bounded SQL key scan decrypts values one at a time.
Workerd tests exercise actual Durable Object storage, competing CAS writers,
multi-record rollback, encrypted-at-rest values and scope/context/secret
substitution.

The targeted native-client test in
`src/sync/rustyManagement.native.test.ts` uses the real app repository with a
rebuilt Rusty process. It loses an upload reply, restarts Rusty, reopens the
preparation through a fresh IndexedDB handle, retries exact ciphertext without
calling `crypto.subtle.encrypt`, downloads from a cold reader and reconstructs
exact original proof bytes. It verifies original signature, change hash and
dependencies, retains the supplied pending observation, and checks server objects contain no
plaintext sentinel, workspace ID or read token. This repository accepts caller-
provided source bytes and authority/source revisions; it does not create a
verified native preparation token from those inputs.

The stronger native fixture retains a real signed Automerge change with an absent
dependency and duplicate-content parts, verifies its original change hash and
dependencies after cold recovery, and retains its pending observation. Workerd
archive transport tests run the same SDK and native/browser AES-GCM vector and
cover aggregate signature verification, complete-set comparison and
authority-generation invalidation. Three additional Workerd preparation tests
exercise encrypted Durable Object persistence, resume, transactional rollback and
context/key substitution. These tests do not activate a baseline in the Automation
replica.

These implementations authenticate bounded content, index structure, encryption
bindings and exact expected encrypted-object sets through signed coverage trees.
The journal checks record integrity and retains caller-supplied source/authority
fingerprints; those fingerprints do not establish Native admission. It implements captured,
archived and covered phases. Native capture now consumes the private preparation
token and emits source-derived catalogue content, but the journal's
ordinary host API does not require that token. Test vectors bridge those layers;
the live WASM handle/host producer integration is still absent. Neither a serialized
catalogue nor its bare content hash is Owner baseline authorization.
Ordinary host scheduling, signed Owner transition, atomic active-
pointer activation, restore/export and history-size bounding remain unimplemented.
The preparation token is not baseline activation authority. Rust index verification
and encryption opening do not verify original author signatures or causal policy;
the preparation evaluator does not publish or activate an archive. Requirement 6
tasks remain unchecked until those end-to-end capabilities and their proof exist.

`workspace-history-baseline@1` is a device-signed envelope under the distinct
`MESH-HISTORY/1` domain. Its payload binds:

- `workspaceId`, `baselineId`, positive `historyEpoch` and `controlEpoch`;
- `previousBaselineId` (null only for the first transition), exact prior active
  heads and the exact source admission revision;
- Owner `personId` and signer `deviceId`, complete validated certificate evidence,
  and the exact current authority-ledger digest;
- canonical current-state digest, exact rebased Automerge save digest and its
  new genesis change hash;
- archive catalogue root, original-change count, pending/quarantined record counts
  and the archive format version;
- portable encrypted locator root (both plaintext hash and ciphertext ID), with
  its exact context, range/count/height and locator format version;
- required reader/writer capability `workspace-history-baseline@1`.

`baselineId` hashes the canonical unsigned payload with `baselineId` omitted.
The final signature covers the payload including that ID. The state digest covers
all current workspace content; its normalization cannot remove immutable sources,
locator indices, grants, revocations or unrecognized preserved optional data.
The rebase must not claim that its new Automerge operation IDs are the original
operation IDs. Genesis/change metadata identifies the Owner baseline attestation.

The authority ledger remains independently signed evidence, not mutable fields
trusted from the rebased document. Native policy must validate control succession,
current device status and epoch continuity, including boundaries whose old heads
are archived. A host-supplied owner/epoch or a bare digest is insufficient.
The exact archived frontier anchors those historical boundaries. Until this native
validation exists, neither network receipt nor local activation may accept a
baseline. A stale or forked control ledger must fail before archive retirement.
Historical Owner-issued removals remain valid when their complete signed frontier
is inside that Owner's outgoing transfer/succession boundary. An old Owner cannot
issue a new person/device removal against another person at a later frontier.
Self-authorized device removal remains a separate person authority; a former
Owner may still remove their own device under that rule. Historical record order
or author timestamps cannot substitute for this causal boundary check.

### Owner signing proposal and attestation

The exact version-1 payload is `{kind, version, workspaceId, baselineId,
historyEpoch, controlEpoch, previousBaselineId, transitionId, sourceHeads,
admittedHeads, admissionPolicy, admissionRevision, authorityRevision, personId, deviceId,
certificates, stateDigest, documentDigest, genesisHash, archive, locatorRoot,
storage, requiredReaderCapability, requiredWriterCapability}`. `kind` is
`workspace-history-baseline`; both capability strings are
`workspace-history-baseline@1`. `archive` is the complete bounded Native catalogue
summary. `locatorRoot` is the complete portable encrypted locator root. `storage`
is `{authority, keyEpoch, keyDigest, dataTransitionId, directoryTransitionId,
dataReceipt, directoryReceipt}`, retaining both exact signed coverage envelopes.
No storage bearer token or content key enters this record. `sourceHeads` is the
sorted exact raw-source frontier; `admittedHeads` is the sorted frontier of the
admitted projection that supplied the basis. Both are at most 256 hashes.
`controlEpoch` is the final verified ownership-chain epoch, independent of
person-specific grant/revocation epochs; `authorityRevision` binds all control
evidence, including device removals with no ownership epoch change.
`admissionPolicy` names the exact Native rule version. Preparation revisions hash
the length-delimited policy ID before source/authority evidence. Version 2 preserves
valid historical device removals and restricts historical Owner person removals
to the outgoing ownership frontier. Existing `@1` archive observations remain
original evidence with their old version; they are never relabeled as `@2`.

Only private `VerifiedHistoryBasisArchive` may create a signing proposal. For the
first baseline `previousBaselineId` is explicitly null and `historyEpoch` is 1.
For a successor, a private previously verified Owner attestation supplies the
parent ID: the workspace must match, history epoch increases by exactly one,
control epoch cannot regress, and the parent's basis genesis must be admitted
in this source. The verified genesis identity/epoch must be unchanged, and every
previously known signed ownership, succession, person/device revocation and
departure record must remain present; reordering records or an unsigned outer
certificate chain is not a rollback. A bare parent ID or host-supplied previous epoch is insufficient.
The parent's source history need not remain in the active document. This proposal
boundary does not itself establish the active-pointer lineage: the later atomic
repository comparison must confirm this exact parent is still current.

The proposal exposes an immutable typed payload for platform signing. Its ID is
SHA-256 of canonical JSON with only `baselineId` omitted, including explicit null
`previousBaselineId`; the final device signature uses `MESH-HISTORY/1` and covers
the payload including that ID. Confirming the returned signed JSON rechecks the
complete current source/authority revision, exact proposed payload, canonical
64-byte signature and preparing device's complete validated chain. The original
envelope is bounded to 64 KiB and must contain every specified field; duplicate,
unknown or omitted fields reject at every nesting depth. Signature parsing must
not silently discard injected certificate or receipt fields before verification.
Wrong domains, another valid Owner device, stale source/control, substituted
state/archive/policy/receipts or a changed parent cannot confirm the proposal.

Confirmation produces a private Owner-attestation token and retains the exact
signed envelope and basis. It is not permission to activate, retire or merge a
network baseline. In particular, a signing proposal verified from complete local
preparation is not a cold receiver's archived-frontier/control validation and
cannot replace it. Ordinary producers, durable private-binding/pin guards, atomic
activation, critical-capability negotiation and receiver validation must exist
before the network capability can be enabled. Advancing these implementation
phases must not promote serialized test output or a local cache into authority.

### Admitted current-state rebase

A Native rebase must consume private `VerifiedHistoryPreparation` and load only
its derived admitted projection. It must never copy the raw union containing
pending/quarantined changes. Rebase output is another private preparation token,
not a baseline or activation authority. Its source admission/authority revisions,
workspace/history epoch, transition and preparing Owner/device bind the new basis.
One deterministic fresh Actor ID and a zero-time, explicit
`workspace-history-basis@1` commit identify newly authored operations. They are
not original operation IDs or original author signatures. Empty admitted state
still produces one explicitly marked genesis change. Exact source bytes and
classification observations remain unchanged in the preparation/archive.

The current-state digest uses SHA-256 over `MESH-HISTORY/1/current-state\0`,
one format-version byte `1`, then a canonical typed binary tree. Tags are map `1`,
list `2`, text `3`, table `4`, null `16`, false `17`, true `18`, scalar string `19`,
bytes `20`, signed integer `21`, unsigned integer `22`, float64 `23`, counter `24`,
timestamp `25`, future scalar `26`. Map/table keys sort by UTF-16 code-unit order;
their field count is an unsigned 64-bit big-endian integer, followed by each
length-prefixed UTF-8 key and its typed value. Lists encode the same count then
ordered values. Text/string/bytes encode unsigned 64-bit big-endian byte length
and exact UTF-8/raw bytes. Signed integers, timestamps and current counter values
use signed 64-bit big-endian representation; unsigned values use unsigned 64-bit;
float64 preserves all IEEE-754 bits. Future scalars encode one type-code byte
then length-prefixed exact bytes. There is no JSON-number coercion or field allowlist.
The digest excludes source operation IDs and lifetime edit history. A reloaded
basis must produce the same state digest before it can be returned.

Traversal accounts current values, not historical operations, with maximum depth
128 and 1,048,576 current values. These are preparation limits; exceeding them
must retain the old usable basis and report why preparation cannot continue.
Ordinary Automerge hydration alone is insufficient: it collapses Table to Map,
does not preserve embedded block contents and cannot reconstruct all conflicts.
The initial Native copier supports known scalar/map/table/list and unmarked text
types. Future scalar encodings have a reserved typed digest tag but copying them
is unsupported by the current Automerge save path, so preparation rejects them
before mutation. Until lossless conflicted/marked/block copying exists, those inputs must
fail explicitly rather than silently flatten content. This temporary unsupported
state does not close the complete baseline/product acceptance gate.

Before an Owner signing proposal may be constructed, Native code must join the
private rebase, original capture and composite coverage tokens. Matching current
content alone is insufficient. The join requires the same workspace/history epoch,
source admission revision, authority revision and exact original capture revision;
the rebase transition must equal the covered data preparation transition. The
preparing person/device and complete normalized signer chain must also match;
another valid device of that Owner cannot substitute its basis into this preparation. The
locator root and both signed receipts remain bound to the exact verified storage
scope, service, policy and reading-key epoch/digest. A digest-equivalent rebase
from different source evidence, a different epoch or another preparation must
reject without consuming or changing any token. The resulting private token may
only borrow those immutable preparations and expose the already verified Owner,
complete signer chain and exact source frontier. It is neither a signed Owner
transition nor permission to activate or delete history. Checking a later durable
source against it must still bind the complete source/authority revision; host
storage must perform its own final atomic current-state guard before activation.

`workspace-history-archive-record@1` retains an original record with:

- workspace ID, original change hash, exact change-byte references and dependency
  hashes, with their original ordering/encoding preserved;
- exact original signed authorization envelope and complete verification evidence;
- retained authority references needed to reconstruct the causal decision;
- classification (`admitted`, `pending`, `quarantined`), reason and the precise
  policy/admission version and authority revision that produced the observation;
- entity/index references derived from the original change, not an asserted
  replacement author or invented effective date.

Historical classification is an observation at a bound revision. Later admission
or revocation may produce a new observation; immutable originals remain unchanged.
An archive import verifies content hashes and signatures before presenting an
original as verified. Missing dependencies remain missing, rather than being
treated as empty history.

## Bounded storage and lazy lookup

The active trigger stays 512 admitted changes or 4 MiB of encoded active history,
whichever occurs first. Current content size, pending/quarantine evidence and total
retained archives have separate accounting. The active-history budget is not a
promise of bounded total disk or constant cost for an arbitrarily large current
document.

Exact binary evidence is split into immutable parts of at most 256 KiB. Record
metadata and catalogue/index pages are at most 64 KiB. A large individual change
uses multiple binary parts; it is not dropped, truncated or forced into an
oversized metadata page. Oversized certificate/authority evidence similarly uses
authenticated references with a bounded top-level record. Empty/duplicate/out-of-
order ranges, substituted parts, impossible lengths and hash mismatches fail closed.

An archive catalogue is a content-addressed tree with at most 64 children per page.
The baseline retains only its root and counters, not a flat lifetime-sized list.
Separate authenticated indexes address original change hashes and per-entity
chronological entries. Each child binds its exact key range, record count and page
digest. Lazy reads verify every traversed page against the root before accepting
its range or fetching an evidence part. An index is a lookup aid; it cannot confer
author permission. History inspection fetches only the required paths/parts and
can report missing coverage without replacing the current active document.
Tree depth is at most 32 and encoded index keys at most 512 UTF-8 bytes. Page
ranges must be strictly ordered and non-overlapping; duplicate children, cycles,
invalid counters and paths exceeding the depth budget reject. Multi-part evidence
uses a bounded parts-tree root/count/byte length, never an unbounded inline list.

Private encryption binds `purpose: archive`, workspace, history epoch, archive
record/page/part identity and original part index/count. Plaintext hashes, entity
IDs, original signatures, names and archive metadata never become public HTTP
paths. Opaque ciphertext IDs use the existing strict encrypted-object integrity
rules. Archive objects need their own retained namespace and coverage semantics:
ordinary snapshot checkpoint cleanup cannot delete them, and attachment completion
cannot be reused as an archive receipt.

### Portable encrypted locator directory

A cold receiver has only the authorized baseline, archive reading key and storage
access. It must not need the sender's preparation journal or a flat lifetime-sized
locator list. Content-addressed plaintext pages contain plaintext object hashes;
randomized encryption gives those objects different opaque HTTP addresses. A
separate encrypted directory closes that gap. It is not application authority.

The root is exactly `{kind: "workspace-history-locator-root", version: 1, context,
root}`. `context` is `{workspaceId, historyEpoch, indexId: "archive-locators"}`.
Each `root`/child pointer is exactly `{objectId, ciphertextId, height, count, first,
last}`. `objectId` hashes the plaintext page; `ciphertextId` hashes its encrypted
envelope. First/last are nullable only for an empty height-zero tree. Counts are
safe integers, at most 1,048,576 entries; height is below 32. The baseline binds
this root and the plaintext catalogue root together, never an unverified host
assertion that a locator directory corresponds to a catalogue.

Leaf plaintext is exactly `{kind: "workspace-history-locator-page", version: 1,
context, height: 0, entries: [{key, ciphertextId}]}`. `key` is SHA-256/base64url of
canonical complete `HistoryArchiveEncryptionBinding` JSON, matching the private
preparation journal's binding index. The encrypted page's purpose/domain/context
separate it from data/catalogue pages. A branch uses `children` pointers instead of
`entries`, all at `height - 1`; ranges are strict, nonoverlapping and ordered in
ASCII hash order. Pages are canonical JSON at most 64 KiB with at most 64
entries/children. Every fetch verifies ciphertext hash, AES-GCM binding, plaintext
hash, exact page schema/context and pointer metadata before using child addresses.
Unknown versions/fields, forged ranges, cycles and changed epochs reject.

All directory pages use archive encryption with `objectKind: "page"`,
`partIndex: 0`, `partCount: 1`, their own plaintext `objectId` and the directory
context. Child pointers therefore carry enough information for the next fetch
without another lookup. Data lookups hash the complete requested binding, obtain
its ciphertext ID from an authenticated leaf, then independently authenticate and
open that data object. A locator never grants read/edit permission. The current
authorized scope/key epoch and operation guard remain necessary at every await.

Preparation freezes the source data journal before directory enumeration. Directory
pages have their own durable preparation; they do not recursively index themselves.
Separate exact coverage proofs for all data objects and all directory pages may
form a composite archive coverage proof, pinned to the same service/scope/key and
policy revision. Neither proof alone suffices. Owner authorization must check the
Native-derived catalogue against the directory and bind both complete expected
sets. The Native correspondence method below supplies content evidence; ordinary
host/Owner integration and atomic activation remain absent. Source history cannot
retire. The directory must be portable in recovery exports and the
critical baseline reader capability, including compatible old-reader rejection.

Native correspondence verification consumes an existing private
`VerifiedHistoryArchiveCapture`, the captured encryption scope and portable locator
root, and a guarded encrypted-object reader. It regenerates every catalogue/data
object from the captured original evidence, derives each complete binding key,
opens the addressed ciphertext and compares its exact plaintext with Native's
output. Unique bindings must exactly equal the authenticated directory count;
missing, substituted and extra directory entries reject. Traversed directory
pages are authenticated independently and their ciphertext IDs form a separate
expected set. A changed reader guard rejects before returning verified evidence.
The resulting non-deserializable storage-evidence token retains both roots and
the exact sorted data/directory ciphertext sets for subsequent coverage checking.
It is preparation-only work, can scale with original history and supplies neither
a storage receipt nor Owner authorization or baseline activation authority.

The shared `historyArchiveLocatorPreparation.ts` implements the separate durable
directory preparation. It requires covered data, a distinct transition ID and
identical person/workspace/history/source/authority/private/baseline/storage
bindings. The encryption key is checked against the captured key digest before
source persistence. Its source is a small immutable data-journal reference;
directory objects never enter the data set they index. Restarts reuse staged
ciphertext and request IDs. After coverage, the helper rechecks the data header
and current guard. A 73-object acceptance case crosses locator leaf boundaries,
loses an upload response and finishes with encryption disabled during retry.
The cold reader then uses only the returned root, key and remote object reader.

The actual native HTTP acceptance uploads Native-captured originals through the
app journal, covers both data and directory, restarts Rusty at the same origin,
disables every sender-journal read method and recovers original control/proof/
pending bytes. The Worker test runs the same helper through encrypted Durable
Object storage, including directory lost-response recovery. Both are preparation
and transport evidence, not ordinary baseline scheduling or Owner activation.

Coverage binds the exact catalogue root and encrypted object set, current scope,
key epoch, service pin and policy revision. Neither a local locator nor a receipt
for only the final root proves all required evidence durable. Trees require bounded
coverage batches plus an authenticated aggregate. A receipt from one service must
not be combined with missing parts from another and called complete.

Rusty implements aggregate coverage at
`POST /v2/scopes/{scope}/archive-coverage/aggregate`; discovery advertises
`archiveCoverageAggregates@1` with `maximumChildren: 8` and `maximumHeight: 31`.
The existing signed `blind-archive-coverage-batch-receipt` leaf remains unchanged,
with at most 64 sorted, unique ciphertext IDs and its existing service, scope,
policy revision, request ID and exact objects bindings. The aggregator derives a
leaf summary from those verified object IDs:
`setDigest` is SHA-256 over `MESH-HISTORY/1/coverage-set\0` followed by canonical
JSON `{kind: "archive-coverage-set-leaf", version: 1, objects}`; `objects` is the
exact sorted `{objectId, keyEpoch}` list from the receipt. The summary's height is
zero, range and count come from that list, and `rootCovered` is computed by testing
whether the requested opaque catalogue-root ciphertext ID occurs in the actual
leaf object IDs. The leaf wire itself does not bind a catalogue root.

An aggregate request is exactly
`{version: 1, requestId, archiveRootId, children}` with 1–8 signed leaf or
aggregate receipts and a body no larger than 64 KiB. Each child signature and
receipt schema must verify. All children must share the pinned service, scope and
current policy revision. Aggregate children must also bind the requested archive
root; leaf summaries are derived against that root from their signed object lists.
Ranges must be strict and non-overlapping in ASCII ciphertext-ID order. All
children have equal height. Their counts sum within the safe-integer bound, and
output height is child height plus one, below depth 32. Unknown fields, forged
receipts, inconsistent context, overlaps, unsafe sums and receipts replayed across
policy revisions reject. The signed `blind-archive-coverage-aggregate-receipt`
(version 1) binds service ID, scope ID, current policy revision, aggregate request
ID, archive root ID, height, object count, first/last object IDs, set digest and
`rootCovered`.

For a branch, `setDigest` is SHA-256 over the same domain followed by canonical
JSON `{kind: "archive-coverage-set-branch", version: 1, archiveRootId, children}`.
The ordered `children` are summaries containing exactly `height`, `objectCount`,
`firstObjectId`, `lastObjectId`, `setDigest` and `rootCovered`. Branch
`rootCovered` is the OR of its verified child values; the root value is itself
derived from actual leaf IDs. SDK `historyArchiveCoverageSet.ts` streams the
caller's ordered expected object set into leaves of at most 64 and branches of at
most 8. It promotes a short final tail with unary branches and always returns a
signed aggregate root, including a one-leaf set. Stable request IDs hash the
transition ID, captured authority, archive root and summary. The complete-set
verifier compares the final receipt with the entire expected ordered encrypted
object set: count, exact digest/range and presence of the catalogue-root object.
`rootCovered: true` or a valid receipt for a subset alone never means complete
coverage.

Aggregation composes prior durable service attestations without rereading every
underlying archive file. It proves what each batch confirmed at receipt time, not
that bytes remain available after later corruption. A read or fresh batch is needed
to detect missing/corrupt bytes. Completeness is relative to the caller's captured
expected object source; production integration of the authenticated preparation
catalogue with that source remains incomplete. Retained local originals and
immutable remote archive objects remain the recovery boundary; this protocol adds
no destructive cleanup or baseline authority.

Native composite coverage verification starts from the private storage-correspondence
token, not caller-supplied ciphertext lists. It derives the same fanout-64/fanout-8
coverage summaries from that token's exact sorted data and directory sets. The
data root is the Native catalogue's verified ciphertext ID; the directory root
is the verified locator root's ciphertext ID. Both receipts must be exact-schema,
at most 8 KiB each, valid `RUSTY/2` aggregate envelopes from the supplied pinned
service under the same scope, positive current policy revision and key epoch.
Every summary field and root must equal Native's derivation. Distinct bounded
data/directory preparation transition IDs derive the expected request IDs using
the existing coverage-request domain and canonical authority/root/transition/summary.
Missing directory coverage, a signed subset, altered epoch/root/policy, a forged
signature or another transition cannot produce a verified composite token.
The token retains both verified receipts, their preparation IDs, content roots,
Native capture revisions and the storage pin/key digest. It does not establish
that a caller-supplied pin is current local policy, continued remote availability,
Owner authorization or permission to activate/retire history. The Owner transition
must bind this evidence and revalidate the live captured source/authority/private
configuration before signing and activation.

`history_archive_coverage.rs` now implements that Native composite verifier. Its
private `VerifiedHistoryArchiveCoverage` token is produced only from private
storage-correspondence evidence plus both verified service receipts. Strict serde
schemas reject duplicate/unknown/missing fields; signatures require canonical
base64url. The expected-set reducer retains at most 64 current IDs and eight
summaries per level; it does not construct another flat expected list. The
correspondence token's already retained sets and full preparation still scale
with original history. Shared SDK-signed fixtures cover six boundary tree shapes;
Native also consumes a lazy 100,000-object source.

The opt-in Native HTTP case now runs
`examples/history_archive_verify.rs` on exact original evidence, downloaded
ciphertext and both actual receipts from a restarted Rusty. It executes Native
preparation, original capture, encrypted correspondence and composite verification.
Replacing the directory receipt with the valid data receipt fails the exact-set/
preparation check. The test adapter reads bounded stdin and prints only a small
result; this serialized result is not an authority token and cannot authorize
activation. The adapter now also joins an admitted-state basis, returns an explicit
initial Owner proposal and verifies the JavaScript identity SDK's signed reply.
It rejects a valid key's wrong-domain signature. This confirms local Owner
attestation only. Live WASM handles, ordinary host integration, cold receiver
control/frontier validation and atomic activation remain unimplemented.

## Prepare, publish, activate, recover

The durable preparation journal has a stable transition ID and these phases:

1. `captured`: retain exact source active basis, raw/pending journal, proof evidence,
   authority revision, private binding and prior-baseline pointer.
2. `archived`: persist immutable parts/pages, verify their roots and retain a
   complete local recovery copy. No active pointer changes yet.
3. `covered`: persist verified exact archive coverage receipts and reusable
   ciphertext/request IDs. Lost responses retry identical bytes; no new random
   ciphertext is generated for the same uncertain request.
4. `authorized`: native policy validates and signs the new Owner transition against
   the captured live authority and exact admitted state. All asynchronous signing
   boundaries recheck the verified context; changed source heads or authority
   require a new preparation rather than silent substitution.
5. `active`: one local transaction compares the captured active/admission/private
   revisions, publishes the new baseline/basis and recovery manifest, and retains
   the original source records. A mismatching comparison publishes nothing.

Interrupted phases reopen from the durable journal and validate exact stored bytes,
pins, revisions and receipts. A lost transaction reply is resolved by rereading
the exact transition ID and active pointer, never by deleting possibly published
parts. Another tab may win; cleanup cannot remove its evidence or silently replace
its baseline. Quota, revocation, changed keys, incomplete coverage and unsupported
service capability remain distinct pending/error states.

Activation does not authorize destructive retention. Original source history and
pre-compaction recovery remain addressable. Any future garbage collection requires
a separate retention policy and proof that all referenced recovery evidence stays
available; this change supplies neither consent nor an automatic deletion schedule.

## Offline edits, readers and recovery bundles

Baseline schema is a critical negotiated capability in direct sessions, stored
snapshots, Worker activation and storage writer/checkpoint policy. Unsupported
readers retain their original local data and show an explicit upgrade state;
unsupported writers cannot overwrite or prune the new basis. A successful frontend
deploy is not evidence that an already-open phone tab supports the capability.

Raw changes authored against an old basis cannot be applied directly to rebased
Automerge object IDs. Upgrade retains those exact signed originals and their old
dependencies. It reconstructs their intent against the retained old basis and
offers current-policy commands under the actual current signer's authority.
Unambiguous operations may be reproposed; conflicts, unavailable originals and
revoked authors remain in explicit review/recovery. Reproposal is a new signed
command with provenance to the old hash, never a rewritten original signature or
an Owner pretending to be the old author. No offline edits are silently discarded
to permit baseline activation.

History restore similarly emits a fresh currently authorized command referencing
the inspected original revision. A private recovery bundle includes the active
basis, complete baseline/authority chain, catalogue roots, original evidence and
required encrypted parts/keys under its existing private export boundary. Missing
parts produce an explicit incomplete-coverage manifest listing exact missing IDs;
such an export cannot be labeled a complete backup. Reader/rollback compatibility
is checked before replacing local state or activating a release.

## Required proof before enabling the capability

Native policy tests must reject unauthorized signer roles, missing/forged chains,
scope/state/archive substitution, stale/replayed/forked baseline and control epochs,
omitted revocation evidence, unknown critical schema and historical invalid-write
laundering. Real repository tests inject every prepare/coverage/activation crash
boundary, quota failure, concurrent tab and uncertain commit/reply. Historical
access verifies original signatures/classifications after restart and cold fetch.
Equal-current-state histories of 1k/10k/100k edits must show bounded active tails
and history-independent ordinary-write/no-op operation counts. A local admission
cache or opaque Rusty checkpoint cannot stand in for any of these assertions.
