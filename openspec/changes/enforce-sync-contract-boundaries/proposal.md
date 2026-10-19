## Why

Three boundaries remain conventions rather than enforced contracts: automation
imports browser sync implementation files, workspace snapshot commits rely on
callers acquiring a lock, and pairing frames have inconsistent receive budgets.
These deserve separate, reviewable changes with shared acceptance criteria.

The additional inspection found a document-cache ownership risk and a concrete
budget mismatch: core permits a 24 MiB owner offer while native RPC accepts at
most 16 MiB. Neither establishes the cause of the observed WebKit WASM failure.
Stale-write data loss and remotely exploitable denial of service have NOT been
reproduced. Source evidence, counterchecks and proposed reproductions are in
[research.md](research.md).

## What Changes

1. Publish host-independent Rusty transport, authenticated envelope and receipt
   contracts from MetaMesh. Browser and automation consume those exports;
   Tincanban owns its document model, card rules and product admission adapter.
2. Make workspace writes available only through a transaction context that owns
   read/admission/commit and compares the durable basis inside the final write.
   Cover full snapshots, delta append, received-history activation, initialization
   and maintenance rather than protecting only ordinary commands.
3. Give core framing and browser/native stream readers one explicit budget
   profile. Validate before parsing/copying, apply stricter frame-kind budgets,
   and page legitimate bulk transfers instead of silently enlarging memory limits.
4. As part of the persistence boundary, return owned document handles with matching
   heads/revision. Cache replacement or eviction cannot invalidate an in-flight read.

## Capabilities

### New Capabilities

- `host-independent-replica-contract`: independently consumable shared replica I/O
  and verification, with explicit product ports.
- `guarded-workspace-persistence`: unforgeable transaction context, durable CAS,
  commit-before-publication and document-handle ownership.
- `bounded-mesh-ingress`: common framing, stream, bulk-transfer and peer-isolation
  limits across browser and native hosts.

## Scope and Non-goals

This proposal changes contracts in Tincanban and `vendor/meta-mesh`; implementation
requires independent SDK CI and checked artifacts before updating the consumer pin.
Existing wire bytes, signed evidence, identities, keys, grants, exact pending
ciphertexts/request IDs and board configuration must be preserved.

No card rewrite, jobs preset, new settings screen, storage backend/adapter,
executor, Reflux state import, or credential reset is included. TinSink ACL and
the external Automation connection button remain separate work. No automatic data
migration or legacy-reader fallback is authorized by this proposal.

## Relationship to Existing Work

The [device/replica architecture](../unified-device-and-replica-architecture/design.md)
already specifies a shared engine; this change closes its remaining ownership and
packaging gaps. The [workspace transaction specification](../../specs/workspace-transactions/spec.md)
already requires atomic durability; this change makes that requirement enforceable
at the storage API. Independent service releases remain in force.

## Completion

This is a proposal, not an implementation or release claim. Completion requires
the tasks and adversarial acceptance scenarios below, green CI in each affected
repository, verified browser/native artifacts, and confirmed production behavior.
Authoring or validating this document does not complete those implementation tasks.
