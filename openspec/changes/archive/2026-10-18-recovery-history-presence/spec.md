# Recovery, editable history, and live presence

## Scope

tincanban targets small trusted groups. It does not claim Byzantine consensus. Signed records preserve evidence; user actions change current meaning through new records rather than rewriting old records.

## Ownership recovery

- A workspace owner MAY name one eligible editor as successor or enable strict-majority editor recovery.
- Each eligible editor MAY sign one vote for one candidate per owner-signed policy.
- A named successor or quorum-backed candidate MAY publish a signed claim for the next ownership epoch.
- Peers SHALL validate policy, grants, votes, candidate identity, epoch, and workspace frontier before accepting a claim.
- Claims use signed logical order, with signature as deterministic tie-breaker. Wall-clock time is display metadata, not authority.
- Conflicting same-epoch claims indicate broken trusted-editor assumptions. Peers SHALL retain evidence and stop automatic recovery rather than silently choose different owners.
- Former owners become editors. Returning ownership requires an explicit transfer by the current owner.

## Editable content history

- tincanban SHALL expose native Automerge changes and their historical snapshots.
- A writable user MAY restore an item to any recorded item version.
- Restore SHALL create one new compensating Automerge change. Existing changes, hashes, proofs, and attribution remain immutable.
- Restoring an earlier version SHALL remain reversible by restoring a later recorded version.
- Concurrent changes SHALL merge normally. Restore never deletes or rewrites native history.
- Security records, identity, grants, revocations, ownership, imports, and migrations SHALL NOT be restored through content history.
- Persistence failure SHALL keep current content and show retryable error.

## Chat typing presence

- A writable participant typing a non-empty draft SHALL publish signed ephemeral typing presence.
- UI SHALL show other active typers by resolved display name.
- Sending, clearing, blurring, closing, disconnecting, or expiry SHALL remove typing indication.
- Typing records SHALL NOT enter durable chat history or exports.
- Missing transport or typing publication failure SHALL NOT block local drafts or message sending.

## Connection counts

- Header SHALL show online editor count and online device count for active workspace.
- Local device counts as online. Revoked devices never count.
- Count SHALL update when mesh sessions connect or disconnect.

## Scenarios

### Restore historical item version

- **GIVEN** an item moved after creation
- **WHEN** user restores creation version from item history
- **THEN** item returns to original column
- **AND** restore appears as another immutable history change
- **AND** reload retains result

### Restore persistence failure

- **GIVEN** storage rejects writes
- **WHEN** user restores historical version
- **THEN** current item remains unchanged
- **AND** dialog reports failure with retry available

### Typing and connection presence

- **GIVEN** owner and editor devices connected
- **WHEN** editor types non-empty chat draft
- **THEN** owner sees editor typing
- **AND** header reports one editor and two online devices

### Stale typing presence

- **GIVEN** remote typing indication
- **WHEN** peer stops publishing or disconnects
- **THEN** indication expires without durable chat mutation
