# Public board publication implementation

Implementation and local evidence, 2026-10-10. The initial handoff was local;
the user requested completing the production rollout on 2026-10-11. Releasing
the feature does not publish a real user's board automatically.

## Implemented behavior

- `/boards/<board-entity-id>` starts a separate anonymous reader before private
  application imports. Invalid `/boards` paths also stay outside private startup.
  Readers can search, inspect card bodies, read scoped discussion threads and
  download files. Public viewing creates no Visitor, identity, workspace or mesh
  connection. Private Visitor invitations retain their existing behavior.
- Confirmed source owners explicitly open **Publish board**, check Keeper state,
  and confirm disclosure. **Publish**, **Update** and **Unpublish** use signed
  challenge-bound commands and verified exact receipts. Private edits remain
  private until Update; comparisons report **Matched at last check**, not an
  automatic promise of current content.
- The selected-board projection includes active columns, fields/options, nested
  cards and their bodies/values, valid board/card/field discussion threads with
  replies and author display labels, and attached board/card documents/artifacts.
  It excludes archived/unrelated content, private metadata, global chat,
  credentials, source identity-bearing message IDs, signatures, mention IDs,
  transport tickets, local paths and quote-selection context. Thread/message
  identifiers become opaque hashes. Other boards and workspace history are not
  serialized into the publication.
- Attachment bytes pass through existing authorized readers and are separately
  hashed/staged. Retrieval failure names the unavailable file and recovery
  action. Snapshot activation verifies every referenced digest and size. Failed
  staging/activation preserves the prior confirmed snapshot and files.
- Rusty stores publications, challenges, withdrawal tombstones and public file
  copies in a separate owned namespace. Exact signatures, configured controller
  trust, short challenge lifetime/replay protection and revision compare-and-set
  govern changes. Atomic writes and file/directory fsync precede receipts.
  Anonymous downloads require the current active revision and manifest, use
  no-store/nosniff/download headers, and stop after update or withdrawal.
- Public-view measurement is optional, content-free and nonblocking. Existing
  configuration, consent, telemetry level and sampling apply; at most one event
  per navigation, with empty device/workspace IDs. No public audience records or
  click-by-click instrumentation were added.

## Verification

- `npm run test:coverage`: **152 files, 1,638 passing tests, one existing skip**.
  Statements 50.62%, branches 46.01%, functions 50.77%, lines 55.18%; existing
  thresholds remain unchanged.
- Focused `npm test -- --run src/public`: **42 passing cases** covering projection
  privacy, archived/restored content, anchored threads, attachment failures,
  challenge/receipt binding and optional analytics.
- All existing quality gates passed: types, typed lint, dead-code check,
  dependency rules, duplication and pattern rules. Dependency scan: 451 modules,
  1,443 dependencies, no violations. `npm audit --audit-level=moderate`: zero
  vulnerabilities.
- Existing production `policy-transport-startup.spec.ts`: **3/3 passing** against
  the Terser-built assets, including persisted local editing/reload with transport
  unavailable and explicit failure when policy WASM cannot load.
- `npm run test:e2e:public-board`: **8/8 passing**, Chromium and WebKit, isolated
  real routes at phone/desktop widths. The actual Keeper flow covers owner
  publication, an anonymous reader, exact binary attachment bytes, discussion
  rendering, unavailable-source update preserving the old snapshot, a successful
  update invalidating old file URLs, Keeper restart with durable snapshot/files,
  and withdrawal followed by board/file 404s. Separate mocked cases cover
  pending/unavailable/malformed/retry states and invalid public paths. Fresh
  reader probes observed no IndexedDB opens, workers or WASM requests/instances.
- `TINCANBAN_PUBLIC_E2E_PREVIEW=1 npm run test:e2e:public-board`: **6/6 passing**
  compiled public-reader cases, Chromium and WebKit, with the same allocated
  loopback origin embedded at build time and used by mocks. This mode excludes
  the two actual Keeper cases: their owner fixture imports Vite-only source
  modules. An attempted full compiled run failed those fixture imports; it is
  not reported as successful compiled Keeper verification. Actual owner/Keeper
  verification passed against the development build; production private startup
  has the separate three-case packaging proof above.
- Sibling `cargo test --locked`: **21/21 passing**, including existing blind
  ciphertext behavior, public discussions/files/restart/withdrawal and ten
  publication security/lifecycle tests. These cover exact challenge/signature/
  controller/CAS/replay bindings, missing assets, staged-file invisibility,
  durable-write failure and retry, withdrawn revision continuity, exclusive
  writer recovery, unknown-state/key-loss refusal and bounded orphan cleanup.
  Touched native modules were formatted; `cargo fmt --all -- --check` passed.
