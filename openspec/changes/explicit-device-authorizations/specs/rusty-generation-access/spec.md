## ADDED Requirements

### Requirement: Storage generation continuity is explicitly scoped and approved
Rusty SHALL persist a random generation before serving signed evidence and retain
it through normal restart. Fresh/reset storage SHALL get a new generation even
with the same service key. Revisions SHALL compare only within equal origin,
service identity, generation and resource. New proofs, credentials, confirmations
and ciphertext AAD SHALL bind generation; historical objects SHALL retain original
readers. Continuity SHALL require a signed decision by the relevant person or
board owner/quorum binding predecessor, successor, scope, rights and operation.
Server status SHALL NOT approve it. Conflicting successors/known rollback SHALL
retain evidence and fail closed without claiming detection of every unseen rollback.

#### Scenario: Storage resets with an unchanged service key
- **GIVEN** a client accepted generation G and the server now advertises H
- **WHEN** H reports a revision or a G receipt is replayed
- **THEN** H requires explicit scoped continuity approval
- **AND** cross-generation evidence cannot activate or overwrite accepted state.

### Requirement: Participant storage rights survive owner absence without widening authority
Private operations on scopes using this model SHALL verify current scoped device/resource authority
for reads, writes, inventory, blobs/archives, checkpoints, management and retries;
bearer secrets alone SHALL NOT suffice. Owners SHALL provision eligible participants
through retained delegation and encrypted key delivery. Editors SHALL read/append
and visitors SHALL read with owners offline when material is available. Missing
keys SHALL remain pending. Person settings and management rights SHALL remain
private. Resource owners SHALL remain independent without a global owner pin.

#### Scenario: Participants reconnect without an owner device
- **GIVEN** valid board delegation and available recipient decryption material
- **WHEN** an editor or visitor reconnects with owners offline
- **THEN** editor read/append and visitor read work within that scope
- **AND** neither receives private identity settings or owner-management powers.

### Requirement: Routine withdrawal does not require unrelated credential rotation
Device withdrawal SHALL block learned revoked authority on private routes using this model
without requiring ownership/rotation of unrelated boards or Workers. Compromise
rotation for future-content secrecy SHALL remain distinct. Storage operations SHALL
NOT require a live portal login session or acquire application editing rights.

#### Scenario: A revoked device retains bearer secrets
- **GIVEN** a server has learned the applicable withdrawal and hosts independent owners
- **WHEN** the revoked device requests private bytes or retries a mutation
- **THEN** current authority rejects it
- **AND** unrelated owners and resources remain usable without rotation.
