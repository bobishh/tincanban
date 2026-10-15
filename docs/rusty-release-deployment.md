# Rusty release deployment

Rusty deployment uses the existing `hetzner_playground` Kamal service config. The
adapter takes the sealed GHCR digest, assigns a cohort-specific tag to that same
manifest without rebuilding it, checks the tag still resolves to the sealed
digest, then runs Kamal with `--skip-push`. Kamal continues to own the existing
proxy, service environment, ClickHouse accessory, and named storage volume. The
release coordinator checks the running image's registry digest and then verifies
Rusty's reported source commit and executable SHA-256 before activating Workers.

Before staging or activating production, CI requires a successful main verification
run for the cohort's exact SDK commit and retains its repository, commit and run
ID with the activation artifacts. Rusty's image is separately selected from the
exact successful main run for the pinned service commit.

The repository workflow requires these external settings:

- `RUSTY_DEPLOY_SPEC` repository variable: JSON with `kind: "kamal"`,
  `directory: ".release-config/hetzner_playground"`, the pinned 40-character
  `configSha`, `configFile: "config/deploy.mesh-lighthouse.yml"`, the exact
  `server` host, and public Rusty `origin`.
- The existing public Tangled repository and exact infrastructure commit are
  captured in [`release/rusty-deployment-config.json`](../release/rusty-deployment-config.json).
  Both activation and recovery fetch that commit over HTTPS into
  `.release-config/hetzner_playground`, independently verify its commit ID, and
  refuse an existing checkout or a different `RUSTY_DEPLOY_SPEC.configSha`.
  No GitHub config repository or config access token is required. Keep this
  checkout outside `.release/`, which stores release artifacts and activation evidence.
- The workflow installs Ruby 3.4.7 and Kamal 2.10.1. It supplies `SERVER_IP`
  from the pinned deployment spec and `DOCKER_REGISTRY_USERNAME` from the GitHub
  repository owner. Set the `RUSTY_TRUSTED_OWNER` secret for the host runtime.
- Existing `RUSTY_DEPLOY_SSH_KEY` and `RUSTY_DEPLOY_KNOWN_HOSTS` secrets, plus
  `RUSTY_TELEMETRY_TOKEN` and `CLICKHOUSE_PASSWORD` secrets. The workflow writes
  only the latter two into a mode-0600 `.kamal/secrets` file in the private
  checkout; values are not expanded as shell syntax or logged. Do not print or
  commit them.
- A job-scoped GitHub token with `packages: write` for publishing the unique
  cohort tag and `packages: read` for the host pull, with this repository granted
  access to the Rusty package. The adapter also needs the runner actor name for
  GHCR login.

The cohort tag is a transport requirement of Kamal's `image:version` addressing;
the release is accepted only when that tag and the running container resolve back
to the sealed digest. A tag collision or registry race with another digest fails
closed. No successful production rollout is implied by this configuration source.
