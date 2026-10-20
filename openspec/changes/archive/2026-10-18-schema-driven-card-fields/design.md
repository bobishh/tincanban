## Context

A text field currently stores JSON.stringify({eventId, message, sourceText, decision}); frontend priority and matching code parse that undocumented envelope. Separate Lead views hard-code company/role/fit and ignore arbitrary configured fields.

## Decisions

1. Render and edit cards using generic board fields on private and public routes. No runtime branch on a job-search preset, no inferred schema from field labels or text contents.
2. Board presentation explicitly references title fields, narrative field and summary fields. Defaults are a normal title/body and configured fields. Templates provide configuration only.
3. Text formats are optional schema metadata: plain (default), markdown, json or code. All retain string storage; JSON validation applies only to explicitly declared JSON. Code remains inert.
4. Stop writing and parsing source envelopes. Automation writes the supplied source text unchanged to the configured text field; provenance remains in existing typed application records/journal, not card text.
5. Remove frontend vacancy-specific priority logic. Supported priority rules operate on configured field values; unsupported stored evaluators do not reinterpret text or overwrite saved values.
6. No migrations, inferred metadata, compatibility JSON parsing or changes to existing card values. Keep storage readable and expose ordinary text literally.

## Verification

Outside-in scenarios precede implementation: create/edit/reload arbitrary text (including JSON-looking content), explicit formats and invalid JSON retry, schema rename/removal, and private/public consistency. Focused unit tests prove schema roundtrip and no hidden assessment parsing. Required quality, size and CI checks gate deployment.
