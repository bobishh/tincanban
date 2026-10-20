# Workspace kernel and scoped sync

Status: specification complete; implementation not started by this change.

## Start here

1. Read [proposal](proposal.md) for scope and exclusions.
2. Read [model contract](contracts/model.ts) and [command/migration contract](contracts/commands.md) before editing runtime types.
3. Read [design](design.md) for resolved choices: separate documents, placement, archiving, native history, identity, and two sync flows.
4. Implement [tasks](tasks.md) in order. Gate A must support a second local workflow before collaboration UI is enabled.
5. Use the capability scenarios as acceptance criteria, not inspiration for another design.

## Capability map

| Question | Normative spec |
| --- | --- |
| What data exists and what does delete mean? | [Workspace model](specs/workspace-model/spec.md) |
| How are edits saved, merged, and attributed? | [Transactions](specs/workspace-transactions/spec.md) |
| What happens to today's files and IDs? | [Portability](specs/workspace-portability/spec.md) |
| Who is a person/device/member? | [Identity](specs/personal-identity/spec.md) |
| What does each QR link permit and transfer? | [Scoped sync](specs/scoped-sync/spec.md) |
| Which visible behavior must work? | [Native UI](specs/generic-workspace-ui/spec.md) |

The [Reading fixture](examples/reading-workspace.ts) demonstrates a second domain using the same model. It is a compile-checked shape example, not an authenticated bundle or seeded runtime.

Declarative UI remains outside this change. See the separate [research note](../../research/declarative-ui-options.md); no renderer dependency or DSL implementation is authorized by this specification.

Planning validation:

```sh
openspec validate workspace-kernel-and-scoped-sync --strict --no-interactive
```

Runtime acceptance requires the tests in `tasks.md`; OpenSpec validation alone does not mean the feature works.
