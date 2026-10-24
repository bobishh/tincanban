# Architecture and verification

## Local verification and CI budget

- Run development iterations and the main verification workload locally. Before
  pushing, run the relevant CI-equivalent checks locally and inspect their results.
- Batch verified changes into one release push. Do not push intermediate fixes
  merely to discover failures in CI or repeatedly run the full remote matrix.
- Use CI for the final release check and reproducible deployment artifacts. If it
  fails, reproduce and fix the cause locally before another push; rerun only the
  affected failed jobs when the source revision is unchanged.
- Reuse successful evidence until code or an unresolved failure justifies another
  run. Cancel only this task's obsolete runs; preserve unrelated work and processes.

## Architecture

- Keep maintained repository documentation in English. Translate current Russian
  documentation; remove demonstrably obsolete documents and disposable agent
  notes, handoffs, progress logs, and execution reports instead of preserving them
  as repository artifacts. Keep task reports outside Git under the configured
  deliverables directory. This does not apply to product content, localization,
  learning materials, test fixtures, or third-party files.

Apply the global working agreements. For changes to domain rules, module ownership,
or cross-service contracts, read [codebase-design](.agents/skills/codebase-design/SKILL.md)
and its [architecture review procedure](.agents/skills/codebase-design/ARCHITECTURE-REVIEW.md).

- Work toward one complete user-visible scenario at a time. Before implementation,
  state the acceptance scenario, invariant owner, authoritative state, changed
  interfaces, and failure/retry behavior. Keep task progress in chat or the issue,
  not repository diaries.
- Each invariant has one authoritative owner. Callers supply domain intent and
  data; the protocol SDK owns wire normalization, signing envelopes, HTTP, and
  response verification. Do not duplicate these rules in application callers.
- Budget at most seven primary domain concepts understood together per bounded
  context and three required semantic relationship hops per scenario. These are
  review budgets, not measured memory limits, method counts, or call-stack limits.
  Simplify before exceeding them; explain concrete remaining exceptions.
- Do not create forwarding modules, new contexts, or services just to satisfy a
  count. A small interface must hide implementation knowledge, not move it into
  ordering constraints that every caller must remember.
- When changing an inter-service protocol, prove the actual client and server
  interoperate. Separate self-consistent mocks do not establish compatibility.
  For durable cross-service changes, cover retry after the relevant failure or
  restart. Keep ordinary data reads free of unrelated control-plane writes.
- Run `npm run quality:deps`, `npm run quality:replica`, and
  `npm run quality:patterns` for affected boundaries. Include fixtures that both
  reject forbidden dependencies and accept intended public interfaces when
  changing a static rule. Do not disable rules to complete a feature.
- Review the final diff against the declared ownership and scenario. Distinguish
  unfinished behavior, protocol bugs, architectural violations, and unverified
  hypotheses. Green static checks do not prove semantic ownership or scenario
  completion. Report the actual evidence and remaining gaps.
