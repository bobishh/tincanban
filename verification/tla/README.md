# Storage and sync models

Finite executable specifications; **no formal proof of production code**.
Baseline storage ordering maps to commit `b082f9e`; fixed storage design maps
to `8740708`. Paging remains a proposed protocol, not an implemented fix.
Transport models state required ACK/retry behavior; no claim that connection
flapping, stalls, or history/export growth is fixed. `ItemTransitions` checks item
placement/workflow pairing, independent column collapse, archive/restore workflow
preservation, failed publish silence, and idempotent single archive-column
reference under finite interleavings.
`IdentityCatalog` models identity replacement as switching to the new identity's
explicit personal-root entitlement set: old local document bytes remain, old-only
catalog entries disappear, and invited/shared refs remain visible. Ownership is
fixed and never inferred from peer count or offline status. This finite model does
not verify signatures, IndexedDB, or enrollment transport implementation.
`WorkerLifecycle` checks admission requests wait for a ready worker and stale
fatal and queued-timeout callbacks from an earlier worker generation cannot fail
the retry. Negative configurations deliberately remove each generation guard
and expect a counterexample. The abstraction models at most two worker generations
and two queued jobs; it does not model browser event-loop scheduling or worker
internals.

`RevocationGeneration` starts with grant epoch 2 revoked, issues a newer grant
at epoch 3, then removes that grant. A successful second removal must record a
revocation epoch covering grant 3 (epoch 4 in this finite abstraction).
`RevocationGenerationPersonOnly.cfg` models the old person-only idempotency
shortcut: it treats the epoch-2 revocation as complete and skips the new record,
violating `CompletedRevokeCoversCurrentGrant`. This abstracts the revocation
list to its maximum epoch; signatures, peer-store persistence, and Rusty's
separate signed disconnect receipt remain implementation-test obligations.

`KeeperGrantRecovery` models a restored owner device whose local grant history
is behind Rusty's retained signed tombstone. The old approved grant cannot
reactivate; the owner reads the authenticated floor, issues a grant above both
local and service history, and activates only after a fresh approval.
`KeeperGrantRecoveryTamperedStatus` makes the status signature invalid and checks
that no grant can be issued from that floor. The finite model abstracts actual
signatures and board identity; implementation tests cover workspace scoping and
the signed status parser.

`KeeperOrphanResolution` distinguishes a pruned pairing from a signed
cancellation. It resolves only after exact signed status, complete tombstones
for saved grant epochs, and local keeper-grant revocation; dismissing the
visible request leaves durable cleanup evidence private. Reload does not
reproject an outbox entry as a keeper request. Discovery stays independent of
outbox state, while a new request for the same service requires verified status
and completed cleanup. The no-grant configuration permits resolution only when
Rusty has no target tombstone to link. Mutants that skip local grant revocation,
ignore tombstone epochs, erase evidence on dismiss, globally gate discovery, or
reopen a dismissed request after reload/stale completion must produce
counterexamples. The model abstracts signature, certificate-chain, revision,
and browser-store checks; Playwright and unit tests cover those boundaries.

`KeeperHostInstanceNode` checks that an invitation host uses its durable leased
node-instance key before workspace adoption and keeps that same route after
reload. `KeeperHostInstanceNodeLegacyHost` models the old unscoped host key and
must violate the adopted-route invariant.

`OwnerRevocationPersistence` models removing a different keeper while preserving
the owner's role. A signed revocation boundary must exist in both the document
history and stored authority before local removal completes; the boundary must
reference an already-admitted head. Reload then keeps the owner authorized and
the keeper revoked. A failed persist leaves removal incomplete; retry after
restart can commit both records. Raw causal evidence may contain quarantined
branches, while access is resolved against the admitted document. The raw-head-
only mutation signs against a head available only in raw evidence, stores the
revocation and reports removal without the admitted boundary; reload makes owner
access unavailable and violates
`OwnerAccessSurvivesOtherKeeperRemoval`. This finite model
abstracts signatures and storage transactions; implementation tests must verify
the actual document/authority commit and recovery behavior.

