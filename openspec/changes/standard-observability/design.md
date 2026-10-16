# Design

## Evidence and boundaries

- TinSink persists diagnostic events in `telemetry.events`; current attrs have a
  fixed allowlist without exception messages or stacks.
- Browser `failureDiagnostic.ts` previously classified ordinary JavaScript and
  WASM failures as unknown. `meshTrace` also overwrote a supplied detail error with
  an absent fourth argument. Both lose useful evidence before transmission.
- Existing ClickHouse is private on the Kamal network. No Grafana installation
  for tincanban is established. An old cultiwars Alloy configuration is unrelated.
- `Module terminated` comes from Automerge's generated WASM guard after an earlier
  exception marked that instance terminated. The guard alone does not establish
  memory exhaustion, corrupt data, a Rust panic, or an application lifetime bug.

## Producer contract

Use maintained official OpenTelemetry APIs/SDKs and OTLP exporters. Do not write a
private replacement span/log format or use entity hashes as trace IDs. Resource
attributes identify service, source revision and deployment. Logs and operation
spans carry workspace/entity identifiers as bounded attributes when available.
Use W3C Trace Context for related HTTP operations; unrelated background attempts
receive distinct operation traces. Do not instrument exporter requests recursively.

Retain `exception.type`, `exception.message`, `exception.stacktrace` and bounded
cause-chain information. Capture the first exception at its original operation
boundary, before later `Module terminated` failures obscure it. Mask credentials,
authorization headers, tokens and private key material; do not blanket-delete
messages or stacks. Never include board bodies, file bytes, encrypted snapshots,
request bodies or signing credentials merely to provide context. Existing browser
diagnostic consent remains effective, including stopping queued exports on opt-out.

Operation scopes distinguish local admission/serialization, transport, HTTP,
decrypt/merge and confirmation. Error logs preserve the operation and exception;
span status is Error. Browser global error/unhandled-rejection handlers capture
uncaught failures, without replacing existing application handlers. Worker export
is awaited or attached to its execution lifetime; native shutdown flush is bounded.

## Ingress and storage

TinSink authenticates its existing per-project keys, registered browser origins,
enabled state and quotas. Add standard OTLP signal paths without exposing the
Collector or ClickHouse directly. Initial supported encoding is OTLP/HTTP JSON;
unsupported encodings receive an explicit error. JSON is a standard OTLP encoding,
not a TinSink envelope. Verify signal shape and bounded record count for the
existing record quota before forwarding; retain a bounded request-size limit.
Public browser keys never acquire server-source or read privileges.

Forward to a private, version-pinned standard Collector. Strip incoming reserved
tenant metadata and inject verified project/source metadata. The Collector reads
that trusted metadata and exports standard OTel logs/traces into ClickHouse using
the contrib ClickHouse exporter. Collector buffering is bounded, with durable queue
storage and retry. Preserve OTLP response/partial-success semantics; never claim
acceptance before the Collector accepts a batch. Telemetry credentials stay in
existing ignored deployment secrets and the server network.

Keep old diagnostic rows readable during migration. Adapt TinSink log queries to
the standard OTel tables so newly delivered exceptions remain inspectable through
the existing owner/scoped-reader authorization. New producer transport must not
require the custom `accepted` response. A future Grafana ClickHouse data source
uses these OTel tables; no Grafana service, dashboards or Cloud stack is deployed
in this change.

## Delivery and evidence

TinSink owns ingress, Collector configuration, and its release pipeline. Its CI
validates that deployment and the disposable ClickHouse full chain without
checking out or dispatching the product release. The Docker build fetches only the
immutable pinned Tincanban design-system revision used by the console; it does not
build or deploy Tincanban. Rusty and the product frontend/Worker use separate CI
and deployment pipelines. Configure producer export only where its endpoint and
credentials are available; absent configuration disables export, and export
failure must not block board writes, authentication, or release activation.

Local proof must exercise official SDK output through the real gateway and
Collector into a disposable ClickHouse, then query the actual stored exception
and trace. Wrong keys/origins, private/server source spoofing, quota overflow,
partial success and Collector outage must remain explicit. Production proof is a
received safe synthetic exception and operation trace from a released, configured
producer, queried directly from ClickHouse. Health checks and configuration files
alone are not delivery evidence. The reported original WASM failure remains
unproven until its first exception is recovered or reproduced.
