## Context

See exploration.md for source/history evidence. The privacy boundary is correct; the missing board-access channel is the defect.

## Goals / Non-Goals

Goals: existing and newly invited participants receive owner-approved storage automatically; editors publish and visitors pull with owner offline; prevent a recipient from installing a different server as if owner-approved.

Non-goals: share identity state across people, make Rusty an editor, weaken causal admission, change deployment or fix peer routing limits.

## Decisions

1. Store an explicit participant-access attestation with a received workspace connection. Sign only portable credentials and the write-token hash; cursor/outbox never crosses identities. Read-only connections use an empty write token and never prepare uploads/checkpoints.
2. Verify owner certificate chain/signature, board and service binding, policy revision and actual write-token hash. Readers can forward reading access; writers can forward writing access only to currently authorized editors. Owner configuration and removal remain signature-protected operations.
3. Wrap durable mesh metadata separately from same-person preference exchange. Reuse the current peer-history authorization guard before and after asynchronous work. Strip access metadata before ordinary mesh merge; reject malformed, unsolicited and foreign-workspace packets.
4. Persist through the recipient's existing conflict-safe private repository. Replay of identical access does not reset progress; older revisions cannot roll back credentials. Same-person replication can transport this recipient's own board access to their enrolled devices.
5. Exclude received board connections from private identity provisioning and owner management-status reads. Guard received access again before network work. Sync explains read-only versus read/write access without exposing keys/tokens.

## Risks / Trade-offs

Tokens remain Rusty protocol 2 bearer capabilities. Removing a person prevents new authorized mesh delivery and admission of their new board writes; it does not erase old credentials/plaintext. Future confidentiality requires owner key rotation. Keep this visible in documentation, and do not claim per-person HTTP revocation. Configuration bootstrap requires one reachable peer holding sufficient owner-attested access. Owner transfer invalidates old-owner attestations until renewed.

## Migration Plan

Existing owner connections are attested automatically on an authorized session. Existing participants acquire them on the next metadata publication; late invitees on durable handoff. Unsupported older recipients continue their old behavior without receiving personal identity state. No destructive migration.

## Validation

Start with failing integration scenarios for role-scoped exchange and replay; exercise real signatures and repository progress, read-only replication, and runtime wiring. Browser acceptance covers separate identities, owner-offline delivery, owner-only management and unavailable storage. Run focused tests, types and affected lint; report any independent baseline failures.