`OwnerAuthorityRecovery` covers repair of legacy malformed target-revocation
boundaries: authenticate the current owner and a non-revoked current device,
retain the old signed boundary in history, CAS-replace that target's record with
a higher epoch referencing an admitted head, then restore owner access after
reload while keeping the target revoked. A CAS conflict changes no authority;
restart refreshes revision before retry. `OwnerAuthorityRecoveryUnauthorized.cfg`
allows a foreign actor to repair and expects `OnlyCurrentOwnerRepairs` to fail.
`OwnerAuthorityRecoveryRevokedDevice.cfg` bypasses the device gate and expects
`OnlyAuthorizedOwnerDeviceRepairs` to fail. The finite model does not represent
signature bytes or real store transactions.

`ReviewLifecycle` keeps the original causal source quarantined and separates it
from the source-hash-to-authorized-clone resolution receipt, active review row,
persisted dismissal, and action error. Dismissal hides a pending row but retains
source history; reopening it does not approve it. A failed local commit leaves the source quarantined and
retryable. A failed dismissal save keeps the row hidden in the current view,
surfaces a dismissible error, and can retry persistence; reload uses the last
durable dismissal value. Successful review atomically records the trusted clone,
receipt, and source-hash resolution while the original branch remains
unadmitted. Projection refresh may happen later; duplicate clicks check the
resolution map under the serialized lock. `ReviewLifecycleDuplicateApply.cfg` removes that guard and
expects a second command; `ReviewLifecycleDismissErasesHistory.cfg` models
deleting source history on dismissal and expects the retention invariant to fail.
Proof and raw source bytes remain retained across all modeled transitions.
This bounds review to one source change and two click attempts. It abstracts
IndexedDB atomicity, command signatures, concurrent browser tabs, and the exact
presentation store; implementation tests must cover those details.

`ReviewedWorkspaceBootstrap` starts after a trusted review clone and its
source-hash resolution are durable. Raw causal history still contains the
quarantined source and admitted clone; bootstrap classifies that history into an
admitted projection containing only the clone. The source remains available in
history and unadmitted. `ReviewedWorkspaceBootstrapRejectsQuarantine.cfg` models
rejecting the whole workspace merely because raw history contains the
quarantined source and expects bootstrap availability to fail. This two-change
abstraction does not model Automerge dependencies or the actual admission
classifier; the browser regression must verify those.

## Startup admission and scope shutdown

`SavedAdmission` binds local admission reuse to six finite dimensions: raw history,
proofs, authority, projection heads, decisions and policy. Classification and atomic
commit are assumptions backed by implementation tests. Mutants omit authority,
ignore a race, accept remote checkpoint trust or publish local marker renewal.
`ScopeShutdown` distinguishes callback self-drain from drain under a mutation lock.
Under weak fairness for serviceable callbacks, closing eventually frees the scope;
its two unsafe variants must violate this temporal property. Neither model provides
a wall-clock bound or proves JavaScript refinement. Production mapping and actual
entry-point regression tests: [architecture fitness](../../docs/architecture-fitness.md).

## Run

