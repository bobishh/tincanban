## Why

tincanban's external diagnostic sender used a nonexistent endpoint and discarded useful synchronization fields. Operators need explicitly configured, bounded diagnostics in the existing Roc sink and ClickHouse, separate from public website analytics.

## What Changes

- Replace the old browser payload with versioned telemetry events on the existing sink `/events` route.
- Configure endpoint, project, public browser key, level, sampling and batch size once per frontend deployment; retain only device consent and collapsed delivery status in tincanban.
- Add independently configured `telemetry.events` storage, project permissions, quotas and reports to the Roc sink.
- Keep full correlation IDs and typed, allowlisted attributes. Correlate chat and document events across devices using verified message IDs and change hashes.
- Keep website analytics schema version 1 and its existing database unchanged.

## Capabilities

### New Capabilities
- `settings-scopes`: Identity, workspace configuration, access/storage connections and backups have explicit scopes.
- `configurable-telemetry`: Explicit diagnostic collection, bounded delivery, server admission and correlation reports.

### Modified Capabilities
None. Diagnostic collection cannot change application data or access rights.

## Impact

tincanban settings, trace sources, browser tests; companion `gonzo-yuppie/sink`, ClickHouse schema and provisioning, and deployment configuration. Production provisioning and deployment are separate operator actions; applying this change produces verified source and provisioning commands, not a claim of production activation.

The sink UI is being rewritten in a separate task. This change supplies its telemetry APIs and contract; replacement console implementation and its browser acceptance belong to that task.
