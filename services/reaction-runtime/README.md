# Reflux reaction engine

Tincanban sends HTTP requests to Reflux. Reflux selects the existing reaction,
verifies the service route, and runs the shared participant engine. Owner and
instance signatures retain their original public origin and signed bytes.

This image contains `/reaction/engine.mjs`, a portable domain module. It has no
HTTP listener, database driver, writable state volume, scheduler, or standalone
service. Reflux supplies the readonly source, secrets and Node host, serializes
participant operations, and persists identity, replica, command receipts and
unconfirmed uploads in the reaction's PostgreSQL state. The same encrypted
identity and exact pending commands survive process exit and deployment.

The **Job search automation** reflex has its own workflow, rules and run history
in Reflux. Website submissions and retained email are its inputs. It references
the existing participant for identity, grants, sync state and pending commands;
creating the reflex does not create another participant or copy keys. Reflux owns
the production rules in `priv/reactions/job_search/reaction.ts`; source activation
is separate from publishing this image.

`defaultReaction.ts` illustrates classification and scoped item commands through
the shared automation pipeline. Forwarding
confirmations and conditional reminders remain review events without AI. Email
classification uses the same durable CLEF journal as other reactions; queued
commands retain the original event and raw MIME. Input and command envelopes are
bounded at 2 MiB to carry the maximum 1 MiB raw message in base64url, while source,
AI, result and output JSON remain bounded at 1 MiB. A command is completed only
after its signed change and Rusty receipt are confirmed. Retries retain the
original classification evidence, command ID and bytes.

Email vacancy pages are fetched only when Reflux grants the reaction the
`job-page-fetch` operation for source-retained URLs. Reflux limits that grant to
three public HTTPS DNS hosts and scopes proxy access to those hosts. The shared
extractor also enforces public-address checks, redirect limits, an 8-second
timeout and a 1 MiB response-body limit; failed or ungranted fetches leave the
email in review without vacancy evidence.

Reflux owns the runtime binding and state lifecycle. The one-time legacy import
runs offline in Reflux; neither this engine nor Tincanban connects to PostgreSQL.
Build and verify with `node services/reaction-runtime/build.mjs`, then
`node --test services/reaction-runtime/dist/test/*.test.mjs
services/reaction-runtime/architecture.test.mjs`.

The enforcing CONNECT proxy permits HTTPS only to the bound Rusty origins and
`api.cloudflare.com`, rejecting private addresses. Reflux starts the engine on a
per-run internal network, mounts only readonly source/secrets/host, drops Linux
capabilities, and provides bounded temporary storage. No Docker socket or
workspace is exposed to the engine.
