# Implementation and activation

## Scope

tincanban uses explicit deployment configuration and device-local consent and sends schema version 2 batches to the existing sink `/events` route. The Roc sink uses a separately configured telemetry database/table and writer/admin accounts. Website analytics continues using schema version 1 and `shared_analytics.events`.

The sink UI is being rewritten separately. This change supplies authenticated owner APIs and their contract; acceptance of the replacement console belongs to that task. An earlier browser test targeting the previous console no longer matches the rewritten UI and is not evidence that the replacement console is verified.

## Verified locally

| Check | Result |
| --- | --- |
| tincanban unit suite | 113 files; 979 passed, 1 skipped |
| tincanban production build and type checks | Passed |
| tincanban Diagnostics real-route Playwright | 5 scenarios passed: confirmed delivery, pending failure, default disabled, preference persistence/validation, permanent rejection and disabling |
| tincanban paired-device chat Playwright | Passed real pairing, message propagation, offline/reload recovery and matching entity trace across distinct device/session IDs |
| Dependency boundaries, dead exports, AST rules, duplication threshold | Passed |
| Changed telemetry modules/components lint | Passed |
| Full repository lint | Blocked by concurrent `src/App.vue` exceeding the existing 500 code-line limit; telemetry change does not edit this file |
| Whitespace checks | Passed |
| Roc compiled artifact | Compiler reports 0 errors, 60 warnings and successful build; CLI exits 2. Produced binary passes the API and ClickHouse tests below |
| Sink API BDD | Passed settings, owner authentication, selected database/table/TTL bootstrap, report success/empty/HTTP failure/transport failure and separate telemetry SQL identity |
| Admission regression checks | Passed exact event name rejection of descendants and rejection of an initial two-event batch when quota is one; neither writes to ClickHouse |
| Schema version 1 analytics compatibility | Passed compiled final Roc binary against controlled ClickHouse success, transport uncertainty, rejection, recovery and quota enforcement |
| Real ClickHouse integration | Passed actual tincanban `diagnosticEvent` → Roc → loopback ClickHouse; Float64 duration, per-event typed attrs, uppercase/numeric-first opaque IDs, entity-less events, full correlation, repeat delivery deduplication and trace filter |
| Provisioning runtime | Passed isolated mocked remote execution with custom database/table, scoped users/grants and authentication probes; no SSH or network |
| Companion syntax checks | Python compile and Node syntax checks passed |

Sink verification commands rebuild the current Roc source into an isolated verification binary, avoiding the concurrently rebuilt general sink executable: `npm run test:bdd:telemetry-api`, `npm run test:sink:telemetry:clickhouse`, and `python3 tests/provision-telemetry-remote.py`, from `gonzo-yuppie`. The ClickHouse test requires the isolated loopback fixture and uses the actual sibling tincanban event encoder. Fixture records were deleted and the fixture server stopped after verification.

## Files and owner API

- [Telemetry storage schema](../../../../gonzo-yuppie/db/telemetry_schema.sql)
- [Roc sink configuration and operations](../../../../gonzo-yuppie/sink/README.md)
- [Intake and owner API contract](../../../../gonzo-yuppie/contracts/telemetry.md)
- [Telemetry provisioner](../../../../gonzo-yuppie/sink/ops/provision_telemetry.py)
- [Private secret generator](../../../../hetzner_playground/bin/gonzo-telemetry-secrets)

Owner endpoints use the existing sink session. Mutations require its exact Origin and CSRF token. Configuration, reports and SQL execution use separate telemetry policies and credentials:

- `POST /admin/projects/telemetry`
- `GET /admin/telemetry/bootstrap`
- `POST /admin/telemetry/sql/execute`
- `GET /admin/telemetry/reports?project=tincanban&trace_id=<optional>`

Reports return at most 100 recent logical events, deduplicated by `(project,event_id)`. Their entity/trace fields support correlation; they are not unique visitor counts or proof of synchronized clocks.

## Production activation

The initial implementation on 2026-10-07 did not provision or deploy production storage. Other sink work subsequently provisioned and deployed it. Read-only owner checks on 2026-10-08 confirm `telemetry.events`, both telemetry credential pairs ready, and a 30-day bootstrap TTL. The registry contains only `meta-uber-engineer`, whose telemetry policy is disabled. Neither `tincanban` nor `match` is registered. An owner SELECT grouping telemetry records by project returned no rows: production telemetry is currently empty.

The updated sink requires a public browser write key for browser intake. The tincanban sender now supports that key in local preferences and `VITE_SYNC_TELEMETRY_BROWSER_KEY`, passing it only through the Authorization header. This client update is local; no production registration, key rotation, telemetry event write or client deployment was performed in this follow-up.

Remaining activation steps are project registration/admission, public-key configuration and publishing the updated client. Steps 1–3 below describe provisioning for installations where storage is not already ready; do not repeat provisioning unnecessarily on the verified production sink.

1. From `hetzner_playground`, generate private telemetry secrets with `python3 bin/gonzo-telemetry-secrets`. Existing secret values are retained; passwords are not printed.
2. Run `python3 ../gonzo-yuppie/sink/ops/provision_telemetry.py` as operator. It provisions the configured storage on the existing private ClickHouse accessory and verifies separate grants and bounded account settings. Optional `--database`, `--table`, `--ttl-days` must match sink environment configuration.
3. Deploy the sink with its existing deployment workflow after both telemetry secrets are present. With neither present, the deployment remains analytics-only; a partial credential pair is rejected.
4. Register project `tincanban` with exact application origins and retain its one-time public browser key. Enable its telemetry policy; allow intended event names or dotted prefixes, configure hourly quota and a batch limit of at least the selected tincanban batch size. Do not use or rotate the unrelated main-site project's key for tincanban.
5. Configure the frontend build once per deployment: `VITE_SYNC_TELEMETRY_URL=https://analytics.meta-uber-engineer.dev/events`, project `tincanban`, its public browser key, level, sample rate and batch size. Publish that build. Cloudflare build variables supply these public values; backend secrets remain runtime secrets. Each device may opt out under Settings → Identity; saved legacy collector addresses are ignored. Never put the server/desktop secret key into frontend build configuration.

6. Produce a chat/document event. Confirm delivery status and owner report show the same full entity/trace IDs. Test one disabled/disallowed policy response and restore intended settings. Do not infer real user traffic from locally generated diagnostics.

Collection is memory-only: reload can discard pending events. No durable delivery claim is made. Network uncertainty can produce duplicate physical rows; report deduplication preserves one logical event.

## Checkout rename and authenticated-client follow-up (2026-10-08)

The physical checkout is now `alcoholics_audacious/tincanban`. `match` is a relative symlink for active chats and existing local tooling. Deployment context/Dockerfile paths, sibling design-system consumers, companion encoder test imports and repository documentation use the new path. Git root and the initialized MetaMesh submodule resolve correctly after the move.

The companion test imports the encoder from the renamed checkout and its real ClickHouse insert/dedup test passed after the move. The owned loopback fixture was stopped afterward.

Checks after the follow-up: 11 focused telemetry unit tests passed; 7 real-route browser scenarios passed, including missing-key validation, authenticated delivery, persisted key, temporary failure and permanent 401/404 rejection. The new missing-key browser scenario failed before implementation, then passed. The production build/type check, changed telemetry lint and whitespace checks passed. Legacy enabled settings without a key retain their selected endpoint/project while disabling collection until configured.
