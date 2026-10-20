## Context

The application uses Vue, Automerge workspace documents, and a separate IndexedDB chat journal. Messages already have immutable device-prefixed UUID IDs and certified signatures. Chat scope survives local workspace rekeying and isolates unrelated legacy workspaces. History is capped at 2,000 messages / 4 MiB per scope; pruning is monotonic. Before this change, chat rendered as a modal with resize behavior rather than a shared spatial window system.

This change defines product behavior before implementation. It must integrate with the existing workspace-kernel change rather than assuming future URL routes or object identity support already exist.

## Decisions

### 1. Reference, reply, and view remain separate

Logical message metadata:

```ts
type MessageContext = {
  references: Anchor[]
  replyTo?: string
  conversationRootId?: string
  mentions: string[] // person IDs, not display names
}

type Anchor = {
  workspaceScope: string
  boardId: string
  itemId: string
  fieldId?: string
  selection?: {
    exact: string
    prefix: string
    suffix: string
    start: number
    end: number
  }
}
```

First implementation targets items, fields, and text within fields/item narrative. Events, files, views, log ranges, and diffs are future anchor types; do not invent unsupported object resolution now. Object IDs and field IDs carry identity; titles and quotes are presentation/fallback context. Selection offsets refer to canonical plain text, not DOM nodes or rendered Markdown offsets.

One immutable message record owns body and metadata. Global log and conversation views project records; they never create copies. An item discussion includes direct item/field/selection references plus replies in roots referencing that item. An exact-selection view can filter more narrowly. A message referencing two items appears in both item discussions once and in the global log once. Multiple roots for the same item remain distinct reply groups.

Replies target a message ID. Root is normalized when composing, so replying to a reply adds a sibling under the original root while quoting the immediate target. Reply metadata must stay in the same scope, reject self references/cycles, and accept temporarily absent targets from out-of-order delivery or retention with an explicit unavailable quote. Do not require retained parent records to verify a valid signed reply. Root membership must be checked when enough records arrive; inconsistent chains must not silently merge conversations.

### 2. One Discuss action

Desktop selection exposes a small Discuss affordance and a contextual-menu fallback. Whole items have a stable Discuss control. Composer opens beside context where room permits, attaches a quote/reference chip, and accepts ordinary text and optional mentions. No separate Comment versus Send to action.

Touch uses the stable item control and an app-owned Discuss action after text selection. A contextual long press may supplement these paths without intercepting ordinary scrolling or native text selection. Web code cannot assume it can inject controls into the operating system selection menu. Keyboard users reach whole-item/field controls and the composer without pointer gestures.

Explicit mention selection resolves current workspace participants to stable person IDs. Typing an unselected display-name string alone must not notify the wrong person. Mentions do not create private/direct messages. All messages remain subject to workspace visibility and existing grants; visitors can follow references but cannot write. Existing notification policy applies, with deduplication across views and tabs.

Draft, anchors, and reply target survive write failures. Saving state uses a temporary UI ID; copied links become available only after durable commit assigns the immutable message identity. Closing a view does not delete committed messages.

### 3. Resolve anchors without guessing

Opening an anchor focuses the owning item and field. If current canonical text matches the captured range and context, highlight that range. Otherwise locate a unique contextual match. An ambiguous or missing match shows the original quote and a changed-source state, without highlighting an unrelated occurrence. Renames do not break references. Deleted items/fields show unavailable source and retain the captured quote. Capture only intended selection plus bounded context; never serialize an entire DOM subtree.

### 4. Shared window model

Local view state holds window ID, content descriptor, position, size, and focus order. Content descriptors cover Item, WorkspaceChat, and Conversation(anchor or root). One manager supplies drag, resize, raise/focus, close, and keyboard cycling. Reopening identical content focuses its existing window. Workspace boundaries remain explicit; switching workspace hides its windows and restores the selected workspace's layout.

Focus order is a bounded ordered ring, not a permanently incrementing z-index counter. Clicking/focusing a window raises it. Only the active window receives window-level shortcuts. Nonmodal windows allow board interaction; confirmation dialogs remain modal and above the window ring. Conversation windows must not inherit modal scroll locking or trap focus away from other windows.

