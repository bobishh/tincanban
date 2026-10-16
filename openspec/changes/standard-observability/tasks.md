## 1. Contract
- [x] 1.1 Record current loss of exception diagnostics and the standard OTel pipeline; keep Grafana installation outside scope.
- [x] 1.2 Author acceptance for real error/stack/cause preservation, correlated spans, authentication, consent and delivery failures (browser and Worker SDK tests, TinSink OTLP gateway test, Rusty telemetry test, and public-delivery native test).

## 2. Implementation
- [x] 2.1 Capture bounded original exceptions with credential redaction and preserve error objects at trace boundaries.
- [x] 2.2 Replace browser diagnostic transport with official OTel logs/traces SDKs and OTLP export; instrument actual sync phases and first failures.
- [x] 2.3 Integrate automation Worker and native Rusty OTel export without blocking application work or exporting secrets.
- [x] 2.4 Add authenticated OTLP ingress, private Collector and standard ClickHouse storage; retain existing TinSink log access and old rows.

## 3. Completion
- [x] 3.1 Run the full-chain SDK → gateway → Collector → ClickHouse acceptance and query actual stored exception/trace rows; complete strict spec validation. Authored acceptance is not a run result.
- [ ] 3.2 Complete shared visitor-board acceptance as its own product gate. Release the product frontend/Worker, Rusty and TinSink through their separate owning pipelines; optional diagnostic export must not add a cross-service build or deployment gate. Verify stored production rows only for deployed producers with export configured.

## 4. After diagnostic release
- [ ] 4.1 Inspect the first production exception preceding Module terminated after the expanded diagnostics are released; reproduce and fix the evidenced cause. This does not block releasing diagnostics.