Requirements: Java, Python 3, official
[TLC tools 1.7.4](https://github.com/tlaplus/tlaplus/releases/tag/v1.7.4).
No jar committed. Download outside repository:

```sh
mkdir -p "$HOME/.cache/tla-tools"
curl -fL https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar \
  -o "$HOME/.cache/tla-tools/tla2tools-1.7.4.jar"
printf '%s  %s\n' '936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88' \
  "$HOME/.cache/tla-tools/tla2tools-1.7.4.jar" | sha256sum --check
python3 verification/tla/run_models.py \
  --jar "$HOME/.cache/tla-tools/tla2tools-1.7.4.jar"
```

If macOS `java` has no registered runtime but Homebrew Java exists, add
`--java /opt/homebrew/opt/openjdk/bin/java`. Runner uses one TLC worker for
liveness, checks intended violation names, rejects unexpected errors, saves
full traces outside repository. Individual run:

```sh
java -XX:+UseParallelGC -Xmx1g -cp "$TLC_JAR" tlc2.TLC -workers 1 \
  -config verification/tla/WorkspaceFixed.cfg \
  -metadir /tmp/match-tlc-states verification/tla/WorkspaceCommit.tla
```

## Checked results

TLC 2.19, official release 1.7.4, Java 26.0.1, 2026-09-28.
Expected counterexamples are successful regression checks, not passing
invariants. Their state counts stop at a counterexample; passing checks explore
the entire reachable finite graph. No symmetry or state constraints used.
IdentityCatalog explores 6 generated / 2 distinct states for its finite identity,
workspace, ownership, and entitlement abstraction.

| Configuration | Result | Generated / distinct states |
| --- | --- | ---: |
| WorkspaceFixed | Safety holds | 1183 / 849 |
| WorkspaceBaselineBranches | SuccessfulCommitRetained violated | 174 / 102 |
| WorkspaceBaselineProof | ProofCoverage violated | 4 / 3 |
| WorkspaceBaselineAbort | AbortedSilent violated | 9 / 8 |
| ProofBaselineCount | EventuallyCovered violated | 4 / 3 |
| ProofBaselineBytes | EventuallyCovered violated | 4 / 3 |
| ProofPaged | Safety + fair liveness hold | 34 / 20 |
| TransportSafety | Safety holds without fairness | 343 / 130 |
| TransportFair | Safety + fair liveness hold | 343 / 130 |
| TransportUnfair | Permanent disconnection defeats liveness | 37 / 18 |
| TransportReconnectOnly | Reconnect fairness alone defeats liveness | 37 / 18 |
| TransportEarlyAck | AckDurable violated | 9 / 6 |
| TransportConnection | ConnectionImpliesCoverage violated | 2 / 2 |
| ItemTransitions | Safety holds | 2257 / 360 |
| IdentityCatalog | Safety holds | 6 / 2 |
| WorkerLifecycle | Safety holds | 518 / 174 |
| WorkerLifecycleStaleFatal | StaleFatalIsolated violated | 37 / 29 |
| WorkerLifecycleQueuedTimeout | QueuedTimeoutIsolated violated | 37 / 29 |
| RevocationGeneration | Safety holds | 6 / 3 |
| RevocationGenerationPersonOnly | CompletedRevokeCoversCurrentGrant violated | 4 / 3 |
| OwnerRevocationPersistence | Safety holds | 12 / 10 |
| OwnerRevocationPersistenceNonAtomic | OwnerAccessSurvivesOtherKeeperRemoval violated | 7 / 7 |
| OwnerAuthorityRecovery | Safety holds | 18 / 8 |
| OwnerAuthorityRecoveryUnauthorized | OnlyCurrentOwnerRepairs violated | 3 / 3 |
| OwnerAuthorityRecoveryRevokedDevice | OnlyAuthorizedOwnerDeviceRepairs violated | 3 / 3 |
| ReviewLifecycle | Safety holds | 115 / 32 |
| ReviewLifecycleDuplicateApply | AtMostOneAuthorizedCommand violated | 143 / 42 |
| ReviewLifecycleDismissErasesHistory | DismissalPreservesProof violated | 2 / 2 |
| ReviewedWorkspaceBootstrap | Safety holds | 2 / 2 |
| ReviewedWorkspaceBootstrapRejectsQuarantine | ResolvedWorkspaceCanBootstrap violated | 2 / 2 |

## Interpretation and code mapping

`WorkspaceCommit`: independent operations represent tabs, connections, or local
commands sharing one workspace. Verified changes are immutable identifiers;
merge is set union. Each operation can retry once with the same identifier.
`accepted` means snapshot save accepted a candidate, including an incomplete
legacy save. `committed` means snapshot **and** required proofs are durable;
this is the earliest safe point for successful API return or durable ACK.
`published` represents UI update / notification, distinct from ACK.

Baseline branch trace: both operations read empty snapshot; A saves, publishes,
persists proof and completes; B saves its stale candidate, erasing successfully
committed A. Separate traces show snapshot without proof and publication
followed by proof-write abort. Fixed checks retain both accepted and completed
branches, require proofs for every durable hash, prevent aborted-attempt
publication, and allow crash after commit before notification. Receipt
idempotency is a designed transition (writes count 1), not proof that retrying
production commands yields the same hash or transaction identifier.

Mapping: [`withWorkspaceMutation`](../../src/workspaceMutation.ts) provides
workspace queue and shared Web Lock; unsupported browser locking fails closed.
[`mergeAuthorizedWorkspace`](../../src/stateSyncActions.ts) and
[`persistCommand` / `persistAuthorizedCommand`](../../src/statePersistence.ts)
read, validate, merge, and commit under that boundary.
[`commitWorkspace`](../../src/storage.ts) commits snapshot, authorizations,
changes, proofs, and receipts in one IndexedDB transaction; memory projections
advance after [`transactionDone`](../../src/storageJournal.ts). Signature
preparation in [`changeAuthorization`](../../src/sync/changeAuthorization.ts)
has no durable writes. Atomic commit is a model assumption checked separately
by actual IndexedDB failure tests, not a model of IndexedDB internals.

`ProofTransfer`: current `exportAuthorizations` / `exportAuthorizationBundle`
send all records while `validateIncomingChangeAuthorizations` rejects more
than 20,000 records or 16 MiB. Tiny count/byte limits preserve the same boundary
failure. Proposed pages obey both limits, persist before ACK, retry lost ACKs,
retain durable coverage and acknowledged cursor across restart, and publish
document only after all required proof records arrive. Authority retention is
currently a **constant constraint**, not a modeled retirement algorithm.
No deletion or authority checkpoint design is proposed here.

`DurableTransport`: unacknowledged hashes survive disconnect/retry; duplicates
merge idempotently. ACK records only durable commit. Connection presence says
nothing about coverage. Behavioral mapping:
[`durableMeshSessions`](../../src/sync/durableMeshSessions.ts) evicts failed
publish sessions and records reconnect failure;
[`replication contract`](../../vendor/meta-mesh/docs/replication.md) requires
ACK after persistence. `TransportEarlyAck` is a hypothetical unsafe alternative,
not a claim that current code acknowledges before commit.

## Assumptions and remaining gaps

Safety checks need no scheduling fairness. Liveness requires weak fairness for
reconnect/scheduling and **strong fairness** for recurring receive, commit, and
ACK opportunities. Every modeled hash/page must repeatedly get a usable route;
permanent partition, endless publish failure, unavailable storage, or unfair
retry scheduling violates those assumptions. Models give no seconds-based
latency bound. Route timeout cannot establish global process unavailability.

Finite fixed history only: no ongoing unbounded edits, partition topology,
fanout/catalog scheduling, route scoring, native QUIC/WebRTC internals, queue
pressure, ownership verification, or old-client interoperability. Same-byte
record cost excludes oversized individual records and per-envelope authority
overhead. Production paging needs exact serialized-byte budgeting, stable
record identity/order, authority evidence on each page or bound session,
validation of complete dependency coverage, restart protocol, and API design.
Actual signatures, CRDT dependencies, command replay, legacy migration, browser
crash recovery, and multi-store database semantics remain implementation-test
obligations. `ItemTransitions` bounds logical clock to three changes so TLC explores
a finite graph; lifecycle writes and placement writes are atomic actions, collapse
is an independent Boolean map, failed publish is only modeled before success, and
archive concurrency is represented by idempotent writes of one configured ID. It
does not model competing archive-role assignments, Automerge register conflict
resolution, JSON parsing, rank-only reorder, or database scheduling. The finite
model checks abstract invariants and interleavings; it does not prove production
refinement. Model validity does not establish production refinement.
