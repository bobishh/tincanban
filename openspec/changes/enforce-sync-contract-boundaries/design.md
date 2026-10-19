## Decisions

### 1. Shared protocol package; product adapter

Extend existing `@meta-uber/mesh-replication` exports rather than create a second
engine or move `src/sync` wholesale. Extract host-independent Rusty HTTP parsing,
envelope/AAD handling, receipt verification and reusable history contracts.
Reuse existing Rust/WASM verification and archive APIs. Known wire/signature
vectors must remain byte-compatible.

| Boundary | Owner |
| --- | --- |
| Rusty origin/pin validation, bounded response reading, ciphertext/receipt binding, engine transitions | MetaMesh public exports |
| Durable revision CAS, transaction lifetime and host cancellation | Browser or Reflux host |
| Card/document schema, product command interpretation, field rules, scope selection | Tincanban product layer |
| Causal policy verification | Existing shared core, invoked through a product adapter supplying original evidence |
| Scheduling, intake and automation workflow rules | Automation/Reflux product layer |

The SDK accepts explicit transport, crypto/runtime, durable repository and product
admission ports. It has no DOM, IndexedDB, Reflux/PostgreSQL or Tincanban import.
Product-specific model imports in automation are allowed; imports from the browser
sync composition layer are not. Keep product-domain sharing explicit in a product
entry point rather than hide reverse dependencies behind a barrel export.

Implementation ownership map:

| Public entry | Implementation and callers |
| --- | --- |
| `@meta-uber/mesh-replication/rusty-replica` | Rusty origin validation, bounded HTTP, opaque object encryption/AAD, canonical hashing and mandatory pinned receipt verification; browser and Worker adapters import this directly |
| `@meta-uber/mesh-replication/replica-engine` | Existing host-independent pending/retry/CAS engine; host ports supply durable state and product admission |
| Existing `history-archive*` exports and core WASM verification | Archive bytes, encryption, coverage and signed baseline verification; no product card schema |
| `src/product-replica/index.ts` | Actual product admission, workspace authorization, history receive and attachment-index implementations; no reverse imports from browser sync orchestration |
| `src/sync/blindClient.ts` and `workers/automation/src/replica.ts` | Browser and Worker host composition, credentials, persistence, cancellation and workflow-specific actions |

The dedicated replica dependency rule checks transitive reverse imports from the
product entry and Worker, not merely imports written in the entry-point barrel.

Transport and crypto validation cannot be bypassed by a product callback. A storage
receipt proves exact storage, not product authorization. Current authority, original
proofs and history admission remain mandatory. Persist pending bytes/request ID
before sending; after an uncertain result retry the identical upload.

An independent package consumer must compile and run against the public exports
without mounting any Tincanban `src/` directory. Browser and automation run the
same protocol/receipt/retry vectors with their actual storage ports.

### 2. Controlled workspace transaction

Expose a storage-owned `withWorkspaceTransaction(workspaceId, operation)` boundary.
Its context provides a consistent durable basis and one final commit. Existing
callers read, validate and produce the candidate inside this callback. The concrete
API may use closures or opaque tokens; it must enforce these runtime invariants:

- Context binds repository instance, workspace, lifecycle epoch and exact durable
  basis. It cannot be forged with a TypeScript cast or reused after close/commit.
- Workspace Web Lock covers read/admission/commit across tabs. There is no global
  boolean claiming that an arbitrary asynchronous caller owns that lock.
- Crypto, network and admission awaits do not hold an IndexedDB transaction open.
  The final short readwrite transaction compares the captured durable revision and
  baseline/frontier before writing any rows. Revision covers proof-only, authority,
  checkpoint and delta changes even when admitted document heads are unchanged.
- Snapshot, delta/frontier, authorizations, causal evidence, history activation,
  command bytes/proof/receipt and durable revision commit as one relevant unit.
  Typed conflicts change none of them and publish no cache/UI/replication success.
- Create-if-absent is a distinct guarded operation. Restore/import/history rebase
  are explicit authorized replacements; they must not be modeled as an arbitrary
  snapshot overwrite or rejected merely because projected heads are not a superset.

Make unrestricted full/delta commit primitives private. `saveSnapshot` and
maintenance enter the same context or disappear when unused. Audit all callers;
do not retain a public unsafe escape hatch for tests. Multi-workspace operations,
if needed, acquire locks in stable order and compare both bases. No production
rekey workflow is added for a currently unused helper.

