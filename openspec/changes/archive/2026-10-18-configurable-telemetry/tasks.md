## 1. Specification
- [x] 1.1 Validate the OpenSpec proposal, design and BDD requirements.

## 2. tincanban
- [x] 2.1 Add local configuration and Diagnostics settings with observable delivery status.
- [x] 2.2 Replace the old payload with schema version 2, full IDs and typed attributes.
- [x] 2.3 Bound queue, request size, retries, expiry and reconfiguration behavior.
- [x] 2.4 Correct chat duration/DOM markers and verify cross-device entity correlation.
- [x] 2.5 Verify real-route browser happy and rejection/pending states plus privacy and persistence.

## 3. Roc sink and storage
- [x] 3.1 Add separate telemetry schema, configuration and least-privilege provisioning.
- [x] 3.2 Persist project telemetry policy and expose authenticated owner APIs for the separate UI rewrite.
- [x] 3.3 Validate version 2 intake, enforce project limits, and acknowledge confirmed writes.
- [x] 3.4 Add correlation report APIs and verify happy, empty and failure responses independently of the UI rewrite.
- [x] 3.5 Verify schema version 1 analytics compatibility.

## 4. Validation
- [x] 4.1 Run builds, focused unit/browser/integration checks and OpenSpec validation.
- [x] 4.2 Document configuration, provisioning and production activation steps with tested status.

## 5. Renaming and keyed browser intake (2026-10-08)
- [x] 5.1 Rename the local checkout to tincanban and update deployment/sibling path consumers; preserve active chat access through a compatibility link.
- [x] 5.2 Verify production storage and project admission without sending production telemetry.
- [x] 5.3 Add the public browser key to local/build configuration and Authorization headers, reject missing keys, and preserve older destinations during upgrade.
- [x] 5.4 Verify authenticated happy delivery, 401/pending states, key persistence and exclusion from payloads with real-route browser and unit checks.

## 6. Configuration scope correction (2026-10-09)
- [x] 6.1 Move endpoint/project/key/level/sample/batch to deployment configuration; preserve only device opt-out from old preferences.
- [x] 6.2 Replace the operator form with one device consent checkbox and collapsed delivery status.
- [x] 6.3 Verify deployment configuration, storage failure, privacy, collector rejection and UI scope on isolated real routes; validate OpenSpec and project quality checks.
- [x] 6.4 Separate Identity/Workspace/Connections, label workspace photo scope, consolidate access and backup flows, and move existing manual integration setup without changing its contract.
