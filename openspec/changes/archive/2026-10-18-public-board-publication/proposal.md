## Why

Planning status (2026-10-16): snapshot/manual-Update and separate-reader presentation decisions below are superseded by [unified-board-visitor-access](../unified-board-visitor-access/proposal.md). This document records the previous implementation contract, not the new target behavior.

People need a board link they can post in a blog and open without pairing, an invitation, or an online author device. Public readers should not become workspace participants merely to see published content.

## What Changes

- Add owner-controlled publication of one selected board to the existing Keeper/Rusty service, with a stable `/boards/<board-id>` frontend URL.
- Serve an explicit public projection independently of private encrypted workspace replication. Publishing discloses the selected board's active cards, bodies, columns, fields, anchored discussions and attached documents/files. Other boards, archived content, unrelated workspace documents/global chat, identity records, credentials and history stay private.
- Add publish, update and unpublish commands, durable revisions and visible pending/error states. Successful publication survives browser closure and Keeper restart.
- Add an anonymous read-only route that does not initialize a local identity, permissions, Automerge or mesh. Public viewing uses no Visitor grant or participant registry.
- Optionally emit one content-free public-view event through the existing configured ClickHouse ingestion contract; delivery never gates viewing.
- Keep existing private Visitor invitations and deny-write authorization intact. Anonymous public reading needs no Visitor role.

## Capabilities

### New Capabilities

- `public-board-publication`: Selected-board content/discussion projection, authenticated durable publication with separate public file copies and withdrawal, anonymous rendering/downloads and optional aggregate view events.

### Modified Capabilities

None. Private blind replication remains a separate contract; its ciphertext endpoints do not become public plaintext endpoints.

## Impact

Tincanban board/settings controls, startup routing, public projection/client/view modules, browser and unit coverage, deployment public-origin configuration and documentation. Sibling `../mesh-lighthouse` gains a separate publication namespace, authenticated mutation endpoints, anonymous reads and native persistence/authentication tests. No domain purchase, production board publication, new hosting service or deployment is implied by implementation.
