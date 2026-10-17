## Why

Cards currently expose an automation JSON envelope as “Source snapshot”, while job-search code assumes field meanings outside board configuration. The same board schema must define card creation, editing, reading and publication without a job-specific runtime.

## What Changes

- Remove preset-specific card/detail/form rendering and hidden source-envelope readers/writers.
- Put template defaults and presentation bindings in board configuration; runtime consumes generic field IDs and types.
- Treat text as literal text. JSON, Markdown and code formatting require explicit field configuration and never execute code.
- Use generic configured priority rules, not a built-in vacancy assessment parser.
- Preserve existing values without migration, rewriting, JSON inference or synthesized configuration.
- Apply changes through CI and verify production deployment.

## Capabilities

### New Capabilities
- `schema-driven-card-fields`: One configurable card surface, typed text formats and ordinary source text.

### Modified Capabilities
- `workspace-creation-config`: Persist presentation and text-format settings through the existing configuration flow.

## Impact

Board schemas/configuration, private/public cards and forms, automation field writes, priority evaluation, legacy job presentation/state APIs, tests and documentation. Remove the jobs creation template and its selection UI entirely. Historical test fixtures are not production templates.
