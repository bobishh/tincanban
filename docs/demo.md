# A five-minute tincanban demo

Use two disposable browser profiles with the same application version. Keep both
windows visible. The deployed [HTTPS app](https://match.meta-uber-engineer.dev/)
avoids local HTTPS setup for a second physical device.

## 1. Show the product

Create a blank board named **Release checklist**. Add a card titled **Ship the
first demo** and a short description. Move it between columns, edit it, and reload.
Explain that this is a browser-local document; saving does not wait for a server.

## 2. Show collaboration and its boundary

From Sync, invite the second profile as an editor. Accept there and approve on the
owner. Edit the card on the editor and observe it update on the owner.

An editor may edit content but cannot change the board schema or grant access.
A visitor is read-only. These restrictions are checked below the UI; see
[e2e/workspace-roles.spec.ts](../e2e/workspace-roles.spec.ts).

## 3. Show persistence and offline work

Reload the editor. Its board and role remain. Temporarily disconnect that browser
from the network, edit the card locally, then reconnect. Wait for the edit to reach
the owner. Offline edits and a cold offline launch are different: tincanban does not
currently cache its entire application shell for guaranteed offline loading.

## 4. Show an attachment and history

Attach a small text file or PDF. Open or download it from the second browser while
the source is online. The document reference replicates with the board; file bytes
are fetched separately. Inspect a card's history and restore an earlier version:
restoration makes a new change rather than deleting the old one.

## 5. Explain the engineering choices

- Automerge handles concurrent document changes, not permission decisions.
- Commands and incoming changes pass authorization checks before persistence.
- MetaMesh owns reusable identity/transport/runtime primitives; tincanban owns board
  semantics and application orchestration. Browser orchestration is still partly
  in tincanban, so the extraction is not complete.
- **Add my device** keeps the same personal identity and transfers its signed
  catalog/profile plus private Rusty settings after existing-device approval.
  Recovery backup can restore those identity components on a replacement device;
  it does not include board history or attachment bytes. Inviting another person
  creates a separate identity with only the approved workspace access.
- Source-backed job applications retain the original URL-extracted posting and
  captured thread/ATS references. Editable card labels and later page refreshes do
  not replace that evidence. Ambiguous retained email stays in review until an
  owner binds it to an application and retries it.
- The system trades a central always-online replica for local ownership of data;
  peers and relay infrastructure still affect availability.

A useful closing discussion is what remains: fully independent local/runtime
loading, simpler application boundaries, remote recovery from a stolen device,
and adversarial protocol review. Identity backup restores identity state; it does
not remotely revoke the old device or include board history and attachment bytes.
Do not present experimental succession as a consensus protocol or the number of
tests as a security guarantee.

## Before a live demo

Follow the [README verification steps](../README.md#verify-changes). Keep a `.tincanban`
export of the demonstration board, refresh both profiles after deployments, and
verify the connection before presenting. A workspace export is not an identity-key
backup. Do not use your personal browser's enrollment link for someone else's device.
