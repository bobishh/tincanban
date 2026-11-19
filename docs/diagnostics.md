# Diagnostic dependencies

The source application emits local `application:surface` and
`application:action` events. It does not serialize usage events for a collector
or send them over HTTP. A deployment can set `ANALYTICS_CLIENT_URL`,
`ANALYTICS_PROJECT` and `ANALYTICS_BROWSER_TOKEN` to attach an external HTTPS
browser script. All settings are optional; source builds contain no such script.
The device's diagnostic opt-out suppresses these local events.

Diagnostic logs and spans use the standard external OpenTelemetry exporters.
The deployment supplies `VITE_OTEL_EXPORTER_OTLP_ENDPOINT` and optionally a JSON
object in `VITE_OTEL_EXPORTER_OTLP_HEADERS`. Credentials, addresses and any
collector-specific headers belong to deployment settings. The source includes
no collector-specific envelope or tenant headers. The existing
`VITE_SYNC_TELEMETRY_*` settings control local sampling, batching and device
preferences, and retain compatibility with older deployment configuration.

Automation uses the same standard SDK with runtime bindings. Release settings
`AUTOMATION_OTEL_ENDPOINT`, `AUTOMATION_OTEL_HEADERS` and
`AUTOMATION_TELEMETRY_TOKEN` supply its optional external dependency.
An absent or unavailable collector must not prevent application work.
