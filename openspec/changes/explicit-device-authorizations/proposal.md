# Shared identity and independent application authority

## Why

The ecosystem needs one user-controlled identity across applications without
making an account, a running portal or an online authorization server a
prerequisite for local work. Existing identity, board access, storage recovery and
publication paths mix unrelated decisions and make changes spread across products.

The target separates product responsibilities and reuses MetaMesh's existing
crypto, signed history, device pairing and replication. It does not require a
whole-application rewrite or adoption of another distributed stack.

## What Changes

- Keep identity/profile/device/recovery rules in the shared MetaMesh identity
  domain. Deliver its static portal in a separate repository with the existing UI
  and CSS modules. The final product name is not selected.
- Keep Tincanban immediately usable locally. Provide adjacent account sign-in and
  creation actions. Creating a profile connects the current local identity to the
  portal and retains its boards. Device/participant invitations and first public sharing start this
  onboarding when needed, then resume the original action.
- Separate the personal Identity mesh from application data meshes: independent
  memberships, keys and authority, with shared transport and synchronization code.
- Use origin-bound common login. Each application owns its sessions and resource
  permissions; identity login never grants universal administration.
- Provide explicit 12/24-word plus encrypted-file identity recovery. Keep board
  import/export in `.tincanban`; identity recovery belongs to the Identity workflow.
- Replace device restoration with fresh exact authorizations, introduce explicitly
  accepted Rusty generations, and retain durable public/private publication intent.
  These are separately deployable changes, not prerequisites for common login.
- Let existing users export `.tincanban` content, create a fresh profile and
  import it as new boards. Same-person continuity remains available through the
  separate explicit device-enrollment and recovery flow.

## Capabilities

| Capability | Contract |
| --- | --- |
| `application-domain-model` | Product and domain ownership; local-first independence |
| `static-identity-application` | Optional onboarding, portal bootstrap, identity mesh and common login |
| `device-authorization-lifecycle` | Exact signed rights, device enrollment and irreversible withdrawal |
| `rusty-generation-access` | Storage continuity and scoped participant access |
| `board-publication-lifecycle` | Owner intent, public-copy availability and withdrawal |
| `durable-access-operations` | Exact retryable intent and verified durable outcomes |
| `content-export-import` | Content-preserving `.tincanban` export/import into fresh boards |

## Scope

[Design](design.md) is the complete target specification; capability files contain
its acceptance contracts. [Implementation disposition](domain-model.md) maps
existing code to retain, relocate or replace. [Tasks](tasks.md) orders delivery.
Common login is introduced before changing Tincanban onboarding or existing board
storage protocols. This specification does not select a new authorization library,
rename products, authorize production changes or require broad UI redesign.
