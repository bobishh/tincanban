# Browser diagnostics

Browser diagnostics export optional OpenTelemetry logs and traces through the
configured TinSink intake. They do not block board writes or authentication.
Local diagnostic snapshots remain available when export is disabled.

## Configure export

Set the public frontend build values documented in [.env.example](../.env.example):
intake URL, project, browser write key, level, sample rate, and batch size. Both
the URL and key are required to send. These values become public browser assets;
use `.env` locally or Cloudflare build variables for production. Never put backend
or desktop write keys here. TinSink checks project, source, origin, and quota,
then forwards to its private collector and ClickHouse tables. Its existing log
view can read both legacy diagnostic rows and the newer OTel tables.

In the app, **Settings → Workspace → Diagnostics** offers **Send diagnostics
from this device** when an endpoint is configured. Consent applies to this
browser across workspaces and survives reload. Legacy local collector URLs and
keys are ignored; an explicit legacy opt-out remains effective. **Diagnostic
delivery** shows queued or dropped events, the last confirmed send, and errors.

## Connection incidents

With configured export and device consent, connection warnings and node/session
start, close, and recovery events are sent automatically. Verbose packet logging
is not required. Automatic mesh export is bounded to 120 records per minute per
page; after a limit is reached, the next reporting window includes a suppressed
record count. The local buffer still retains the latest 500 mesh events.

Correlation attributes include available workspace, device, peer instance, tab,
runtime and run IDs, connection direction, and close cause. Upstream events may
supply shortened IDs; these cannot establish an exact cross-session match.
Explicit verbose tracing also exports packet-level events and is intended for
short, deliberate investigations. Turning device consent off stops both modes.

## Data and evidence

Exception type, message, stack, and causes are bounded and credential-redacted.
Board and card contents, files, request bodies, and signing credentials are not
diagnostic attributes. IDs are bounded; numeric attributes retain numeric types.
Related operation spans use W3C Trace Context.

The collector must implement the
[standard observability contract](../openspec/changes/standard-observability/specs/diagnostic-delivery/spec.md).
Source implementation and focused tests do not establish full-chain acceptance
or production delivery. The
[execution record](../openspec/changes/standard-observability/README.md) tracks
the independent producer, collector, and production evidence. Export failure
does not block board writes, authentication, or product deployment.
