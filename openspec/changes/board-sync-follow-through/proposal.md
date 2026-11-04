## Why

A card edit that arrives while a replica pass is already running waits for the next poll, and a phone that has just been opened waits the same way. A visible device still uploads a fresh copy of the whole board for a one-line change.

## What Changes

- A sync request that arrives during a pass starts another pass as soon as the current one finishes. A pass that is still catching up starts at most two immediate follow-ups.
- Showing the document, or the page starting to hide, starts a pass immediately. The visible fallback poll is two seconds. The hidden fallback stays fifteen seconds.
- After a full snapshot of an Automerge board, an ordinary edit that changes only the document uploads the Automerge changes. Chat, authority-policy, attachment, and history changes still upload a full snapshot. A receiver applies those changes onto the document it already has.
- **BREAKING** for a client that has not been updated: a `document-changes` object does not validate as a snapshot, so that client's cursor stops on it until the client is updated.

## Capabilities

### New Capabilities

- `board-sync-follow-through`: Replica passes follow local changes and visibility, and document edits travel as Automerge changes.

### Modified Capabilities

## Impact

- `src/sync/useBlindReplication.ts` schedules the follow-up pass.
- `src/sync/privateReplicationTriggers.ts` owns visibility and the two poll delays.
- `src/product-replica/workspaceReplicaPayload.ts` owns the shared version 3 document-changes codec and sender-frontier validation.
- `src/sync/blindReplication.ts` and `workers/automation/src/replica.ts` use that codec behind their existing signed admission and durable delivery.
- Release metadata records workspace snapshot reader floor 3.
- Existing full snapshots remain readable. History checkpoints are unchanged.
