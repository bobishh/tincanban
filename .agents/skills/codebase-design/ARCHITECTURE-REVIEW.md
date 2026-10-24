# Architecture review procedure

Use for a change to domain invariants, ownership, or a shared protocol. Small
presentation edits do not require this procedure. Record task-specific evidence
in chat or the issue; repository documentation holds maintained contracts only.

## Before implementation

Describe one observable Given/When/Then scenario and its relevant failure state.
Name the invariant and its single authoritative owner. Identify authoritative
state separately from cached projections, transport receipts, and delivery intent.
Describe each changed interface: caller intent, input, result, failure semantics,
retry/idempotency, and any freshness requirements. Inspect actual callers and the
counterparty implementation before assuming their contracts match.

Count the primary concepts a maintainer must understand together, not DTOs,
methods, fields, files, or agents. The local review budget is seven concepts per
bounded context and three required semantic relationship hops per scenario.
An SDK call that hides cryptography does not require understanding its internals;
a call that requires choosing certificate order and JSON defaults still exposes
that knowledge. Simplify or hide coherent implementation first. If the budget
remains exceeded, explain why and what the maintainer must retain. Do not split
classes or add forwarding interfaces to make the numbers smaller.

These budgets are engineering conventions, not cognitive-science measurements.
Memory experiments study chunks shaped by knowledge and task conditions, not
method counts: [Miller, 1956](https://cse.buffalo.edu/~rapaport/575/F01/miller56.html),
[Cowan, 2001](https://pubmed.ncbi.nlm.nih.gov/11515286/).

## Choose proof for the actual boundary

- Dependency directions and public entry points: executable static rules with
  forbidden and allowed import fixtures. Include helper-mediated and dynamic
  dependencies when the rule claims to cover them. Account for type-only imports.
- Wire contracts: actual SDK client against the actual server, including omitted
  optional/default fields and delegated credentials where relevant. Mocks may
  test failure handling but cannot prove cross-language compatibility.
- Durable operations: commit the domain fact and delivery intent atomically, or
  make pending work derivable from authoritative facts. Test the relevant crash
  window and retry, rather than only a network failure after the journal exists.
- Independent rules: verify the operation without an unrelated subsystem. For
  example, publishing an Identity revocation must not require a private replica.
- Performance contracts: unchanged reads must not repeatedly publish authority
  updates. Verify observable network effects where a read adapter performs writes.

## Review the resulting change

Compare the final diff with the proposed ownership; inspect all affected callers.
Look for protocol assembly moved into UI/controller code, duplicated authoritative
state, hidden ordering requirements, and incomplete failure handling. Additional
agents or layers do not establish boundaries by themselves.

Separate findings: missing scenario behavior, concrete implementation/protocol
bug, ownership violation, and hypothesis needing execution evidence. A failed
request is not automatically a DDD violation. Static checks cannot determine
whether two domain rules mean the same thing or whether a module hides enough
knowledge; use source review and acceptance evidence for those judgments.
