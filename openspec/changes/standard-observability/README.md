# Standard observability — execution record

The diagnostics implementation and shared visitor work have separate acceptance
and release gates. TinSink owns its gateway and Collector configuration; Rusty
owns its native service; tincanban owns its frontend and automation Worker. Each
releases through its own CI. Optional diagnostics do not create a shared release
cohort or product activation dependency.

## Current evidence

- **Source/focused checks:** official OTel SDK/exporters and spans/logs exist for
  browser, automation Worker and Rusty. TinSink accepts authenticated OTLP/HTTP
  JSON, and the deployment config provisions a private pinned Collector and
  separate ClickHouse schema/users. Bounded exception capture retains messages,
  stacks and causes with credential redaction; `meshTrace` retains detail.error.
- **Isolated full-chain evidence:** TinSink's new `tests/otlp-collector-chain.mjs`
  was run once against disposable remote Docker resources. It sent official SDK
  logs and traces through the checked TinSink binary and actual pinned Collector,
  then verified stored records using the read-only ClickHouse account. TinSink CI
  now runs this test locally with disposable containers. The revised CI has not yet
  run; the synthetic integration fixture does not claim browser E2E or production
  delivery from released browser/Worker/Rusty revisions.
- **Pending release:** TinSink's revised CI has not yet passed. The independent
  service pipelines and configured producer releases have not yet established
  production OTel delivery. No production delivery or browser acceptance is
  claimed here.
- **Acceptance authored:** browser SDK tests cover OTLP signal URLs, redaction,
  consent and failed export; Worker runtime tests cover authenticated correlated
  logs/traces; Rusty tests cover official exporters and W3C parent context; TinSink
  `tests/otlp-ingress.mjs` covers official SDK requests, gateway policy and outage.
  The separate real-Collector/ClickHouse runner passed locally against isolated
  disposable services; the revised CI job has not run yet. The public-delivery native acceptance covers editor/automation owner-closed
  writes and stale-source retry behavior; it is a separate release gate.

## Required checks

Run the checks from their owning checkout; passing one layer does not imply another.

| Layer | Focused check | What it proves |
| --- | --- | --- |
| Browser | `npm run test:coverage` | Browser SDK serialization, redaction, consent and transport failure cases |
| Worker | `pnpm --dir workers/automation install --frozen-lockfile`, then `npm run check`, `npm test`, `npm run build -- --outdir .artifact`, `npm run test:runtime` from `workers/automation` | Worker types, unit/runtime export and checked bundle |
| Rusty | `cargo test --locked` in the Rusty checkout | Native protocol and Rusty telemetry tests |
| TinSink | Build checked TinSink runtime, then `node tests/telemetry-api.mjs`, `node tests/otlp-ingress.mjs`, `node tests/sink-failure.mjs` in the TinSink checkout | Gateway admission, official SDK serialization and unavailable-Collector behavior |
| Full chain | `node tests/otlp-collector-chain.mjs` in TinSink after installing dependencies and building `sink/main.roc` | Official SDK → checked TinSink binary → pinned Collector → disposable ClickHouse, with read-only row checks |
| Release | Each service's owning CI and deployment evidence; query stored rows only when released producers have export configured | Independent service releases and actual configured production delivery |

TinSink CI runs its isolated full-chain runner and validates the pinned Collector
configuration. The revised workflow still needs to pass. It deploys TinSink and
its Collector configuration only; it does not build or deploy the product or
Rusty. The image build fetches the immutable pinned Tincanban design-system
revision for console assets, without depending on current Tincanban main or a
product release trigger. Production delivery and real browser acceptance remain
unverified until their own release and configured-row checks pass.
- **Reported defect remains open:** Rusty panel displays `Module terminated` on
  browser build eec9197. Direct TinSink ClickHouse inspection on 2026-10-16 found
  repeated browser connection failures with only unknown_error. Automerge's WASM
  guard emits that message after an earlier exception terminates its instance.
  No recovered original exception or reproduced root cause exists yet. Do not
  label this corruption, memory exhaustion, native Rusty crash or a fixed defect.
- **Additional source fix:** TinSink approval cloned a Vue Proxy before its error
  handler. Scalar snapshot is now inside try; focused regression passes. Not
  deployed yet.
- **Outside scope by user decision:** installing Grafana, dashboards and Grafana
  Cloud. Standard Collector ClickHouse tables retain future compatibility.

The user explicitly placed root-cause investigation after the diagnostic release.
Do not delay the current release with speculative reproduction attempts. After CI
activation, inspect newly captured first exceptions, then implement the evidenced
WASM fix as follow-up work.

## Independent release gates

TinSink validates and releases its own gateway, ClickHouse OTel schema/users and
private Collector through its pipeline. Product CI releases frontend and
automation Worker; Rusty CI releases the native storage service. None dispatches
or deploys another service, and there is no cross-service build-SHA or shared
activation gate. The pinned design-system source used to build TinSink console
assets is a normal immutable asset dependency, not a product release dependency.

Run and retain the full-chain acceptance in TinSink's own CI. Product and Rusty
tests remain in their repositories. A configured producer may be released or
remain disabled independently of TinSink availability. Verify actual production
rows only after a producer with export enabled has been released; passing CI,
health checks, or another service's deployment does not prove delivery.

## Release handoff — 2026-10-16

The user stopped further local rechecks and requested immediate CI delivery. Browser telemetry and native tests have prior local proof; final immutable artifacts and production rows remain CI/production evidence. Rusty OTLP enables its own reqwest 0.13 Rustls transport for HTTPS; the existing reqwest 0.12 feature does not enable TLS in that exporter.
