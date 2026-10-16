# Standard observability — execution record

The diagnostics implementation and shared visitor work have separate acceptance
and release gates. TinSink owns its gateway and Collector configuration; Rusty
owns its native service; tincanban owns its frontend and automation Worker. Each
releases through its own CI. Optional diagnostics do not create a shared release
cohort or product activation dependency.

## Current evidence

- **Production browser delivery, 2026-10-16 18:22:45 UTC:** read-only ClickHouse
  queries over the preceding 15 minutes found 162 log rows and 65 trace rows from
  `tincanban.browser`, project `tincanban`, source `browser`, version
  `65a7bdac997c0db17fcbfda575f1857424092682`. Latest timestamps were
  18:19:23.662 and 18:20:07.962 UTC respectively. TinSink `/health` returned 200;
  both `/v1/logs` and `/v1/traces` preflights returned 204 with the exact
  `https://match.meta-uber-engineer.dev` origin and required headers. This confirms
  actual browser export through TinSink/Collector to persistent OTel tables;
  availability remains point-in-time evidence, not an uptime guarantee.
- **Source/focused checks:** official OTel SDK/exporters and spans/logs exist for
  browser, automation Worker and Rusty. TinSink accepts authenticated OTLP/HTTP
  JSON, and the deployment config provisions a private pinned Collector and
  separate ClickHouse schema/users. Bounded exception capture retains messages,
  stacks and causes with credential redaction; `meshTrace` retains detail.error.
- **Isolated full-chain evidence:** TinSink's new `tests/otlp-collector-chain.mjs`
  was run once against disposable remote Docker resources. It sent official SDK
  logs and traces through the checked TinSink binary and actual pinned Collector,
  then verified stored records using the read-only ClickHouse account. TinSink CI
  now runs this test with disposable containers. That isolated fixture remains
  separate evidence from the production browser rows recorded above; it does not
  establish delivery from every Worker or Rusty revision.
- **Acceptance authored:** browser SDK tests cover OTLP signal URLs, redaction,
  consent and failed export; Worker runtime tests cover authenticated correlated
  logs/traces; Rusty tests cover official exporters and W3C parent context; TinSink
  `tests/otlp-ingress.mjs` covers official SDK requests, gateway policy and outage.
  The separate real-Collector/ClickHouse runner passed locally against isolated
  disposable services. The public-delivery native acceptance covers editor/automation owner-closed
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
configuration. It deploys TinSink and
its Collector configuration only; it does not build or deploy the product or
Rusty. The image build fetches the immutable pinned Tincanban design-system
revision for console assets, without depending on current Tincanban main or a
product release trigger. Browser delivery is established by the exact configured
rows above; that evidence does not certify unrelated public-board behavior.
- **Automation defect, separate from TinSink:** Cloudflare reported its isolate
  memory limit/reset while opening historical automation state. Later calls
  emitted `Module terminated`. At 18:10:50 UTC the browser propagated an automation
  management failure into Rusty's status; this is not evidence of a native Rusty
  crash or a Sink outage. The separate executor rollout and removal of that sync
  dependency are tracked in
  [separate automation executor](../separate-automation-executor/tasks.md).
- **Additional source fix:** TinSink approval cloned a Vue Proxy before its error
  handler. Scalar snapshot is now inside try; focused regression passes. Not
  deployed yet.
- **Outside scope by user decision:** installing Grafana, dashboards and Grafana
  Cloud. Standard Collector ClickHouse tables retain future compatibility.

Diagnostic capture now provides original bounded exceptions. Continue incident
investigation against the relevant service/version rather than treating a browser
status label as the failing service's identity.

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
