# Headless reaction runtime

`Dockerfile` builds the Node runner and shared participant worker from the
repository lockfiles and a digest-pinned Node 24 base image. The image has no HTTP listener. Mount the immutable
reaction at `/reaction/source.ts` read-only, participant journal at `/state`, and
send one UTF-8 JSON request on stdin. Runner writes one bounded JSON response to
stdout. The process runs as UID 1000. Its executable paths are
`/usr/local/bin/node` and `/usr/bin/flock`; wrap every run in
`flock --nonblock --no-fork /state/executor.lock` to retain the executor's existing
single-writer lock.

The request is version 1 and contains `runId`, `sourceDigest` (lowercase SHA-256
of the mounted source), `signals`, optional stored `classification`,
`participant: { integrationId, epoch }`, and
`capabilities: { operations, targets }`. Reaction source is a self-contained
TypeScript module with a default async function `(input, participant)`. Imports,
`process`, and `require` are rejected. The `participant` port exposes the shared
Tincanban command receipt methods and the existing
`classifyApplicationEvent` / `classifyOpportunity` functions. Those classifiers
use the existing CLEF questions and decision validation. CLEF access requires
`clef.application-event` or `clef.opportunity` in the granted operations and a
read-only `/run/secrets/reaction.json` containing exactly
`CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`. The credential is read only
when classification capability is granted and never enters reaction input or
output. Approved participant operations come from the input capability list. A command ID is
derived from the run, source digest, call order and command JSON, so a retry
reuses the same durable command. A result is `completed` only after the shared
participant reports its change hash and Rusty storage receipt; otherwise it is
`pending`.

The runner reads a readonly `/run/secrets/reaction.json` file containing the
existing participant storage secrets/configuration, scoped CLEF credentials, and
server-derived `REACTION_RUSTY_ORIGINS`. It refuses networked capabilities unless
`REACTION_RUSTY_PROXY` is exactly `http://reaction-egress-proxy:3128`. The
`proxy.Dockerfile` image runs the bundled CONNECT proxy on port 3128; it accepts
only TCP 443 to exact configured Rusty HTTPS origins and `api.cloudflare.com`,
and refuses DNS answers in private or reserved ranges. It has no CA overrides or
service credentials.

Place runner on a per-run internal Docker bridge. Place the proxy on that private
bridge and a separate egress network; never attach runner to the proxy's egress
network. Do not give runner a Docker socket, workspace mounts or arbitrary network
access. Run both images read-only except the runner's existing `/state` journal
and bounded `/tmp`; drop Linux capabilities and set no-new-privileges. Configure
the proxy's `REACTION_RUSTY_ORIGINS` from the already authorized participant state,
never from reaction input. Each run serializes access with the existing
`/state/executor.lock`.

`defaultReaction.ts` implements the current homepage website intake: it calls the
existing CLEF opportunity classifier and submits a normalized website event and
classification to the shared scoped item-command queue. The coordinator retains
the existing confidence, board-scope, signed-write, and Rusty receipt checks.
The runtime's SQLite `reaction_journal` retains first CLEF evidence and exact
command JSON before retryable calls; retries therefore reuse the same evidence,
command ID, and command bytes.
