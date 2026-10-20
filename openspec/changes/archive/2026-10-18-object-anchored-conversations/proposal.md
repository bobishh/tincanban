## Why

Workspace chat currently requires users to explain which item or text they mean. Discussions need references to selected objects and passages, replies that remain visible in the common log, and windows that keep context beside the discussion. Message links also need an honest resolution contract while workspace access depends on locally available data and existing peer admission.

## What Changes

- Add one contextual Discuss action for whole items, fields, and selected text, opening a composer with an attached anchor.
- Store references, replies, and explicit mentions in signed message records. Mentions invite attention; they do not determine message destination or grant access.
- Render the same message in the workspace log and relevant object/root conversation views, with one visible reply level.
- Introduce shared movable, resizable windows for item details, chat, and conversations, with one focus/z-order ring and local layout state.
- Allow copying and opening stable message links; resolve known local workspaces and show unavailable, loading, or missing-message states explicitly.
- Preserve existing signatures, permissions, sync, persistence failure behavior, and bounded history retention.

## Capabilities

### New Capabilities
- `object-discussions`: Contextual anchors, mentions, replies, and conversation projections over one workspace message log.
- `conversation-windows`: Shared window positioning, resizing, focus order, and responsive conversation access.
- `message-references`: Stable message links and local workspace/message resolution.

### Modified Capabilities
- None. Existing workspace-chat behavior is documented in a change README rather than a canonical capability spec; this change extends that implementation contract.

## Impact

Signed chat payloads and validation, IndexedDB message projections, chat sync/import, item rendering and selection, contextual composer, startup navigation, and shared window UI. Browser coverage must precede UI implementation. No new server replica, automatic workspace discovery, external access grant, or unbounded chat archive is included.
