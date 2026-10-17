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

`defaultReaction.ts` classifies homepage submissions and submits scoped item
commands. A command is completed only after its signed change and Rusty receipt
are confirmed. Retries retain the original classification evidence, command ID
and bytes.

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
