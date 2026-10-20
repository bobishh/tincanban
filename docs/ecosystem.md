# Tincanban ecosystem

Tincanban is the product: a general board for work, notes, files, and chat. Job
search is one workflow built on those generic board and conversation features.
The repositories have separate responsibilities and release evidence.

| Component | Repository | Responsibility | Boundary |
| --- | --- | --- | --- |
| Tincanban | [`tincanban`](../README.md) | Board and chat UI, workspace data, product authorization, local persistence, and application workflows | Owns product behavior; does not own reusable transport or Rusty storage service code |
| MetaMesh | [MetaMesh repository](https://github.com/bobishh/meta-mesh) | Reusable identity, protocol, transport, replication, and runtime SDK | Supplies peer synchronization primitives; does not define Tincanban cards, roles, or job-search rules |
| Rusty | [Rusty repository](https://github.com/bobishh/rusty) | Optional HTTP service for opaque encrypted objects, signed receipts, and a separate public-board publication API | Cannot decrypt private workspace history or participate in the readable Automerge/CRDT sync protocol; storage does not grant editing rights |

Tincanban currently consumes MetaMesh from a pinned Git submodule. Rusty is an
optional independent storage service. Browser peers still exchange application
history directly through MetaMesh; Rusty stores encrypted snapshots and related
objects for later retrieval.

## Evidence and release status

| Layer | Source | Acceptance evidence | Deployment evidence |
| --- | --- | --- | --- |
| Tincanban | Product code and test suites in this repository | [`workspace-roles.spec.ts`](../e2e/workspace-roles.spec.ts) covers browser role flows; [protocol reference](protocol-and-tools.md) records the public-delivery acceptance gap. [Demo guide](demo.md) is a runbook, not a result report. | The guide links the live HTTPS demo; it does not claim every feature is in production |
| MetaMesh | Reusable Rust and TypeScript source in its repository | Its CI runs Rust, TypeScript, and formal checks; see [CI workflow](https://github.com/bobishh/meta-mesh/blob/main/.github/workflows/ci.yml) | npm workspace remains private and packages are not published; Tincanban pins source |
| Rusty | HTTP service and storage protocol in its repository | [Verification reference](https://github.com/bobishh/rusty/blob/main/docs/storage-protocol-and-operations.md#verification) lists HTTP, restart, browser, and CI coverage | A protected deployment workflow is documented in the [operations reference](https://github.com/bobishh/rusty/blob/main/docs/storage-protocol-and-operations.md#deployment-and-rollback); this checkout does not identify the currently deployed release |

Each service owns its source, acceptance, and deployment evidence. A passing
check in one repository does not establish another repository's deployment or
cross-service acceptance.

Tincanban is experimental and has not received an independent security audit.
Offline peers learn revocations after reconnecting, and previously received
plaintext cannot be recalled. Rusty copies depend on configured service
availability; local browser data is not a hosted backup.
