## Context

`BlindReplica.snapshot()` builds one JSON object from the workspace document, authorization, chat, attachment locators, and, when `readHistoryBaseline` returns a publication, the history baseline. `captureSnapshot()` uses that object for every ordinary push. `receiveSnapshot()` sends any object that contains history through `receiveHistoryBaseline` before the replica cursor advances. History admission failure leaves the cursor unchanged.

`checkpointHistoryBaseline()` already passes the baseline it is publishing into `snapshot()`. `prepareCheckpointState()` compacts retained replica objects by calling `snapshot()` with no override, so it currently keeps a published baseline only because ordinary snapshot assembly reads one. Peer recovery dials another device when board loading cannot read a retained document. A pull that fails during history admission is one way the document stays unretained.

Rusty remains blind storage. It stores ciphertext and signs a receipt. It does not become a workspace member.

## Goals / Non-Goals

**Goals:**

- A card edit uploaded by ordinary replication is applied by document merge, without history admission.
- A published history baseline still reaches a receiver through a history checkpoint object and through any replica object that already contains history.
- Compaction of retained replica objects preserves a published baseline in the log.
- A phone that has merged the current document finishes board loading without a same-person history transfer.

**Non-Goals:**

- Replacing sealed snapshots with a log of mesh frames.
- Collapsing the mesh session, the replica poll, enrollment, and peer recovery into one scheduler.
- Removing chat or attachment locators from the snapshot. They have no separate replica object yet, so removing them would drop delivery for a storage-only device.
- Changing history admission rules for an object that contains a baseline.
- Treating Rusty as a device that can read or merge the board.

## Decisions

### Ordinary capture skips the stored baseline

`captureSnapshot()` asks for a snapshot that does not read `readHistoryBaseline`. The uploaded plaintext has no `history` field and stays version 1 unless a future field requires version 2. Chat and attachment locators stay in this object.

The first push after this change has a different content hash from the last history-bearing upload, so the new head is stored once. Later unchanged edits still follow the existing hash short-circuit.

### Checkpoint publication and compaction still carry a baseline

`checkpointHistoryBaseline()` continues to pass the baseline being published. `prepareCheckpointState()` continues to include the stored baseline when it builds the compacted head. Otherwise compaction would replace history-bearing objects with a head that no longer contains the only copy of that baseline.

### Receive follows the object, not the sender's mode

An object with `history` still uses `receiveHistoryBaseline`. Failure still prevents cursor acknowledgement. An object without `history` uses `merge`, which already applies a document that descends from a known compact basis and skips a verified archived snapshot from before that basis.

### Board loading stays a consumer

`loadIdentityBoards` does not grow a history-specific branch. Once ordinary pull merges the document, the existing retained-copy check in peer recovery finds the document and does not dial. Recovery still runs when the document is missing or the pull fails for another reason.

## Risks / Trade-offs

- [A receiver whose cursor is already past the history checkpoint, and which then only receives ordinary objects, does not re-admit that baseline on every card.] → Current cards merge through `merge`. A new baseline still arrives in its checkpoint object. Old inventory objects that contain history keep the strict admission path.
- [Compaction and ordinary push can disagree about whether history is present.] → Only `captureSnapshot()` opts out. Checkpoint and compaction keep the stored baseline.
- [One more full snapshot is uploaded when the hash changes.] → That upload is the migration. It is not repeated for an unchanged board.

## Migration Plan

Deploy the client that omits history on ordinary push. Already stored objects remain valid. Rollback restores history on the next ordinary push; receivers still accept both shapes.

## Open Questions

None for this slice. A later change can replace the snapshot body with the same frames a live session already exchanges.
