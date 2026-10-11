# Frontend release

Acceptance: Given a push to main, when **every Verify job** succeeds, then deploy
that run's checked frontend artifact to `match.meta-uber-engineer.dev`. A failed,
cancelled, PR, manual Verify, or superseded run cannot publish.

`ci.yml` builds once with the production telemetry repository variables, checks
size and audit, seals SHA/file checksums, and uploads the build. The separate
`deploy-frontend.yml` downloads only that trusted main run's artifact, checks
checksums, and deploys with pinned Wrangler. Its concurrency prevents overlapping
production deployments. Verify's cancellation cannot interrupt this workflow.
Publishing uses the version ID from that upload's structured Wrangler output.
Release tags may repeat after a manual publish or retry; tag lookup cannot select
the uploaded artifact unambiguously.

Set optional GitHub repository variables `VITE_SYNC_TELEMETRY_URL` and
`VITE_SYNC_TELEMETRY_BROWSER_KEY` to enable production telemetry; unset URL keeps
telemetry disabled. Project defaults to `tincanban`; level, sample rate, batch size
can also be set through same-named variables. These values are public browser
configuration. Never place board keys or Rusty operator credentials here.

`CLOUDFLARE_API_TOKEN` is a repository secret limited to editing the existing
`meta-frontend-tincanban` Worker. Rotate before 2027-01-07 23:59:59 UTC. Versions
upload/deploy preserve the existing Custom Domain; this config deliberately owns
no DNS or routes. Rusty and automation are separate releases.

The release manifest records the checked build. Before publishing, the adapter
retains fingerprinted chunks from previous builds, checks their SHA-256, and
records them separately with a seven-day expiry. Later deployments preserve that
expiry rather than dropping chunks after one generation or extending it forever. The
bootstrap manifest contains public hashes from the pre-CI production release.
Old HTML never replaces new HTML. Older tabs may eventually need reload; browser
board data stays on the same origin.

Production verification checks `/health`, `/`, `/pair`, the entry JavaScript,
and missing-asset 404, including the exact release SHA. Failure marks deployment
red; it does not automatically roll back or alter browser data.

Local verification:

```sh
npm ci --prefix workers/frontend
npm test --prefix workers/frontend
workers/frontend/node_modules/.bin/wrangler versions upload --config workers/frontend/wrangler.jsonc --dry-run
```

Activate by committing/pushing these workflow and adapter files to main. The
first actual GitHub run proves secret permissions and the production deployment;
local tests and a dry run do not prove these.

Production currently contains the uncommitted blind Rusty client. Deployment
refuses a source revision without `src/sync/blindClient.ts` and
`src/components/RustyPanel.vue`, preventing main from replacing it with the old
readable-keeper client. Land the compatible client before the first release.
