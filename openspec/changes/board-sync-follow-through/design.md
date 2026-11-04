## Context

Automatic replica sync returned the in-flight pass when another request arrived, so the new document waited for the poll. The poll was fifteen seconds and did not run on show or hide. Ordinary uploads sealed the whole board even when only an Automerge document edit had happened.

## Goals / Non-Goals

**Goals:**

- A request during a pass, a pass that is still catching up, showing the document, and hiding the page all start another pass without waiting out the poll.
- A visible device's fallback poll is two seconds. A hidden device keeps the fifteen-second fallback.
- A document-only edit after a full snapshot uploads Automerge changes. The receiver applies them to the document it already has.

**Non-Goals:**

- Replacing the live mesh session.
- Removing chat or attachment locators from a full snapshot.
- Making an updated client unnecessary for reading a `document-changes` object. An old client stops its cursor on that object until it is updated. Compaction still writes a full snapshot, but an old client does not move past the change object to reach it.

## Decisions

### Follow-up lives in the one sync entry

`syncNow` sets a follow-up flag when called while a pass is running and starts one more pass when the current one finishes. A catching-up result starts at most two extra passes, so a replica that can never catch up does not spin. The manual Sync action still waits for the background pass and then runs its own pass.

### Visibility resets the fallback and syncs now

The trigger listens for `visibilitychange` and `pagehide`. Each event syncs immediately and selects the two-second or fifteen-second interval from `document.hidden`.

### Changes are a payload, not a new cursor rule

The logical snapshot hash stays the upload identity, so an unchanged board still skips. The sealed bytes are `{ version: 3, kind: "document-changes", heads, changes, authorization, chat }` when the previous uploaded bytes are an Automerge document and only the document and its signed change records changed. Changes to chat, authority policy or attachments, a non-Automerge document, or a document without the previous uploaded heads fall back to the full snapshot. The product owns one payload codec used by the browser and Worker; the SDK still owns sealing, HTTP, receipts and cursor persistence. The receiver applies changes using its local dependency history, then clones the sender's exact declared heads before causal admission and the existing document merge. The receive identity describes only the sender's retained state; unpublished local branches must still upload. History admission stays on objects that contain a history baseline.

## Risks / Trade-offs

- [An old client rejects `document-changes` and retries that object.] → Ship the frontend, Worker and headless runtime readers together. An old open browser must reload. Record workspace snapshot reader floor 3 so rollback cannot select a reader that rejects retained deltas. Full snapshots remain valid for objects already stored.
- [A receiver checks that every incoming change is present after application; missing dependencies reject before merge and leave the cursor.] → The next successful snapshot upload is a full document after restart, because the in-memory base is gone. A receiver stuck on a change object needs the updated client, which can apply it.
- [Two-second polling while visible costs an inventory read per replica.] → Unchanged content does not upload. Hidden tabs return to the slow fallback.

## Migration Plan

Deploy the client that writes and reads change objects together. Rollback stops writing change objects; already written ones remain until an updated client or a later full snapshot is reachable.

## Open Questions

None.
