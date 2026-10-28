# Tincanban working agreements

Apply these agreements to Tincanban only, together with the global working
agreements. Adapted from Obie Fernandez's
[Impatient Programming rules](https://impatientprogramming.org/rules/), licensed
under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). This is a selective
adaptation for one maintainer working with a coding agent, not adoption of every
source rule. Existing authorization and release boundaries still apply.

## Honest disagreement

- Challenge a proposal from the user or agent before implementing it when evidence
  indicates likely data loss, weaker security, broken contracts, unnecessary
  complexity, or maintenance cost disproportionate to the intended benefit. Do not
  agree merely because the user proposed it.
- State the objection directly: the proposed action, concrete failure mechanism,
  affected behavior or invariant, supporting evidence, and a safer or simpler way
  to achieve the same goal. Label unverified risks as hypotheses and investigate
  them with the cheapest useful check. Separate technical harm from taste.
- For a consequential unresolved tradeoff, explain the recommendation and ask for
  the user's decision before taking the disputed action; continue independent
  work. Once the user makes an informed choice, follow it within applicable
  constraints. Reopen the objection only when new evidence changes the risk.
- Challenge these agreements too when they obstruct useful work. Explain the
  concrete problem and propose a focused amendment rather than silently ignoring
  a rule or inventing additional process.

## Outcomes and learning

- Before implementing a feature, state the user-visible outcome, scope exclusions,
  and concrete Given/When/Then acceptance criteria in chat or the existing issue.
  Ask what must still be learned; distinguish known facts, assumptions, and open
  product decisions. Do not invent delivery dates while critical unknowns remain.
- Complete one demonstrable vertical slice at a time. Measure progress by working
  behavior and fulfilled acceptance criteria, not lines, test counts, commits, or
  partially completed layers. Distinguish production defects from refinements of
  unreleased work when reporting results.
- Resolve consequential product uncertainty with a small prototype or experiment
  and show the result to the user. Give each experiment a question and observable
  decision criterion; discard temporary code after learning from it. Use existing
  artifact locations. Do not add speculative features or permanent frameworks.
- Protect human attention: handle routine implementation and checks autonomously;
  surface intent, consequential decisions, evidence, and blockers concisely. Keep
  shared knowledge in maintained contracts and project documentation, not agent
  diaries. Weekly showcases, daily briefings, extra agents, and scheduled work
  require a request; these agreements do not initiate them.

## Executable contract and simplicity

- The contract is the maintained description of required observable behavior,
  invariants, interfaces, and relevant non-functional requirements, backed by
  executable checks. Extend existing domain tests, acceptance tests, schemas, and
  interface documentation at their authoritative owners; do not create a second
  parallel specification or a new framework called Contract.
- Before changing existing behavior, inspect its callers and tests, establish what
  must remain true, and understand why existing restrictions exist. Express the
  intended change in acceptance criteria before writing its implementation; do
  not retroactively redefine success to match whatever the agent built.
- For behavior changes, author the outer acceptance scenario/test first. For
  non-browser logic or integration changes, confirm the intended test failure
  before implementing. For UI changes, execute browser verification after
  implementation, covering the happy path and a relevant failure or pending state.
- Before completing a change, simplify within its scope: fold exploration back
  into existing concepts, remove superseded paths and duplication, and keep public
  interfaces small. Finish the agreed behavior, including relevant error and retry
  handling; do not expand scope under the claim that generated code is cheap.
- Keep components understandable and replaceable through explicit contracts and
  focused tests. Rewrite only for a demonstrated benefit, with preservation of
  existing behavior and data verified; regeneration is not a maintenance ritual.

## Evidence and release

- Every added test must protect a named behavior or plausible regression. Prefer
  the cheapest sufficient test at the appropriate boundary. For a bug, add the
  missing obligation and show a regression test fails for the reported reason
  before fixing non-browser behavior; follow the UI timing rule above for UI bugs.
- Use targeted mutation or deliberate fault injection when it resolves doubt about
  a test's ability to detect the relevant failure. Do not require a mutation matrix
  for every change or remove tests solely because they detect overlapping mutants;
  distinct contracts, boundaries, and diagnostics can justify that overlap.
- Enforce mechanical standards with existing automated checks. Add or strengthen
  a guardrail when a recurring failure warrants it; do not weaken checks or tailor
  expected results to make an incorrect implementation pass.
- Review the final diff against the original intent and contract, not just green
  checks. This review may be automated. Report verified obligations and important
  gaps; do not invent a contract coverage percentage without an explicit inventory
  and measurement method.
- Integrate small, locally verified changes through the existing release workflow.
  Within the user's authorization, allow automated review, integration, and release
  when scope is bounded, relevant contracts are checked, consequences are
  understood, and recovery is verified. Do not require separate human review by
  default; involve the user for consequential unresolved tradeoffs as described
  above. Judge risk by affected behavior and reversibility, not diff size alone.
- Scale recovery proof to the consequences. Changes to local persistence,
  identity, permissions, encryption, and replication need evidence that existing
  data and access rules survive the transition. An application rollback is
  sufficient only when it also restores the affected guarantees; it does not by
  itself reverse data loss or unauthorized disclosure.

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
