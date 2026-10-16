# Independent platform releases, preserved local-first architecture

## Why

Tincanban deploy/recovery currently activates a shared Rusty instance, holds its
host credentials and requires the same SDK revision. This is deployment coupling,
not a reason to move application data into another backend. The user explicitly
confirmed local-first + CRDT with Rusty as the only application backend.

## What changes

- Each service repository owns tests, reproducible artifacts and deployment of
  only its own service. Tincanban frontend and automation deploy independently;
  Rusty and TinSink deploy from their own repositories. No central repo is added.
- Clients negotiate API capabilities for each operation. SDK revision remains
  build provenance, never a cross-service release or write requirement.
- Preserve local admitted CRDT as source, existing Rusty replication/public access,
  current signed writer authorization and shared visitor UI. No public-board Worker
  API, new Durable Object namespace, alternate board store or new backend.
- TinSink, Collector and ClickHouse have independent observability ownership and
  release. They are not application backends. Producer endpoint/key configuration
  is optional; export failure does not fail application work or product release.

## Scope

Complete already-authorized shared visitor UI, addresses, typography and standard
OTel diagnostics under these boundaries. Preserve existing boards, identities,
volumes, grants, reader floors and recovery evidence. Grafana and the general Inbox
remain outside this release. The earlier proposed public-board backend migration
is withdrawn; no implementation or deployment of that migration occurred.
