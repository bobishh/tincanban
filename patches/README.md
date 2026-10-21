# OTel browser response drain

`opentelemetry-0.223.0-response-drain.patch` backports the bounded response-body
drain and keepalive-budget lifetime from upstream fixes
[#7002](https://github.com/open-telemetry/opentelemetry-js/pull/7002) and
[#7070](https://github.com/open-telemetry/opentelemetry-js/pull/7070).
The implementation is present in the official `otlp-exporter-base` 0.300.0
browser transport. Its original Apache-2.0 license applies.

Chromium does not automatically drain a fetch response carrying `Cache-Control:
no-store`. The installed 0.223.0 transport leaves that body unread and releases
its own keepalive reservation before the browser releases its reservation.
After enough successful requests, later diagnostics fail before reaching HTTP.

The backport keeps the official exporters, serializer, retry rules and request
limits. It discards response chunks without accumulating their contents, retains
the request timeout while draining, and releases each reservation exactly once.
Headers still determine the export outcome immediately. Failed fetches release
their reservations directly. It changes neither global fetch nor collector
caching policy.

`npm ci` applies the reviewed patch through `postinstall`, using Git already
required by the contributor setup. Applying it again is harmless. A changed
package version or unexpected source fails installation for review. ESM,
esnext and CommonJS browser transport builds receive the same repair.

The behavioral regression in `e2e/telemetry.spec.ts` uses a real loopback HTTP
intake with `no-store`, repeated error batches, a permanent HTTP rejection and
successful later delivery. Route-fulfilled HTTP mocks alone do not reproduce
Chromium's response-body lifetime. Remove this patch when adopting a compatible
official release that passes the same regression.
