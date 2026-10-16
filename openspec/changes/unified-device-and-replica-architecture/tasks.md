# Release completion contract

> Historical release plan: its coordinated cohort requirements below are
> superseded. Each service now verifies and deploys through its own pipeline; see
> [current architecture](../../../docs/architecture.md) and the
> [independent platform boundaries](../independent-platform-boundaries/design.md).

Requirements and acceptance mappings remain in [the specification](specs/device-and-replica-contracts/spec.md),
[architecture](design.md), [history contract](history-archive-contract.md) and
[acceptance map](verification-map.md). Execution state belongs to the active goal,
GitHub Actions runs and the release coordinator's retained activation evidence;
this file does not keep a diary of completed checks.

Universal Inbox and declarative processing remain specification-only, by explicit
user decision. No new mail queue belongs in Settings. Existing signed application
binding and immutable posting-source behavior remain in this release. Board and
card typography retains Caveat; long detail/chat prose uses Fira Sans, technical
values use Fira Code. Existing writer policy remains unchanged.

Completion requires all of the following:

- Implementation and affected acceptance scenarios pass without weakening
  interaction/Worker responsiveness, signature checks or exact attachment bytes.
- All authorized SDK, Rusty and application worktree changes, including UI changes,
  are committed and published with exact dependency pins and a clean gitlink.
- Required hosted CI passes against the final immutable revisions, including
  Linux WebKit UI, macOS WebKit device enrollment and native/platform packaging.
  WebKitGTK cannot provide the required WebRTC bootstrap.
- CI activates one compatible Rusty/automation/frontend cohort, retaining rollback
  and interrupted-release recovery evidence.
- Production source commits, executable/image digests, capabilities, Worker
  versions and served frontend bytes match the checked artifacts. Operator
  instructions and the agent guide describe that release accurately.

A local pass or one deployed component cannot establish completion. Report the
exact active cohort and any required device refresh only after production
verification succeeds.
