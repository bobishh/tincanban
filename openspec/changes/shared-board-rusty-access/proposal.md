## Why

Owner-configured Rusty currently follows the owner's private identity settings. Other board participants depend on live browsers despite Rusty being configured. Restore board-wide durable delivery without disclosing private identity state.

## What Changes

- Exchange owner-attested, board-scoped storage access over authenticated participant sessions, including forwarding by authorized recipients.
- Give editors read/write delivery and visitors read-only delivery while owner devices are offline.
- Retain owner-only connection management, current membership checks, private progress, signed admission and service pinning.
- Show shared storage in Sync without attempting to provision the recipient's private identity on the owner's server.

## Capabilities

### New Capabilities
- `shared-board-storage`: owner-attested participant access and owner-independent delivery.

### Modified Capabilities

## Impact

Tincanban mesh metadata, private connection schema, replication lifecycle and Sync presentation. Existing Rusty protocol 2 bearer access is reused. No production deployment or unrelated routing/concurrency fix.
