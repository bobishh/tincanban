## ADDED Requirements

### Requirement: Owner can inspect and update an existing integration
The application SHALL display the verified active board scopes, integration revision, and future-board policy for a saved Rusty integration. Owner settings SHALL target the saved integration ID and SHALL NOT remove and recreate or rebind that integration.

Client mutations SHALL use the canonical controller/service integration ID and that integration's revision. Aggregate service revisions SHALL NOT be used as per-integration compare-and-swap values. Terminal noncanonical history MAY remain in signed status and grant-floor calculations, but SHALL NOT be selected as a mutation target. Noncanonical history with active scopes, future-board consent, pending operation, or incomplete cleanup, and duplicate canonical rows, SHALL block automatic selection.

#### Scenario: Current settings load
- **WHEN** an owner opens an active Rusty integration
- **THEN** the application displays only service-verified active scopes and the verified future-board policy
- **AND** a status failure leaves cached settings visible with an explicit retry/error state

### Requirement: Expanding access requires authenticated owner consent and Rusty admission
Adding a board or enabling future-board access SHALL require a pairing operation bound to the current integration ID, revision, exact additions, and policy baseline. The application SHALL preserve currently active scopes while approval is pending. On a configured owner-origin lane, an explicit owner decision from the signed controller origin can satisfy Rusty's admission authority without a second manual operator step. Legacy services retain separate operator and controller approvals. Both lanes SHALL verify the exact signed decision and service status before provisioning.

#### Scenario: Add a board through owner-origin admission
- **GIVEN** an active integration and a newly selected owner board
- **AND** Rusty advertises owner-origin admission for the configured Tincanban origin
- **WHEN** the owner explicitly approves the exact signed request and Rusty commits the owner-signed grant
- **THEN** Rusty adds only that board at a grant epoch greater than any tombstone
- **AND** prior active scopes remain active
- **AND** no separate operator approval is requested
- **AND** the application updates its local reference only after verifying the service-signed completion

#### Scenario: Add a board through legacy manual admission
- **GIVEN** an active integration with a service that omits owner-origin admission support
- **WHEN** controller and operator approve the same comparison code and Rusty commits the owner-signed grant
- **THEN** Rusty adds only that board at a grant epoch greater than any tombstone
- **AND** prior active scopes remain active
- **AND** the application updates its local reference only after verifying the service-signed completion

#### Scenario: Approval remains pending
- **WHEN** either approval is absent or provisioning has not committed
- **THEN** no added board becomes active
- **AND** existing scopes remain usable and the pending operation can be reopened, retried, or cancelled safely

### Requirement: Reductions do not wait for operator approval
Removing an active board or disabling future-board access SHALL use an owner-signed request and SHALL NOT require operator approval. Requests SHALL carry the current integration revision and exact active grant epochs.

#### Scenario: Remove one board
- **WHEN** the owner removes one board from an integration with other active boards
- **THEN** Rusty records a tombstone for exactly the selected board generation and retries exact cleanup
- **AND** every other active board remains active
- **AND** the future-board policy remains unchanged
- **AND** the removed board is added to the future baseline if future access remains enabled

#### Scenario: Disable future boards
- **WHEN** the owner turns off future-board access
- **THEN** Rusty commits the owner-signed policy update at the expected revision
- **AND** existing active board scopes remain active
- **AND** later automatic offers prepared against an older revision are rejected

### Requirement: Future consent excludes existing unselected boards
When future-board access is enabled, the signed baseline SHALL include every board owned at approval time, whether currently selected for the integration or not. Only later-created boards are eligible for automatic offer.

#### Scenario: Existing unselected board
- **WHEN** future access is enabled while an owned board is not selected
- **THEN** the unselected board remains excluded from automatic offer
- **AND** the owner must add it through the dual-approval expansion flow

### Requirement: Update retries are fenced and durable
Rusty SHALL compare the expected integration revision before changing policy or scopes. Identical operation retries SHALL return the same durable result; operation-ID reuse with a different payload SHALL conflict. Cleanup and activation failures SHALL preserve retryable intent without falsely reporting completion.

Invitation hosts created while a durable mesh is available SHALL use its leased
node-instance key before workspace authority is adopted and after reload. Host
creation SHALL NOT register a legacy unscoped node route that changes on reload.

#### Scenario: Keeper host route survives adoption and reload
- **GIVEN** an owner creates a keeper invitation host with a durable mesh available
- **WHEN** the host adopts the owner workspace and the app reloads
- **THEN** both host starts use the same leased node-instance key
- **AND** Rusty can continue dialing the registered route

#### Scenario: Stale update
- **WHEN** another integration update advances the revision first
- **THEN** the stale operation changes no scopes or policy
- **AND** the application keeps existing settings visible and offers refresh/retry

### Requirement: Missing pairing cleanup stays blocked until independently verified
When a saved withdrawal targets a pairing record Rusty no longer retains, the application SHALL preserve its outbox and proofs internally and SHALL NOT create a cancellation receipt. It may resolve the orphan only from a fresh service-signed status bound to the exact owner, service, integration, and revision, with no pending operation or active target scopes. Every locally saved issued grant SHALL have a valid owner signature and explicit safe access epoch covered by a completed removed tombstone at an equal or newer epoch; local owner revocation SHALL also complete before unblocking. The application SHALL NOT project withdrawal outbox entries as active keepers, display cancellation history, or globally block discovery because an outbox entry exists.

#### Scenario: Exact signed cleanup resolves a pruned pairing
- **GIVEN** a saved withdrawal whose pairing endpoint returns not found
- **AND** its cached grant and controller identity verify
- **WHEN** current signed integration status proves no active target scope, no pending operation, and completed tombstones covering each saved grant epoch
- **AND** the owner records exact local revocations
- **THEN** the application stores signed status and local revocation proofs in the internal outbox record
- **AND** the request is no longer treated as a pending cancellation
- **AND** the application does not claim Rusty issued a cancellation receipt
- **AND** no cancellation-history row appears in the keeper UI

#### Scenario: Dismiss unresolved cancellation without deleting cleanup evidence
- **GIVEN** a saved unresolved withdrawal outbox entry
- **WHEN** the owner dismisses the visible request and reloads the keeper list
- **THEN** the request and cancellation history stay hidden
- **AND** the durable withdrawal proofs remain saved
- **AND** keeper discovery remains available

#### Scenario: Same integration remains fenced before a new request
- **GIVEN** a saved unresolved withdrawal for the target integration
- **WHEN** the owner starts a new request for that same integration
- **THEN** the application retries exact orphan reconciliation before creating a pairing
- **AND** unresolved cleanup prevents the pairing request from being sent
- **AND** no owner grant or active integration state changes

#### Scenario: Unrelated service outbox does not block discovery
- **GIVEN** an unresolved withdrawal for another Rusty service
- **WHEN** the owner discovers a different service
- **THEN** discovery and request setup continue for the selected service
- **AND** the unrelated outbox remains intact

#### Scenario: Ambiguous orphan evidence remains blocked
- **WHEN** owner proof, access epoch, service/integration binding, current revision, tombstone, or cleanup state is missing or mismatched
- **THEN** the request remains internally pending and blocks only a new request for the same integration
- **AND** dismissing it hides the current request without deleting saved proof
- **AND** a new discovery remains available
