# Architecture and verification

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
