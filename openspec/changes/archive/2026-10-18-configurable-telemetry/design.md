## Flow

tincanban → configured HTTPS `/events` → existing Roc sink → private ClickHouse `telemetry.events`. Website traffic continues through schema version 1 into `shared_analytics.events`.

## Configuration

Application/deployment configuration owns the collector endpoint, project, public browser key, event level, sampling and batching. Vite reads `VITE_SYNC_TELEMETRY_URL`, `VITE_SYNC_TELEMETRY_PROJECT` (default `tincanban`), `VITE_SYNC_TELEMETRY_BROWSER_KEY`, `VITE_SYNC_TELEMETRY_LEVEL` (`all`/`errors`, default `all`), `VITE_SYNC_TELEMETRY_SAMPLE_RATE` (0–1, default 1) and `VITE_SYNC_TELEMETRY_BATCH_SIZE` (1–50, default 50). URL and public key are required; invalid deployment values disable sending. No domain-based activation. Local development uses `.env`; Cloudflare production supplies public values to the frontend build. Collector backend credentials remain runtime secrets, never frontend variables.

Settings → Identity exposes only device consent when a valid deployed collector exists. One boolean under `tincanban.telemetry.enabled.v1` applies to this device across workspaces. Legacy `tincanban.telemetry.v2` settings preserve only explicit opt-out; saved URLs, projects, keys and limits never override the deployment. Opt-out cancels in-flight requests and discards queued events. Workspace IDs provide event correlation, not separate collector configuration. Settings → Connections → Diagnostic delivery shows queue size, dropped count, last confirmed send and delivery errors without exposing credentials.

Sink project registry stores telemetry enablement (default false), event prefixes, quota and batch size. Browser producers require their scoped public write key; server/desktop producers require the separate secret write key. Exact Origin lists can additionally restrict browser admission. Browser Origin alone is not proof of a trusted device. The sender places the public key only in `Authorization: Bearer <key>`, never the event payload or status. Server-owned storage configuration selects the database/table and separate writer/admin credentials. Missing telemetry credentials disables that stream while analytics remains usable. Database/table names cannot be supplied by an event producer.

## Contract

`POST /events` accepts `{schema_version:2, project, stream:"telemetry", source, events}`. Request ≤64 KiB; batch 1–100 events, additionally limited by project settings. Event fields:

| Field | Type and bounds |
| --- | --- |
| event_id | UUID; stable across delivery attempts |
| occurred_at | UTC ISO timestamp |
| event | Identifier, ≤160 bytes |
| build | Build identifier, ≤128 bytes |
| session_id, device_id, workspace_id, entity_id | Full identifiers, ≤160 bytes; empty when absent |
| entity_type, component, operation, status | Identifiers, ≤64 bytes |
| trace_id | Empty or 32 lowercase hex characters |
| span_id, parent_span_id | Empty or 16 lowercase hex characters |
| duration_ms | Finite number, 0–86400000; 0 when no duration measured |
| attrs | Typed record of the allowlisted attributes below |

Attributes: `phase`, `transport`, `mode`, `frame_kind`, `recovery`, `error_code` (identifiers ≤64 bytes); `connection_id`, `peer_id`, `change_id` (full identifiers ≤160 bytes); `attempt`, `bytes`, `peer_count`, `change_count` (nonnegative safe integers); `heads` (≤32 identifiers, each ≤160 bytes). Unknown input detail fields are never forwarded. No content, names, raw errors, endpoints, proofs, tokens or IP addresses.

ClickHouse stores stable fields in typed columns and `attrs` as bounded JSON text, preserving numeric, string and array types within the declared schema. Retention defaults to 30 days and is configurable in operator bootstrap. Reports deduplicate by `(project,event_id)` and expose complete entity/trace correlation.

## Correlation and measurement

Entity events derive `trace_id` from the first 128 bits of SHA-256 over the versioned tuple `(project,workspace_id,entity_type,entity_id)`. The verified message ID/change hash already propagates through P2P; both devices derive the same correlation without modifying signed records. This is an entity event stream, not a fabricated OpenTelemetry span tree: span fields stay empty unless an instrumented caller supplies valid context. Events without an entity leave trace fields empty. Sampling uses the trace ID when present so related entity events make the same sampling decision across devices.

Chat send/receive durations use `performance.now()`. `chat.dom.updated` means Vue committed the DOM, not browser paint; duplicate snapshot notifications do not create repeated DOM events within a bounded recent-message window. Existing persistence markers stay truthful about committed data. No claim of exact A→B latency from independent wall clocks or server intake times.

## Delivery

Memory-only queue: at most 1000 events, expiry after 5 minutes, bounded batches ≤50 and ≤64 KiB. One request at a time, 5-second request timeout, exponential retry capped at 60 seconds. Permanent rejection (400/401/403/404/413/422) suspends sending until collection is explicitly reset by device opt-out/opt-in or reload; transient errors retry. Successful ack must confirm the entire batch. Disable discards the old queue. No unconditional pagehide beacon bypassing admission or retry policy. Collection never delays or fails application writes.

## Operations

Checked-in schema and provisioning commands create separate telemetry database/table and least-privilege users. Secrets stay in operator environment; never in browser configuration or reports. Local integration runs use isolated ports and fixture credentials. Production apply/deploy is not implicit in local code implementation.

## Sink UI integration

The sink console is being rewritten separately. This change owns the stable authenticated configuration, bootstrap, dedicated telemetry SQL and report APIs; it does not own the replacement console implementation. Verify backend happy, empty and failure responses independently of concurrent UI changes. tincanban device consent and delivery status remain part of this change and require real-route browser verification.
