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
fences its old writer and returns a bounded inventory of the existing approved
actor: identity, registration, replica/chunks and storage/history transitions.
Old letters, event queues, source bindings and request nonce ledgers are excluded.
The workflow transfers encrypted pages sequentially into the executor's durable journal. Repeating the
same import retries those exact pages idempotently; a failed page stops transfer
without activating either participant. Progress output contains counts, not mail,
page contents or credentials. A frozen participant remains inactive until the
separate activation step succeeds.
Failures include HTTP status and a bounded structured service `error` reason;
unrelated JSON fields, raw page bodies and gateway HTML are omitted.

Run `activate` with the same integration and epoch. Node validates the complete
import and existing authority before becoming active. Its activation body contains
only the exact `epoch` and `manifestHash`.
Only after Node confirms that exact manifest is active does the workflow ask
intake to acknowledge its new route. A failed acknowledgement can retry activation
idempotently. Intake independently checks the active
executor before recording its acknowledgement.

## Verification status

Executor release CI run `38940879267` passed image acceptance and deployment.
Production `/health` confirmed `ready`, source
`547ca3d43f78665e561e9b737380b063664a7191`, SDK
`9d92a478495b471bf6a8075dcf23e77b412473cc` and runtime artifact
`39a518987a9f984d7298b8353a29550ae4579307d335c2acdc49c50b2540981c`.
The deployment receipt binds the exact checked config bytes to registry manifest
`sha256:62de14ab9bd3b9c3c5273eecf98a4fe003fc7e4f27d80680002e2fc367bf617c`,
including Docker 29's sparse containerd export.

The narrowed participant-only transfer is a subsequent source change awaiting
its CI release. Existing integration cutover, Cloudflare key cleanup and a real
received-event result remain unverified. Process readiness and image identity do
not establish that production automation works.
