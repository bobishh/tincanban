# Standard observability

Current diagnostics use a private TinSink event protocol. Exceptions lose their
message, stack and causes; unrecognized failures become `unknown_error`. Rusty
replication failures can remain only in UI state. “Module terminated” reports an
already failed Automerge instance, without retaining its first exception.

Replace diagnostic transport with official OpenTelemetry SDKs and OTLP/HTTP.
Send real exception diagnostics and operation spans from the browser, automation
Worker and native Rusty. Reuse TinSink project authentication and the existing
private ClickHouse service through a standard OpenTelemetry Collector. Grafana
installation is explicitly outside this change; its future ClickHouse data source
must work with the standard Collector tables without changing producers.

Keep independent page-view analytics on its existing contract. Board writes,
authentication and public delivery must continue when diagnostics are unavailable.
The visitor-board work has its own acceptance and release gates. TinSink, Rusty,
and the product's frontend/Worker release from their owning pipelines; no shared
release cohort or cross-service build-SHA check is required. Diagnostic export is
optional and its availability must not gate product work.
