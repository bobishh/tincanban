## 1. Ordinary snapshot

- [x] 1.1 Add a failing test that an ordinary push after a document change omits a stored history baseline from the uploaded snapshot
- [x] 1.2 Add a failing test that an unchanged ordinary push does not upload again while a history baseline remains stored
- [x] 1.3 Stop ordinary snapshot capture from reading the stored history baseline

## 2. Checkpoint retention

- [x] 2.1 Add a test that a history storage checkpoint snapshot contains the published baseline
- [x] 2.2 Add a test that replica compaction keeps a stored history baseline in the compacted head
- [x] 2.3 Keep stored-baseline inclusion for history checkpoint publication and replica compaction

## 3. Receive and board loading

- [x] 3.1 Add a test that a history-bearing replica object does not advance the cursor when history admission fails, and advances it when admission succeeds
- [x] 3.2 Add a test that pulling an ordinary snapshot merges the document and does not call history admission
- [x] 3.3 Add a test that peer recovery does not dial when the current document is already retained
- [x] 3.4 Run the affected replica and peer-recovery tests
