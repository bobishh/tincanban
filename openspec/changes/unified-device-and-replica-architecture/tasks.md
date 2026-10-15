# Remaining acceptance and release

Local final acceptance, source quality and production size checks have passed.
The remaining gates are publishing exact dependency pins, hosted CI and the
coordinated release.
Completed checks are not retained here as a diary. Requirements and scenario mappings remain in
[the specification](specs/device-and-replica-contracts/spec.md),
[architecture](design.md), [history contract](history-archive-contract.md) and
[acceptance map](verification-map.md).

Universal Inbox and declarative processing remain specification-only, by explicit
user decision. No new mail queue belongs in Settings. Existing signed application
binding and immutable posting-source behavior remain in this release. Board and
card typography retains Caveat; long detail/chat prose uses Fira Sans, technical
values use Fira Code. Existing writer policy remains unchanged.

- [ ] Review all authorized worktree changes, including the other agent's UI
  changes. Stage and commit the final SDK, Rusty and application changes only
  after local acceptance passes; publish exact dependency pins. The gitlink
  cleanliness check follows these commits, because dirty source cannot satisfy it.
- [ ] Run required CI against the final immutable revisions, including actual
  Linux WebKit and native/platform packaging checks.
- [ ] Deploy the compatible Rusty/automation/frontend cohort through CI. Preserve
  validated rollback state and interrupted-release recovery evidence.
- [ ] Verify production component SHA/digest/capabilities and the served frontend
  artifacts; reconcile operator instructions and the agent guide with observed
  release behavior.
- [ ] Complete the goal only after every required acceptance and release check
  passes. Report exact deployed releases and any required device refresh.
