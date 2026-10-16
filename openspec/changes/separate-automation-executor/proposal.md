# Separate automation executor

## Why

Production automation currently materializes and admits complete Automerge history
inside a Cloudflare Durable Object. On 2026-10-16 the platform reported
`Durable Object's isolate exceeded its memory limit and was reset` during instance
identity management. Subsequent calls reported `Module terminated`. The reset is
confirmed; the exception's reporting frame does not identify the allocation that
exhausted memory. Moving the same unbounded workload to another isolate is not a fix.

The owner requested a separate executor, while keeping Rusty blind, reusing the
existing participant/protocol implementation and adding an items command API.
This supersedes the Cloudflare-as-executor and no-new-runtime clauses of
`independent-platform-boundaries`; its independent-release and compatible-API
requirements still apply.

## What changes

- Cloudflare owns external form/email intake and CLEF classification into bounded
  commands. It no longer opens private board CRDT or holds board reading/signing keys
  after verified migration.
- A separate executor service hosts the existing authorized participant through
  platform adapters. It owns a private durable job journal, its own automation
  identity, owner-approved board keys and scoped grants.
- Reuse mesh identity, cryptography, admission, history, replication and receipts
  from meta-mesh. Reuse application commands and automation processing; extract
  ports where required rather than copy implementations or translate policy to a
  second language.
- Provide an authenticated items command API, shared by form/email producers.
  Requests propose item creation/update/workflow operations, never arbitrary CRDT
  bytes or unrestricted document replacement.
- Preserve existing management URLs, identities, grants, queued decisions and
  exact pending writes during an authenticated, single-writer cutover.
- Release intake and executor independently through component-owned CI. Rusty and
  TinSink are not rebuilt/restarted by either deployment.

## Scope limits

Rusty remains encrypted storage and receipt/publication service: no private board
keys, CLEF, item API or CRDT authoring. Universal Inbox remains specification only.
No new authorization role, global deployment orchestrator, API version bump or
replacement board database is required. An executor's private CRDT replica is a
participant cache, not another source of truth.

## Acceptance

Finish with an actual production intake command, an admitted signed item change,
a verified durable Rusty receipt and the corresponding board result. CI alone is
not production acceptance. Tesla items already created by the owner and Amazon's
manual workflow move must remain intact; old messages must not replay these actions.
