## Why

Tincanban has an atomic board-command boundary, but device enrollment, personal
state, authority, replication, attachments, automation and deployment do not form
one complete lifecycle. Recent failures exposed missing Rusty settings and photos
on an enrolled phone, different browser/server ownership rules, an incomplete
certificate chain during workspace creation, and a closed transport during file
retrieval. Browser save optimizations do not cover the independent Worker replica.
Pruning encrypted snapshots does not bound the history inside the remaining snapshot.

This change implements all nine architectural findings together. The findings are
not nine independent security vulnerabilities: some are observed defects, some are
structural duplication, and some are failure risks established from current code.

## What Changes

1. One versioned, complete same-identity device-state transfer contract.
2. Explicit person/scope authority for Rusty operations, with device revocation;
   certificate ancestry proves identity rather than defining a hidden primary device.
3. One verified signing context containing the device key reference, complete
   certificate evidence, identity, scope authority and current authorization revision.
4. One transactional private-preference store, with logical revisions, durable
   deletion and restart-safe migration from the duplicated settings records.
5. One host-independent replication engine for browser and automation, with
   separate storage/transport/signer adapters and unchanged-state revision checks.
6. Bounded active history, an explicit authorized history-baseline protocol and
   immutable, verifiable archive segments preserving historical access.
7. Encrypted private attachments through Rusty, with independently confirmed
   coverage and recoverable direct-transport lifecycle.
8. Durable application source records, immutable posting observations and
   explicit owner-approved binding of ambiguous retained email events.
9. One compatible release manifest and CI-controlled rollout for frontend,
   automation, Rusty and required shared-policy artifacts.
10. Readable long-form bilingual descriptions, notes, details and discussion,
    while preserving the existing handwritten board and application chrome.
    Licensed local reading fonts and resilient fallback behavior required.

## Implementation and Release Constraints

The owner explicitly requires no intermediate E2E runs, browser verification,
staging, commits, pushes or deployments. Acceptance scenarios and tests are authored
first. Logic/integration tests must demonstrate the intended failure before the
corresponding implementation and run during development. E2E executes only after
the entire implementation and non-E2E verification are complete. Any final E2E
failure returns the release to implementation; it does not authorize a partial release.

All affected repositories remain uncommitted until the implementation gate passes.
Final version-binding commits and CI pushes then produce one release candidate;
every required check must pass before production activation. Existing user changes
and unrelated processes must be preserved. No history, key, grant, ciphertext or
pending event is deleted merely to make migration or testing pass.

The previously authorized production release `07242d4880821829026234ca1a3cb6bd07ee29fe`
was confirmed deployed before this change began. This proposal does not claim that
any of its new architecture is already deployed.

## Scope and Related Specifications

Implementation spans this repository, shared MetaMesh policy/runtime interfaces in
`vendor/meta-mesh`, and the standalone Rusty repository at `../mesh-lighthouse`.
Preserve Rusty's blind-storage boundary and automation's existing restricted grants.

This change completes the device/replica/history/attachment/release contracts relevant
to [blind storage and scoped automation](../blind-keeper-and-scoped-automation/proposal.md)
and [product deployment and triggers](../product-deployment-and-scoped-triggers/proposal.md).
It does not introduce unrelated Terraform, Helm, arbitrary trigger languages or a
hosted account service. Existing recovery limitations must remain explicitly documented.

## Completion

Completion means all nine architecture requirements plus the requested
typography requirement and their migration/failure scenarios in
[the specification](specs/device-and-replica-contracts/spec.md) are implemented,
final checks pass, exact compatible artifacts are deployed through CI, production
serves their release identifiers, and no required task remains open. A green unit
suite, a pushed commit or an updated Rusty container alone cannot complete the goal.
