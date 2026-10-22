# Frontend release

Frontend and automation are separate Cloudflare services with independent
deployment workflows. Rusty has its own repository and release path. A successful
frontend release deploys and verifies the frontend only; it does not stage or
activate automation or Rusty.

## Build and deploy

The `Verify` workflow builds and seals frontend and automation artifacts from the
same successful main-branch run. Each artifact records its component, source
commit, run attempt, reader floors, writer version and file digests. A component's
upload attempt can precede the overall successful run attempt when only failed
jobs were rerun. Deployment selects the artifact uploaded during that component's
successful producer execution, then verifies its exact seal. The
`Deploy tincanban frontend` workflow downloads the exact frontend artifact,
checks its seal and current frontend compatibility floors, then stages and
activates that frontend version. It confirms the active version, frontend
compatibility metadata and served file bytes. The automation deploy workflow
consumes and deploys only its own artifact. Rusty is verified and released by its
own pipeline.

The frontend publishes its own reader/writer compatibility metadata at
`/release-cohort.json`; the compatibility identifier describes this frontend
artifact only. It is not evidence of a synchronized frontend/automation/Rusty
release. The client checks this metadata to identify stale tabs and block writes
that violate the frontend's declared reader/writer contract. This check is
per-tab and cannot confirm an offline device upgraded. Server writer floors
remain authoritative for older clients.

The frontend deploy workflow uses the Cloudflare API token in its production
environment. It does not need Rusty host credentials or automation deployment
secrets. Optional GitHub variables `VITE_SYNC_TELEMETRY_URL` and
`VITE_SYNC_TELEMETRY_BROWSER_KEY` configure browser diagnostics; these are public
browser settings, never board keys or Rusty credentials. Optional GitHub variable
`VITE_IDENTITY_ORIGIN` configures the Identity portal link at frontend build time;
it defaults to empty. Project defaults to
`tincanban`; level, sample rate and batch size use same-named variables.

## Existing browser tabs

The checked release manifest retains fingerprinted JavaScript, CSS and WASM chunks
from the previous frontend for up to seven days. Retained files keep their existing
expiry across subsequent builds; the process does not extend old chunk lifetime.
The release verifier checks their hashes and confirms the active frontend serves
the exact sealed artifact. HTML is served without cache. Older tabs may need a
reload; board data remains on the same origin.

## Recovery

`Recover one tincanban component` restores either frontend or automation from an
exact successful main `Verify` run and attempt. Recovery activates only the chosen
component. Frontend rollback composes the selected checked frontend with verified
chunks from the currently active frontend, preserving each chunk's expiry; it
does not roll back directly to an old frontend version that may lack chunks used
by open tabs. Active reader floors still constrain rollback. Missing or expired
artifacts require a new checked forward release.

## Local verification

```sh
npm ci --prefix workers/frontend
npm test --prefix workers/frontend
workers/frontend/node_modules/.bin/wrangler versions upload --config workers/frontend/wrangler.jsonc --dry-run
```

Tests and a dry run do not deploy or prove the production version. Production
evidence comes from the frontend deployment workflow's artifact, provider
version, health and served-byte checks. No deployment was started by authoring
this guide.
