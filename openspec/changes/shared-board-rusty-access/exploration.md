# Why participants lost Rusty

## Evidence (2026-10-20)

- `bb5e962` (2026-10-09) introduced blind replication. Its design separated readable clients from opaque storage and required provisioning content keys only to approved readers/writers.
- `b06e718` (2026-10-15) already loaded board connections through the private identity repository. Later conflict/retry fixes retained this boundary; they did not introduce participant bootstrap.
- `withIdentityDevicePreferences` deliberately returns the unchanged store for another identity. Removing that check would disclose personal catalogs, other boards and identity storage. Keep it.
- `reloadPrivateReplicas` reads only the current person's repository. `connectWorkspaceReplica` correctly permits only the board owner. No board-specific cross-identity credential exchange bridges these paths.
- Rusty protocol 2 authorizes opaque object operations with separate read/write bearer tokens. Scope-policy management requires a certified owner signature. Replicating board storage access does not require granting management rights or changing Rusty's identity.
- Direct mesh sessions already authenticate membership, device certificates, current grants, departures and revocations. Their metadata channel is the existing encrypted delivery boundary.

## Decision

Add a distinct board-only access exchange to authenticated mesh sessions. An owner signs a connection attestation containing the board, pinned origin/service/scope, reading keys, policy revision and write-token digest. Editors receive the matching write token; visitors receive no write token. Authorized participants may forward the owner attestation and only capabilities they already hold. This lets a previously absent participant bootstrap from another online authorized participant while the owner sleeps. New invitations acquire the same metadata after their durable session is authorized.

Keep local cursors/outboxes private per identity/device. Do not transfer private identity settings, scope-management capabilities or other boards. Revalidate the attestation and current membership before use. Receiving the same access twice must preserve cursor progress. Reject foreign boards, forged owners, weaker/replayed revisions, changed same-revision credentials and revoked sessions.

## Limits to state accurately

Rusty is durable opaque storage, not an application editor or an Iroh NAT relay. Existing bearer tokens and previously received content keys cannot be recalled. Signed admission continues rejecting revoked authors; confidentiality of future data after revocation requires the existing owner credential/key rotation workflow. This change must not claim new server-enforced per-person token revocation. A device that has never received any storage access still needs an authorized peer for initial bootstrap. No deployment follows from local apply.
