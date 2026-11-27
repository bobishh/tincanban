## Why

A valid Tincanban connection can stop a scheduled Reflux workflow when its
30-day owner grant expires. Reflux currently reports the connection as active
while the participant can no longer read the board.

## What Changes

- Let an authorized workspace owner grant the existing service participant
  scoped access that remains effective until withdrawal. Keep access tied to
  that participant, board, approved permissions and current workspace authority.
- Issue short-lived credentials automatically to the service. Check current
  authority before issuing and using them so scheduled work continues while
  the owner is offline.
- Let the owner upgrade an existing or expired approval through the regular
  connection flow. Preserve participant identity, scope, board history,
  pending work and delivery deduplication.
- Show verified access state and the time of the last verification in Reflux.
  Surface expiry, renewal trouble, and withdrawal without presenting a
  provisioned connection as ready to use.
- Provide a separate owner-authorized operation for revocation. Make withdrawal
  fence further use and renewal while preserving the board and retained
  automation records.
- Remove the temporary `/automation/renew` route when the normal flow supports
  upgrade.

## Capabilities

### New Capabilities

- `service-automation-access` defines owner approval, credential issuance,
  legacy upgrade, and connection status.
- `service-automation-revocation` defines the separate withdrawal operation
  and enforcement across issuance and ordinary use.

### Modified Capabilities

None.

## Impact

Tincanban connection approval and replica admission, shared MetaMesh authority
verification, scoped credential issuance and enforcement, the Reflux reaction
runtime, and Reflux workflow connection status. The release must verify the
existing Job Hunt participant can read the board and complete a run after
upgrade.
