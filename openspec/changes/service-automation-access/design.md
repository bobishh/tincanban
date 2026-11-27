## Context

Reflux Job Hunt reads Tincanban through a retained reaction participant.
The owner-signed Automation grant currently combines workspace authority,
field and column scope, and a 30-day expiration. Restoring a serialized
participant fails when that expiration passes. Reflux can still report an
active integration because it reads provisioning metadata.

Tincanban already has signed existing-instance activation, a durable
participant journal, and exact Rusty scope bindings. Rusty already admits
owner-signed resource principal grants, verifies fresh signed requests,
and serializes principal revocation with protected storage access.
MetaMesh owns shared signing and workspace admission rules.

## Goals / Non-Goals

**Goals**

- Keep one reviewable owner approval for the lifetime of a service connection.
- Renew short-lived service credentials automatically and enforce current
  authority at protected operations.
- Upgrade the existing connection, give Reflux verified status, and keep
  withdrawal a separate owner operation.

**Non-goals**

- Changes to job matching, scheduling, encryption format, or participant identity.
- General identity provisioning or changes to how people join a workspace.

## Decisions

### Bind service permission to the existing workspace grant

Add a versioned service permission to the Automation scope. Retain the
existing scope version for the application contract. The signed scope carries
either explicit service permission or the existing expiration. The explicit
permission names the definition and pins the Rusty issuer by key ID. The owner signs the exact executor identity, definition, workspace,
board, access epoch, and existing read and write scope. MetaMesh validates the
kind and scope for both browser and server admission. A signed legacy approval
keeps its original expiration and interpretation. A current owner explicitly
approves an upgrade through the normal board connection. The approval is
applied with existing-instance activation, using the existing definition and
participant identity. A change to the permission scope requires another
owner decision.

Standalone rolling owner approvals would require a continuously available
owner key. Storing such a key in the runtime would give the service broader
authority than the job needs.

### Issue credential leases from the pinned Rusty scope authority

Use the Rusty resource principal grant for online access. It binds to the
same owner-signed workspace grant. The permitted board writes come from the
workspace grant. Rusty gates access to encrypted objects and issues a signed
credential. It needs the grant, scope authority and service proof, with board
content and decryption keys kept in the client.

A credential request proves possession of the existing service key and binds a
fresh nonce to Rusty's origin, the principal, storage scope, grant, and current
authority revision. The standing grant is evidence of the owner's decision.
Ordinary automation role admission requires the corresponding credential,
including on peer entry points. A credential is bound to that key, grant and audience, has
a maximum five-minute life, and can be reused until its renewal margin. Rusty
checks the accepted resource principal and revocation under the scope gate
before each issue and use. The runtime checks freshness before protected
reads and renewing or producing writes. Its request signing, cached credential
replacement and lease serialization belong in the same client module. Job
workers call ordinary board operations and receive typed authority outcomes.

An automation author signs the exact change or chat record before requesting
an operation attestation. Rusty binds a signed credential to that record's
device signature after checking the active service principal under the scope
gate. Rusty sees the signature and operation kind. Board replicas verify the
attestation against the pinned issuer, grant, device, and exact record during
causal admission. This permits delayed delivery of the same confirmed record.
An unbound transport credential is insufficient evidence for board mutation.
The existing scope gate also checks the live grant for ciphertext uploads.

Use fresh proof of the online grant for reads served from a local replica as
well. Recheck before a later publication, which can follow a long search.
Use the existing durable event and upload identifiers when retrying. A lost
response cannot duplicate a write. A service-generated timestamp alone cannot
prove an operation preceded revocation.

A long-lived bearer with scheduled rotation would allow replay and would not
fence a credential already held at withdrawal. The principal-backed lease
preserves a stable service identity and lets Rusty enforce the current decision.

### Make revocation a distinct operation

Use the existing signed principal revocation operation and matching workspace
revocation evidence. Rusty's durable commit is the enforcement point for
online use. Reuse its scope gate and return an idempotent receipt. Persist or
derive any remaining workspace publication so a lost response or app restart
can resume it. Before that receipt the UI may report pending or unavailable.
A removed grant remains withdrawn, and a subsequent grant requires a fresh
owner approval with a different identity for the grant. Pausing the job keeps
its pending events and its authorization decision.

### Project status in Reflux

Expose typed, owner-scoped status from the existing reaction participant.
The result contains the exact connection identity, access state, verification
time, and credential expiry when relevant. Store the result of the regular
refresh operation and invalidate it when the activation changes. Share the
same observed state with the edit screen and Job Hunt blockers. Preserve display
space through refresh. A stale observation is unavailable evidence. An
authoritative revocation or legacy expiration has a distinct status. A running
refresh can fail transiently and retry without changing the connection.

### Preserve the scope of the migration

Prepare the in-place upgrade under the participant's current lease. Merge
admitted state and preserve pending uploads, event IDs, board/history bindings
and completed work. Keep the last usable activation until the new principal
and generation are confirmed. The first accepted service approval makes signed Identity requests mandatory
on that Rusty scope. Rusty serializes the scope policy change with issuance
and data authorization, and persists the flag before the principal can
receive credentials. The old shared bearer by itself cannot read or write.
The owner and authorized participants keep their existing signed request
protocol, scope, encryption keys, and ciphertext. The executor receives
no shared bearer. Untouched scopes retain their previous policy. A missing capability or incomplete transition leaves a retriable
upgrade state.

## Risks / Trade-offs

- Rusty availability becomes a dependency for authorizing automation. Fail
  closed when current authority cannot be checked and preserve queued work.
- Rolling upgrades can leave an older reader unable to admit a new grant.
  Deploy compatible readers and issuer enforcement before enabling writers.
- Clients of the upgraded scope must use their current signed device proof.
  A legacy bearer-only automation on the same board also requires owner
  approval before that scope can move to this policy.
- Authority races are resolved at the scope gate. An operation authorized and
  committed before revocation remains part of accepted history. Replaying it
  cannot authorize a new operation.
- Credential caches and connection status can become stale on restart or
  retry. Pin the binding and revision, guard from older observations, and
  require current confirmation at protected operations.

## Migration Plan

1. Release compatible readers and Rusty issuance plus revocation enforcement.
   Preserve readers for legacy grants, scope data and history.
2. Release the Tincanban and Reflux participant integration and verified status
   together with the normal approval flow. Remove the temporary renewal route.
3. Have the owner approve the existing Job Hunt participant once through that
   flow. Verify its identity, successful automatic credential renewal, board
   access, and a completed production run with delivery.
4. To recover from a failed deployment, keep compatible readers available and
   stop enabling new standing grants until the issuer and participant agree.
   Preserve committed grants, revocations and journals across recovery.

## Compatibility

A scope with the new policy requires a Rusty version that reads the signed
request requirement. Retain this policy on restart, revocation, and ordinary
scope maintenance.
