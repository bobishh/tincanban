## 1. Scheduler

- [x] 1.1 Start a follow-up pass when sync is requested during a running pass
- [x] 1.2 Start at most two immediate follow-ups when a pass is still catching up
- [x] 1.3 Sync immediately on visibility and page hide, and use a two-second poll while visible

## 2. Document changes

- [x] 2.1 Upload Automerge changes for a document-only edit after a full snapshot
- [x] 2.2 Keep a full snapshot when chat, authority policy, attachments, history, or a non-Automerge document changes
- [x] 2.3 Apply a document-changes object onto the current document without history admission

## 3. Verification

- [x] 3.1 Run the replica, trigger, and replication-controller tests

## 4. Shared readers and release safety

- [x] 4.1 Use one product payload codec in browser and Worker send/receive paths
- [x] 4.2 Reject missing dependencies and inconsistent sender frontiers before acknowledgement
- [x] 4.3 Keep unpublished local branches eligible for their own outgoing upload
- [x] 4.4 Prove archived owner delivery and Worker intake through actual Native Rusty
- [x] 4.5 Record reader floor 3 and verify the older-tab write barrier