- `node --test scripts/build-budget-files.test.mjs`: **4/4 passing**. Budgets follow
  the emitted Vite manifest and count the complete static dependency closure plus
  immediate private startup imports, including the private App, diagnostics and
  Berlin tower. Shared chunks count once; missing/ambiguous/unsafe manifest paths
  fail closed. Moving the App to a dynamic entry cannot hide its bytes.
- Transitive `public-reader-stays-anonymous` dependency guard passes. A temporary
  negative probe importing private chat failed with this named rule, then was
  removed. Public renderer/analytics cannot transitively depend on private
  identity, storage, chat, policy, Automerge or mesh modules.

- Checked production build and final `npx size-limit` passed with a configured
  loopback public origin. Brotli sizes: private startup **229.52/235 kB**, private
  CSS **10.25/10.5 kB**, public startup **59.43/235 kB**, public CSS **10.50/10.5
  kB**, lazy Markdown **36.88/40 kB** and its CSS **440 B/1 kB**. Automerge
  **781.44 kB/1.1 MB**, transport **2.28/2.3 MB**, policy **1.17/1.2 MB**. No
  pre-existing cap was raised. Public CSS has little remaining headroom.
- Terser uses two conservative compression passes with unsafe transforms
  disabled. Shared Vue/Zod code occupies one framework chunk; publication
  management loads only on explicit owner interaction. The budget guard counts
  private startup even though routing now imports it dynamically.
- Test description inventory regenerated. Declaration counts, including
  parameterized declarations, are distinct from execution counts above.

## Test ordering and regressions

Observed intended red/green regressions include a wrongly bound service ID in a
signed challenge, restored cards retaining historical `archivedAt`, a filename containing private path
segments, and thrown peer attachment retrieval losing its named recovery error.
Native red/green evidence includes refreshing a previously orphaned staged file:
without a fresh durable timestamp, cleanup could delete a file just restaged for
another publication. The fix refreshes/syncs the file before its receipt. The
budget fixture also failed when the immediate Berlin tower startup import was
omitted, then passed after including it.

Ordering deviation from the original tasks: mocked real-route reader acceptance
and native route test declarations preceded their reader/endpoint implementations;
browser execution followed implementation. Projection/protocol tests also grew
alongside their helpers. The full owner/Keeper lifecycle acceptance was added
after the initial protocol slice. We do not claim every protocol/DTO test first
failed before its original implementation. Confirmed behavioral red/green
regressions are those listed above. An initial native anonymous-route test also
failed 404 because its empty-store fixture omitted publication; the corrected
fixture signs and activates a snapshot before GET. That setup failure is not a
product red test. Tasks were adjusted to record this actual ordering rather than
mark an untrue chronology complete.

## Rollout and authority boundaries

`VITE_PUBLIC_BOARD_ORIGIN` is documented in `.env.example` and mapped from the
same repository variable into the checked frontend CI build. Configure an exact
HTTPS Rusty origin, the service's `RUSTY_TRUSTED_OWNER` root/controller-device
allowlist, durable volume and exact frontend CORS origin. Missing origin or
publication capability produces an explicit error. The follow-up release sets
the repository variable to `https://ingest.meta-uber-engineer.dev`, retaining the
existing server owner trust, CORS origin, service key and durable volume.

Rusty verifies configured publication-controller authority. It cannot independently
inspect encrypted workspace history to prove current source-board ownership; the
private client confirms that owner role. Transferring private workspace ownership
does not silently transfer management of an existing public copy. Withdraw or
manage that publication explicitly. Downloaded copies cannot be recalled.

Frontend CI does not deploy the sibling Rusty service. The earlier CI pin,
`d811e9d2d8b2de26c3b852506ea991cb674a654b`, predates this API. The publication
protocol is consolidated into Rusty's authoritative blind-storage `main`,
preserving its current service history without maintaining a parallel feature
branch. Frontend CI pins an immutable compatible commit from that `main` and
builds/tests its native binary. The compatible release passes all 21 native
tests. CI also checks actual Keeper lifecycle in Chromium/WebKit and the compiled
anonymous reader, in addition to core/mobile mocked scenarios. Frontend releases
still require every Verify job to succeed.

Kamal owns the native release at `ingest.meta-uber-engineer.dev`. Build and pull
the immutable image before stopping the old writer, then back up the stopped
`mesh_lighthouse_blind_20261008` volume and start the replacement. Two processes
cannot share its exclusive storage lock. Verify the existing service identity,
encrypted storage inventory and new publication capability after startup. The
old binary rejects a `publications/` namespace after its first signed challenge;
roll forward or preserve that subtree separately before rolling back. Never
delete it or recreate the service key/volume.

Sibling user changes in `src/keeper.rs`, `src/replication.rs` and `.sloposcope/`
were preserved. Domain purchase, indexing/SSR and publishing a real board remain
separate actions.
