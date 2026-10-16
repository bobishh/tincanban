# Design

## Fixed architecture

The user's authoritative model is local-first + CRDT; Rusty is the only application
backend. Browser clients admit and author local CRDT changes. Rusty retains existing
encrypted replication/storage and public-board serving. Its public representation
is derived from the same board, not a separately editable board. The existing
Cloudflare automation Worker remains an authorized executor of external events;
it does not become a second board backend or acquire a new public-board database.

Do not introduce a public-board Worker API, Durable Object namespace or migration
to another datastore. Do not weaken existing owner/editor/automation authorization
or remove server-side constraints merely to make a service appear more generic.

## Build and delivery ownership

Source repositories own tests, immutable artifact publication and deployment of
ONLY their own components. A separate orchestration repository is optional, not a
requirement, and is not introduced by this change. Existing infra configuration
remains in the existing infra repository.

Tincanban CI may deploy its frontend or automation executor independently. It must
not hold Rusty host SSH/runtime credentials or activate Rusty/TinSink. Rusty CI
owns its immutable binary/image, pinned native deployment configuration, safe
single-writer storage handoff and rollback. TinSink CI owns its gateway and the
associated private Collector configuration. Each workflow's production environment
holds only the credentials needed for its own deployment.

Do not replace the global cohort with a mandatory frontend/automation cohort.
Same source repository is not a reason to require simultaneous deployments.
Each component has its own concurrency lock, observed version and rollback record.
Rollback changes only that component and respects its persisted reader/storage
floors. Old combined cohort records remain historical evidence, never an executable
cross-service rollback after the split. Existing frontend compatibility metadata
may retain its legacy URL/field names for backwards compatibility while describing
only the frontend's reader floors; do not invent another wire protocol for release.

An exceptional incompatible API/data migration may require an explicitly reviewed
ordered plan outside the frontend repository. Standard releases preserve the API
and never need that plan. No new repository, runtime service or CI provider is needed.

## Compatibility

Ordinary releases preserve the existing API contract and deploy independently.
Use operation-scoped protocol/capability discovery only for genuinely new optional
operations. SDK revisions are provenance.
Different SDK builds implementing the same supported protocol are compatible.
Do not turn an unavailable optional operation into a global client write barrier.
Each component artifact describes its own local data reader requirements. Rusty
declares its own storage/API compatibility. No forced API-version bump accompanies
an implementation-only release.

Cross-service CI integration may pin a Rusty fixture for reproducibility; this is
not a production deployment pin or shared release gate. Additive API work may ship
before a client starts using it; no exact platform/application build pairing.

## Optional diagnostics

Official OTel producers use configured OTLP ingress. Missing endpoint/key disables
export. Collector outages, exporter exceptions and full queues cannot change card
save/sync results or block product release. Product tests use disposable receivers;
observability CI owns real SDK→TinSink→Collector→ClickHouse acceptance. No diagnostic
key or live shared service is mandatory for product staging/activation.

## Preserve data and existing scope

No workspace, identity, volume, public board ID/URL or authority migration is needed
for this release split. Preserve the shared visitor UI, automatic authorized public
delivery, current asset coherence and reader withdrawal behavior already being
implemented. Public state remains served by Rusty. Retain first-exception OTel
capture; diagnose Module terminated after diagnostic rollout from actual evidence.
