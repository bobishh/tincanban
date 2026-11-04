## Why

A card edit is delivered by re-encrypting the whole board, and that snapshot also carries the history baseline. The receiver then admits history before the card is applied. Phone sign-in can fall through into peer history transfer when that admission fails. Current cards and historical proof are one delivery.

## What Changes

- An ordinary workspace replica upload carries the current document, its authorization, chat, and attachment locators, and omits any stored history baseline.
- A history storage checkpoint still carries the baseline it publishes. An object that already contains history is still admitted before the replica cursor advances. Admission failure still does not acknowledge that object.
- A snapshot without history is merged as the current document and does not start history admission.
- Document compaction retains a published baseline in the replica log. It does not drop the only stored copy of that baseline.
- Board loading shows a workspace once its current document has merged from storage. It does not start same-person history transfer merely because ordinary delivery omitted history.

Chat, attachment bytes, the fifteen-second poll, live mesh sessions, and the enrollment ceremony stay as they are. Replacing snapshots with a change log is a later change.

## Capabilities

### New Capabilities

- `board-snapshot-delivery`: Ordinary replica delivery of the current board is separate from history-baseline admission.

### Modified Capabilities

## Impact

- `src/sync/blindReplication.ts` decides when a snapshot includes history and which receive path runs.
- Replica tests in `src/sync/blindReplication.test.ts` cover ordinary upload, checkpoint upload, and both receive paths.
- History checkpoint publication (`src/sync/blindHistoryCheckpoint.ts`) keeps its existing submit path.
- Phone board loading (`src/app/loadIdentityBoards.ts`) changes only as a consequence of a successful document merge. Peer recovery remains for a missing or failed document copy.