On conflict, the application rereads the durable basis and reruns admission with a
bounded retry policy. It does not relabel a stale candidate as current, merge raw
unadmitted history, roll back a cursor or mint a fresh pending upload. This boundary
protects cooperating application writers; arbitrary same-origin storage compromise
is not solved by a Web Lock or an opaque JS token.

Authority records currently use a separate IndexedDB database. A workspace
transaction cannot atomically commit that database and the workspace journal.
Authority maintenance therefore holds the same workspace lock, durably advances
the journal revision and invalidates its reusable frontier **before** changing
authority records. Every authority writer must use this boundary, including
credential, grant, peer-role and recovery projections. Internal calls reuse an
explicit scoped capability rather than reacquiring the lock. A failure or crash
after invalidation may require an unnecessary admission pass; it cannot leave an
old candidate eligible to commit after changed authority. This ordering is not a
claim of atomic commit across databases. Command rows, pending uploads and success
notifications still obey the final-transaction rules above. No data relocation or
compatibility store is introduced.

### 3. Document-handle ownership within persistence

Return `{ ownedDocument, heads, revision }` from one captured/materialized result.
`heads` must describe that returned handle, not an earlier checked object combined
with a later map lookup. Clone or acquire an owned lease before crossing an await;
cache entries remain disposable and cannot be borrowed without a lifetime.
Eviction releases only cache ownership. Caller ownership ends exactly once, including
failure paths; async continuations cannot resurrect or free another operation's handle.
Keep the bounded cache; raising its size does not repair the contract.

### 4. One ingress budget profile

Define exported numeric constants and a core-owned frame-kind budget table. Units
must distinguish complete wire bytes, header/delimiter, payload, assembled content
and concurrent in-flight bytes. All encode/inspect/decode and browser/native adapters
consume this profile, not independently maintained magic numbers.

Target baseline: at most 4 KiB header and 16 MiB complete ordinary RPC, matching the
existing native outer cap. Keep stricter current 256 KiB control/proof/Automerge
budgets with their currently defined units; document framing overhead explicitly.
These are outer safety caps, not permission to allocate that much for a heartbeat.
Each frame kind needs a payload cap; empty heartbeats and fixed receipts stay small.

The existing 24 MiB control/owner logical allowances are NOT a reason to raise the
native single-frame cap. Preserve legitimate bulk content through bounded paging or
existing control chunking, with a logical aggregate limit, transfer identity, deadline,
page count and bounded reassembly. Inventory enrollment/owner-offer payloads before
activation; incompatible peers receive an explicit unsupported/oversize result before
sending bulk data. Never truncate content or pretend a partial transfer succeeded.

The stream reader stops/reset-cancels at its cap before allocating the rest of a
remote payload. Missing delimiters cannot trigger an unbounded header scan/JSON parse.
The core rechecks the supplied slice before header parsing or payload copying;
foreign-function wrappers avoid copying an unchecked giant input into WASM first.
Explicit caller limits may tighten, never disable, the hard profile.

Deadlines abort the underlying read and release buffers/slots, not just reject an
outer `Promise.race`. Bound per-peer concurrent frames and aggregate reassembly;
one failed peer/transfer must not poison another peer's queue or workspace state.
Limit errors identify stage/kind and safe byte counts, never payloads or secrets.

## Implementation and verification sequence

1. Write adversarial transaction and handle-lifetime acceptance cases; then enforce
   storage boundaries and migrate every caller. Preserve the existing delta fast path.
2. Inventory and specify each frame-kind limit; add core/browser/native boundary and
   cancellation tests, including legitimate large paged histories and a healthy peer.
3. Extract shared protocol surfaces with import-boundary checks and independent
   consumer tests; run browser/Reflux adapters against the same vectors.
4. Run affected repository checks through CI, bind matching native/WASM artifacts,
   then update the consumer pin. Deploy through each service's existing pipeline.

User's current verification constraint applies: author tests first, execute through
CI, no local test runs. Document validation is a structural check, not runtime proof.
No migration/reset, new service, owner-key transfer or cross-service deployment
coupling is introduced. Verify the actual browser sync after any eventual rollout;
green CI or a healthy unrelated identity scope alone cannot prove board sync.
