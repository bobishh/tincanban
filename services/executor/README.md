# tincanban executor

Authorized TypeScript automation participant. Rusty remains blind encrypted
storage. The executor opens admitted workspace replicas and runs the existing
shared automation coordinator; Cloudflare intake forwards requests to it and
retains CLEF classification. This service adds no browser storage API or separate
implementation of workspace authorization.

`src/main.ts` hosts authenticated HTTP routing and a bounded worker manager.
`src/participantWorker.ts` runs one integration's shared coordinator with durable
SQLite state. At most one participant worker is active; eviction releases its
WASM memory while retained state survives in `/data`. The container holds an OS
file lock for its entire lifetime, so two processes cannot write that volume.

## Component release

The manually dispatched **Release tincanban executor** workflow releases only this
service from `main`. It does not deploy or restart the frontend, Cloudflare intake,
Rusty, TinSink, or platform accessories. Their APIs and releases remain independent.
The initial executor release must precede intake routing activation; the migration
fence prevents old and new participants from processing the same integration.

CI builds a Node 24 image, runs its acceptance tests, and saves that exact checked
image as an artifact. Deployment loads the saved image without rebuilding it,
publishes an immutable image tag to `ghcr.io/bobishh/tincanban-executor`, and uses
the existing Kamal configuration captured by `deployment-config.json`. Image,
source, SDK and runtime-byte evidence are checked against the live service.
SDK identity records the artifact's dependency; it does not require other
independently deployed services to run the same revision.

The existing `tincanban_executor_data:/data` volume persists SQLite state across
releases. Deployment records the current executor container before stopping it,
then starts the replacement. Failed activation stops the failed executor and
restores the captured previous executor. It never operates on another service's
containers or volumes. A brief executor interruption is expected during handoff;
accepted durable requests remain in its journal.

## Deployment environment

GitHub environment **production-executor** contains:

| Setting | Kind | Purpose |
| --- | --- | --- |
| `EXECUTOR_HOST` | Variable | Existing production host IP or hostname |
| `EXECUTOR_SSH_PRIVATE_KEY` | Secret | Key authorized for this service's host deployment |
| `EXECUTOR_SSH_KNOWN_HOSTS` | Secret | Pinned host SSH keys; no trust-on-first-use |
| `EXECUTOR_RUNTIME_ENV` | Secret | JSON object whose values are strings, using only the keys below |

The repository's Actions token publishes its own executor package. It needs Write
access to that package; no Rusty or TinSink package permission is needed.

`EXECUTOR_RUNTIME_ENV` allows `EXECUTOR_SERVICE_TOKEN`,
`EXECUTOR_MIGRATION_SECRET`, `CLASSIFICATION_SERVICE_TOKEN`,
`IDENTITY_STORAGE_SECRET`, `EVENT_STORAGE_SECRET`, `INTEGRATIONS_JSON`,
`EMAIL_ROUTES_JSON`, `EXECUTOR_PRODUCERS_JSON`, and `TELEMETRY_TOKEN`.
`EMAIL_ROUTES_JSON` and `TELEMETRY_TOKEN` can be omitted. JSON configuration values must themselves be JSON
strings in this envelope. Values are passed through a fixed environment allowlist;
they are never evaluated or sourced as shell code. `.kamal/secrets` contains only
controlled variable references, and private deployment files are removed afterward.
Identity and event-storage keys must preserve the existing integration's keys
during migration; replacing them would make saved secrets unreadable.
When the runtime envelope omits `TELEMETRY_TOKEN`, the executor deployment uses
the repository's existing `AUTOMATION_TELEMETRY_TOKEN` secret for the same TinSink
automation tenant. Individual secret values are masked before deployment output.

Non-secret runtime settings live in the pinned infrastructure configuration:
`EXECUTOR_PUBLIC_ORIGIN`, `AUTOMATION_ORIGIN`, `EXECUTOR_DATA_DIR`,
`EXECUTOR_ARTIFACT_PATH`, `PORT`, `SERVICE_NAME` and
`OTEL_EXPORTER_OTLP_ENDPOINT`. The executor reports
`service.name=tincanban-executor`; TinSink's existing automation tenant and server
authentication remain unchanged. No Grafana instance is required to export data.

`GET /health` exposes component, source revision, SDK revision and the combined
SHA-256 of `main.mjs` and `participantWorker.mjs`, verified at startup. Runtime
files are sorted by name; the combined hash includes each name, a NUL separator,
its bytes, and another NUL separator. It reports readiness of this host process;
an integration's admission, migration and execution state is queried separately.

## Participant migration

The manually dispatched **Migrate tincanban executor participant** workflow uses
only the authenticated intake and executor APIs. It has no Cloudflare control-plane
token, SSH key, registry permission or Rusty storage credential. Its concurrency
group prevents overlap with an executor deployment.

Run `import` with the exact integration and migration epoch. The intake durably
fences its old writer and returns a bounded inventory. The workflow transfers
encrypted pages sequentially into the executor's durable journal. Repeating the
same import retries those exact pages idempotently; a failed page stops transfer
without activating either participant. Progress output contains counts, not mail,
page contents or credentials. A frozen participant remains inactive until the
separate activation step succeeds.

Inspect retained pending events through the executor's private review API before
activation. Supply `manual_resolutions` as an explicit JSON array of exact event
IDs, reasons, and optional existing item IDs for work already handled manually.
The CLI contains no product-specific event or card IDs and never prints that
review response. Empty `[]` explicitly means no manual resolutions.

Run `activate` with the same integration and epoch. Node validates the complete
import, existing authority and manual-resolution guards before becoming active.
Only after Node confirms that exact manifest is active does the workflow ask
intake to acknowledge its new route. A failed acknowledgement can retry activation
without replaying migration resolutions. Intake independently checks the active
executor before recording its acknowledgement.

## Verification status

The packaged Node participant, persistence, HTTP and migration acceptance tests
passed the executor image job in CI run `38939867314`. Activation failed while
checking Docker 29's sparse image export; the receipt adapter correction still
needs its next CI run. No production migration or real received-event result has
been verified. Image checks alone do not establish that automation works.
