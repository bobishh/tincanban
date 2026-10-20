# Proposal: Scope workspace catalog to identity entitlements

## Why

The local workspace catalog survives device identity replacement. A board created under the previous identity can remain visible after enrollment, even though the new identity has no owner or member grant for it.

## Change

- Derive available and archived catalog entries from the active identity's personal-root workspace references.
- Keep local document bytes when identity changes; hide documents absent from the new root.
- Preserve workspace references explicitly imported by a validated visitor/editor invitation.
- Stop startup from registering every locally stored document into whichever identity is active.
- Repair old `genesis` references only when the loaded document proves a different genesis owner; keep explicit invitation refs and unavailable documents.
- Never infer ownership or access from peer count, peer presence, or owner offline state.

## Validation

Check root filtering and legacy repair in unit tests; verify real device enrollment hides the old local bootstrap while retaining access to the enrolled identity's board. Model finite identity replacement, local-byte preservation, invitation visibility, and unchanged ownership with TLC.
