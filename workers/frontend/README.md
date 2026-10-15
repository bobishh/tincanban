# Frontend release

Acceptance: Given a push to main, when **every Verify job** succeeds, stage that
run's sealed frontend and compiled automation artifacts with the exact successful
Rusty image artifact. Confirm Rusty, then automation, then frontend. A failed,
cancelled, PR, manual Verify, or superseded run cannot activate production.

`ci.yml` builds with production telemetry variables, captures a sealed frontend
including retained chunks and a compiled no-bundle automation package. Automation
runtime checks target that captured package. Rusty CI captures the executable
from the pushed immutable image. `release/contract.json` declares reader floors,
writer version, required capabilities and migration identifiers. The coordinator
rejects source/SDK mismatches, altered bytes and extra unsealed modules.
`deploy-frontend.yml` stages and deploys these captured artifacts without rebuilding.
Its concurrency prevents overlapping production mutations.
Publishing uses the version ID from that upload's structured Wrangler output.
Release tags may repeat after a manual publish or retry; tag lookup cannot select
the uploaded artifact unambiguously.

Set optional GitHub repository variables `VITE_SYNC_TELEMETRY_URL` and
`VITE_SYNC_TELEMETRY_BROWSER_KEY` to enable production telemetry; unset URL keeps
telemetry disabled. Project defaults to `tincanban`; level, sample rate, batch size
can also be set through same-named variables. These values are public browser
configuration. Never place board keys or Rusty operator credentials here.

`CLOUDFLARE_API_TOKEN` must stage/deploy both existing Workers. The native transport
requires `RUSTY_DEPLOY_SPEC`, a repository variable describing the existing host:
`{"kind":"ssh-compose","target":"deploy@host","directory":"/srv/existing-project","composeFile":"compose.yaml","project":"existing-project","service":"rusty","origin":"https://rusty.example"}`.
Use actual existing project/service/volume configuration. `RUSTY_DEPLOY_SSH_KEY`
and `RUSTY_DEPLOY_KNOWN_HOSTS` are repository secrets. The adapter only overrides
the image by digest and updates that service without dependencies; it does not
change volume configuration or delete storage. These production settings have
not been established or verified by the current source implementation.

The release manifest records the checked build. Before publishing, the adapter
retains fingerprinted chunks from previous builds, checks their SHA-256, and
records them separately with a seven-day expiry. Later deployments preserve that
expiry rather than dropping chunks after one generation or extending it forever. The
bootstrap manifest contains public hashes from the pre-CI production release.
Old HTML never replaces new HTML. Older tabs may eventually need reload; browser
board data stays on the same origin.

Production verification requires actual artifact identities, provider version IDs,
SDK, reader floors, Rusty capabilities and served frontend file hashes. The native
identity is the SHA-256 of the running executable, not merely its source tag.
Staged/result activation journals preserve the exact cohort and version IDs after
failure. A release is active only after every component confirms. Failure does
not clear data or automatically activate an incompatible rollback reader.

`/release-cohort.json` returns a no-store public projection. A browser checks on
focus and periodically, identifies a stale tab and blocks verified writes when
its reader/writer contract is too old. Its acknowledgement applies to that tab;
it is not proof that an offline phone upgraded. Tabs predating this monitor need
reload; server writer floors remain the enforcement boundary for those clients.

`Recover compatible production cohort` is the explicit CI recovery path. Select
`resume` with the original activation run ID and attempt: the workflow recovers
its exact archived bundles and UUIDs, confirms uncertain stages, stages only
missing Worker versions, and resumes server-first activation. Archives retain
all sealed component bytes, not just source identifiers. Recovery refuses a
stale activation after a different production cohort becomes active.

Select `rollback` with that current run plus a previously confirmed target run
and attempt. The selector rejects readers, writers or declared capabilities below
current retained floors. It preserves those floors and migration identifiers.
The old UI entry point is composed with hash-checked current-tab chunks; existing
retention expiries never extend. The derived frontend is resealed with both parent
artifact digests. Captured rollback bundles are uploaded without rebuilding to
bind the new cohort metadata, with original provider UUIDs retained as provenance.
Never activate a prior frontend UUID directly: it omits newer tabs' chunks.

Artifacts and recovery journals remain available for fourteen days. Exact run
attempts prevent mixed frontend/Worker bundles after CI reruns; rerun all Verify
jobs when a new attempt needs a complete cohort. Expired/missing archives require
a new checked forward release, never a mutable-tag lookup or deletion of local
state. A first schema migration may legitimately have no compatible prior rollback
reader; the selected checked release remains the forward recovery artifact.

Local verification:

```sh
npm ci --prefix workers/frontend
npm test --prefix workers/frontend
workers/frontend/node_modules/.bin/wrangler versions upload --config workers/frontend/wrangler.jsonc --dry-run
```

Activate by committing/pushing these workflow and adapter files to main. The
first actual GitHub run proves secret permissions and the production deployment;
local tests and a dry run do not prove these.

Current source, authored acceptance cases, and CI definitions remain unverified
until the owner's final verification/release gate. No CI workflow was started by
authoring these files.