Persist geometry locally, outside signed messages and replicated workspace data. Clamp restored windows to the viewport, preserve reachable headers/actions after resizing, and supply keyboard alternatives for movement/resizing. On narrow/touch layouts use a usable single-view or stacked presentation with explicit return navigation while preserving the same underlying messages and view identities. Closing windows restores focus to a reachable trigger or board control.

### 5. Message links use stable chat scope

```ts
type MessageReference = {
  version: 1
  workspaceScope: string
  messageId: string
}
```

Use a fragment on the current deployment: `#message=<percent-encoded JSON {version:1,workspaceScope,messageId}>`. Final codec must preserve deployment base paths and existing invitation/login routing. Scope is the existing canonical chat scope, not the mutable local workspace ID; resolve it through the known workspace catalog. Encode and validate values, lengths, and version before navigation. Include no grants, invitation secrets, message body, or identity keys.

UI action is Copy message link, with concise help: works where this workspace is already available. Clipboard success is reported only after success; denial exposes a selectable URL fallback. Copying a link does not join or invite anyone.

Known scope opens its workspace, raises the relevant root conversation (or workspace chat for an unthreaded message), loads enough retained history, focuses and highlights the exact message. A target may be outside the initial 100 rendered messages. Navigation must not mark unseen messages read merely by loading them; preserve existing visibility/read semantics.

Unknown scope shows Workspace unavailable with available existing join/import controls, and retains the target for retry after the workspace becomes available. No automatic peer discovery or network fetch is promised. Missing retained message shows Message unavailable; do not claim deletion when pruning or incomplete sync could explain absence. Pending chat load shows loading rather than unavailable. Revoked/blocked access must not expose cached message content through link navigation.

### 6. Signed protocol and retention

References, mentions, immediate reply ID, and root ID are part of the signed payload and validated before storage/rendering. Introduce a versioned payload extension with explicit legacy compatibility: existing v1 messages remain readable as plain messages; peers that cannot understand the new schema must not re-sign, strip, or downgrade metadata. Local contextual sends persist independently of peer availability or capabilities. Capability negotiation applies only to synchronization: withhold complete signed contextual records from unsupported peers until they advertise contextual-v2.

Maintain existing per-record, text, profile, message-count, and byte bounds. Add explicit finite limits for references, mentions, and quote/context sizes within the existing 32 KiB record cap. Metadata participates in byte accounting and immutable duplicate/conflict comparison. Payload and projected storage metadata must agree with the verified record. Persist before publishing send/sync events. Preserve import idempotency, deterministic ordering, and monotonic pruning; missing ancestors/sources are normal renderable states.

The log is append-only for accepted messages within retained history, not a promise of infinite storage or a new Automerge chat document. Existing export/enrollment limitations remain unless explicitly addressed by a later change.

## Delivery order

1. Write failing outer browser scenarios for contextual send, replies, windows, and local message links, including failure/pending states.
2. Define signed metadata and compatibility, then storage/sync projections and anchor resolution.
3. Build contextual composer and conversation queries.
4. Introduce shared window manager and integrate item/chat/conversation content.
5. Add clipboard and startup/in-app link resolution.
6. Verify desktop, tablet, keyboard, storage failure, retention, and independent-peer behavior.

## Risks and open questions

- Rendered Markdown selection requires an explicit canonical-text mapping; offsets alone cannot safely preserve references after edits.
- Protocol rollout across old peers needs a negotiated boundary; UI cannot promise rich context while transports discard it.
- Local catalog may map several restored copies to one scope. Resolve deterministically to an authorized active copy or expose a chooser; never select by title.
- Long-term discovery and invitations belong to workspace access, not this link codec.
- Geometry persistence and touch affordances need browser proof; shared z-order must coexist with existing modal confirmations.

## Validation

Isolated Playwright on real routes, Given/When/Then shape, happy path plus failure/pending state for each UI slice. Test desktop, 1024px tablet, narrow portrait, keyboard cycling, duplicate windows, viewport shrink, and unknown/missing link targets. Verify real IndexedDB retry and retained history, out-of-order replies, signed metadata tampering, legacy reads, two-peer convergence, and rekey-safe reference resolution. Use an alternate local port when the user server occupies the default. Do not inspect or control existing user browser tabs.
