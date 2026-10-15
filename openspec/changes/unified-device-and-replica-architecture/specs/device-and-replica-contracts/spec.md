## ADDED Requirements

### Requirement 1: Complete same-identity device state
Enrollment and ongoing device synchronization SHALL use one versioned transfer
contract covering identity catalog, latest profile/photo, entitled workspace
references, private Rusty connections and explicit management capabilities.
Required unknown components SHALL produce an upgrade/pending state. Private keys
and credentials SHALL NOT enter other-person shares or public projections.
The person's authoritative name and photo SHALL use a private causal register;
legacy timestamps and per-workspace profile projections SHALL NOT select or
overwrite that register. Incompatible concurrent values SHALL remain visible as
a conflict until an explicit user save resolves them. Before non-adoption device-
state activation, the recipient SHALL verify its current local profile and private
signing keys against the manifest person. A missing or mismatched profile SHALL
require identity restore and SHALL NOT bootstrap a replacement profile or partially
activate imported state.

#### Scenario: Rusty is connected after the phone was enrolled
- **GIVEN** two confirmed devices of one person and no Rusty connection on the phone
- **WHEN** either device connects Rusty and the same-person channel next synchronizes
- **THEN** the phone obtains the connection and capability without manual token entry
- **AND** its inventory cursor and upload acknowledgment start from local progress.

#### Scenario: Profile update with the source device closed
- **GIVEN** confirmed devices and a durably acknowledged photo update on Rusty
- **WHEN** the source browser closes and the other device cold-starts
- **THEN** the other device receives the latest admitted photo and profile
- **AND** stale generated avatars cannot overwrite the newer saved observation.

#### Scenario: Required transfer schema is unsupported
- **WHEN** an older recipient cannot decode a required device-state component
- **THEN** enrollment/update stays explicitly incomplete and requests an upgrade
- **AND** existing identity and local data remain intact.

#### Scenario: Different person or revoked device requests private state
- **WHEN** a different person or currently revoked device connects
- **THEN** no private connection, recovery secret or management capability is disclosed.

#### Scenario: Encrypted recovery restores complete private identity state
- **GIVEN** a root-key holder exports a recovery file and keeps its words separately
- **WHEN** a recipient opens the matching file and words and explicitly confirms replacement of another identity
- **THEN** profile, entitled workspace references, private Rusty credentials, management evidence and recovery evidence activate atomically with the local identity
- **AND** a same-person key-holder import retains the existing device key/certificate and local replication progress; a cold recipient gets a fresh root-certified device
- **AND** interrupted certificate/profile projection remains restartable from durable activation intent, without a second identity replacement.

#### Scenario: Invalid or older recovery files retain explicit scope
- **GIVEN** recovery input is damaged, substituted, oversized, uses an unsupported required format, or is an older seed-only backup
- **WHEN** the user selects or opens that input
- **THEN** malformed, unauthenticated or unsupported files cannot partially activate private state or replace the current identity
- **AND** older valid seed-only files remain readable with an explicit identity-key-only explanation; missing credentials are never invented
- **AND** recovery files contain encrypted portable state, never device private keys or local cursor/outbox acknowledgments; board and attachment bytes remain a separate backup/recovery obligation.

#### Scenario: Optional device-state extensions survive transfer and conflict
- **GIVEN** authenticated same-person manifests contain unknown, well-formed optional components, including incompatible variants with the same name
- **WHEN** devices import and re-export those manifests in either order, including repeated delivery
- **THEN** each opaque optional variant survives with its exact component name, schema and value
- **AND** variants converge deterministically without a clock-based winner or promotion to required state.

#### Scenario: Optional-state activation aborts without replacing newer local state
- **GIVEN** a recipient has retained optional extensions and current identity state
- **WHEN** activation aborts at its atomic storage boundary, or stored extension state uses a newer unsupported format
- **THEN** no partial identity/device-state import replaces existing data, and retained extension bytes remain unchanged
- **AND** retry either replans against current state or reports that an upgrade is required.

#### Scenario: Profile observation arrives before its workspace is installed
- **GIVEN** an authenticated same-person manifest contains a correctly signed own profile for an entitled workspace absent on the recipient
- **WHEN** the recipient activates that manifest and then receives another identity update
- **THEN** both identity updates complete atomically while the original profile remains durably retained
- **AND** no workspace owner, grant or shared profile is inferred from the record's authority wrapper.

#### Scenario: Deferred profile projects after verified workspace installation
- **GIVEN** a retained own profile observation and later installation of the workspace through validated document and authority evidence
- **WHEN** startup or ordinary synchronization retries profile projection
- **THEN** the original signature and chat scope pass current workspace authorization before durable projection
- **AND** rejection, revocation, changed scope or storage failure keeps the observation for retry without blocking other workspace profiles.

#### Scenario: Causally later photo removal survives clock skew
- **GIVEN** one device has causally removed or replaced the saved photo while another retains an older photo and a far-ahead wall clock
- **WHEN** the stale device synchronizes its older profile observation after the causal removal or update
- **THEN** the causally later removal or replacement remains authoritative
- **AND** the old timestamp cannot restore the superseded photo.

#### Scenario: Concurrent incompatible identity changes require explicit resolution
- **GIVEN** two devices make incompatible name or photo changes from the same causal base
- **WHEN** both changes synchronize
- **THEN** both values remain as an explicit conflict without lexical, timestamp or arrival-order winner
- **AND** a user save made after observing both values creates the resolving causal update.
- **AND** a retained presentation shadow must match recorded profile history; an unsigned name or photo outside that history cannot become the conflict display.

#### Scenario: Legacy profile observations gain causality only on explicit save
- **GIVEN** imported legacy profile observations contain incompatible name or photo values and wall-clock timestamps
- **WHEN** the recipient migrates them and later receives an older imported snapshot
- **THEN** migration retains both incompatible values without assigning either a new causal revision
- **AND** only an explicit local save creates a causal revision, after which the older snapshot cannot resurrect a superseded value.
- **AND** admission requires the original bytes for each superseded legacy observation and rejects cross-field references; a signed successor alone cannot discard its historical evidence.

#### Scenario: Shared workspace projection cannot overwrite private identity state
- **GIVEN** a private causal identity name/photo register is newer than a shared workspace profile observation with a legacy timestamp
- **WHEN** that signed workspace profile is admitted or projected
- **THEN** the shared projection remains scoped to its workspace and cannot overwrite the authoritative private register
- **AND** its timestamp cannot change global identity state.

#### Scenario: Name and photo save atomically
- **GIVEN** a user reviews one draft containing a name and photo choice against a captured profile revision
- **WHEN** the user commits the draft, or the durable transaction aborts
- **THEN** both signed values, the personal-root presentation and local profile presentation commit together, or exact previous durable bytes remain
- **AND** one identity-preference event is published only after commit, with no partial name/photo state.

#### Scenario: A stale profile draft requires review
- **GIVEN** a user edits a name/photo draft against a captured revision
- **WHEN** an incoming profile update arrives while editing or wins a compare-and-swap race before save
- **THEN** save reports that review is required and preserves both drafts and profile history
- **AND** only an explicit retry after reviewing the new revision can commit the draft.

### Requirement 2: Explicit and consistent Rusty authority
Rusty SHALL validate device identity separately from person/scope management rights.
Ordinary approved owner-device operations SHALL NOT depend on being descended from
a particular pinned device or on an online primary device. Service pinning, exact
scope/operation restrictions and monotonic revocation SHALL remain enforced.
The root person resource SHALL have an ID equal to the approved person ID and a
distinct service-signed capability limited to `management.update` and
`resource.create`. Every resource-creation request SHALL bind the exact current
parent capability and signed person-management revision. Confirmed person-policy
revocation SHALL gate resource management, status, publication, checkpoint and
enrollment even while a resource capability remains otherwise valid. A pending
person-policy update SHALL block those resource operations while allowing an
authenticated person-status read and exact durable retry. Historical signed
policy evidence and pinned service identity SHALL remain immutable across restart.
Person-policy revocation does not invalidate already disclosed bearer tokens or
erase downloaded plaintext; future-content key/token rotation is separate.
Private-state synchronization SHALL NOT rewrite an enrolled device's certificate
to satisfy legacy controller ancestry. Migration SHALL update service policy through
an explicitly authorized owner action; automatic setup MAY recover a previously
authorized durable request, but SHALL NOT initiate a new legacy permission migration.

#### Scenario: Equivalent owner devices use different valid certificate paths
- **GIVEN** two non-revoked devices of the approved owner with different valid chains
- **WHEN** each performs an authorized scope, publication or storage operation
- **THEN** authorization has the same result for the same current capability.
- **AND** synchronization retains each device's existing certificate and device key.

#### Scenario: Unrelated certificate is appended
- **WHEN** a caller appends a trusted device certificate to an unrelated identity proof
- **THEN** it obtains no rights and no successful receipt.

#### Scenario: Revocation reaches another relay
- **GIVEN** a new revocation/policy revision and rotated future-content keys where needed
- **WHEN** the removed device retries through another endpoint or old capability
- **THEN** the service and receivers reject new unauthorized access/writes
- **AND** the UI does not claim previously downloaded plaintext was erased.

#### Scenario: Legacy owner policy migrates
- **GIVEN** an existing pinned Rusty connection needs an explicit device-access update
- **WHEN** an owner authorizes migration from controller pins to scoped person authority
- **THEN** exact scopes and service identity are preserved in a confirmed policy update
- **AND** interruption leaves recoverable old data and an explicit pending migration.
- **AND** background synchronization exposes the required owner action without creating a policy or rewriting identity; uncertain confirmation retries the exact original request.

#### Scenario: Another same-person device creates a scope after person migration
- **GIVEN** the pinned legacy controller explicitly migrates person authority once
- **AND** a second non-revoked root-issued device has a different valid certificate path
- **AND** controller pins are removed and the original controller is offline
- **WHEN** the second device creates a new scope using the exact parent capability and signed `personManagementRevision`
- **THEN** Rusty accepts creation for that same person and pinned service only
- **AND** issues a scope capability without repeating legacy migration or depending on controller ancestry.

#### Scenario: Person revocation gates every resource operation
- **GIVEN** a confirmed newer person-policy revision revokes a device that still holds otherwise valid resource capabilities
- **WHEN** it requests resource management, status, publication, checkpoint or enrollment
- **THEN** Rusty rejects every request using the current person revocation state
- **AND** the system makes no claim that disclosed bearer tokens or downloaded plaintext were revoked.

#### Scenario: Pending person policy blocks resources but permits recovery
- **GIVEN** a person-policy update is durably pending and its outcome is uncertain
- **WHEN** a non-revoked certified device requests a resource operation, authenticated person status, or retries the update
- **THEN** Rusty blocks the resource operation while allowing authenticated person status and exact retry of the durable request
- **AND** restart preserves the service pin, pending request and historical signed evidence.

#### Scenario: Person policy evidence and service pin survive restart
- **GIVEN** a confirmed person policy, its signed historical evidence and a pinned service identity
- **WHEN** the service restarts or a caller supplies substituted service/person evidence
- **THEN** original signed evidence remains byte-for-byte verifiable and the pin cannot be replaced implicitly
- **AND** mismatched origin, service key or person cannot authorize resource creation or management.

#### Scenario: Owner revokes a sibling's Rusty access across the server's private scopes
- **GIVEN** the current identity owns the connected boards, another device is registered,
  and the pinned server and approved Workers support recoverable rotation
- **WHEN** the Owner explicitly revokes that device on this Rusty server
- **THEN** the client captures and freezes every board/profile scope and approved Worker,
  drains exact saved snapshot requests, confirms person revocation, and rotates scope
  tokens and future content keys without changing Worker approval
- **AND** confirmed credentials, retained keys/cursors and person evidence activate
  atomically; the revoked sibling cannot obtain them through private device exchange
- **AND** success requires fresh-epoch storage receipts, while an interruption offers
  resume with the original journal, keys, request IDs and confirmed steps intact
- **AND** a concurrent signed scope policy revision stops mutation before replacing
  potentially unknown credentials; board-only device removal keeps its original scope.

### Requirement 3: Verified signing context
All new signing paths SHALL obtain a verified purpose/scope-bound context carrying
the complete certificate chain and current authority revision. Missing evidence,
replacement, revocation or expiry SHALL fail closed without assumed ownership.

#### Scenario: Enrolled device creates and reopens a workspace
- **GIVEN** a delegated owner device without the root private key
- **WHEN** it creates a workspace, or archives its last workspace and creates a replacement
- **THEN** genesis contains a complete validated signer chain
- **AND** the device retains verified Owner access after reload.

#### Scenario: Signing ancestor is missing or forged
- **WHEN** a signing context lacks an ancestor or contains an invalid signature
- **THEN** no command/genesis is committed and recovery identifies missing/invalid evidence.

#### Scenario: Context becomes stale during an operation
- **WHEN** identity, device, scope authority or applicable expiry changes during signing
- **THEN** the stale context cannot authorize commit or an external management request.

#### Scenario: Historical evidence differs from current context
- **WHEN** older legitimate authorship is verified after device/certificate renewal
- **THEN** the original signed evidence remains unchanged and independently verifiable.

### Requirement 4: Atomic private preferences and logical conflict resolution
Private service preferences, tombstones and their migration marker SHALL have one
transactional source of truth. Per-device progress SHALL be separate and conditional
on the exact credential revision. Conflict ordering SHALL not depend on wall clocks.

#### Scenario: Process stops during a preference update
- **WHEN** persistence aborts or the process stops at a storage fault boundary
- **THEN** restart yields either the previous complete record or the new complete record
- **AND** registry/effective-configuration divergence cannot occur.

#### Scenario: A received profile was already applied
- **GIVEN** an authenticated private transfer repeats an already materialized workspace profile
- **WHEN** its signature, current workspace authority and durable shared record are independently rechecked
- **THEN** no projection is requeued, the portable identity revision remains unchanged and no new synchronization is scheduled
- **AND** unavailable, revoked, rejected or unapplied observations remain retained for guarded projection.

#### Scenario: Device clock is far ahead
- **GIVEN** two device clocks disagree substantially
- **WHEN** their preference operations causally follow one another
- **THEN** logical causal ordering governs the result and clock skew cannot freeze updates.

#### Scenario: Concurrent remove and update
- **WHEN** devices concurrently remove and modify the same connection
- **THEN** removal remains effective until an explicit later causal re-add
- **AND** stale reconnect/import does not resurrect the connection.

#### Scenario: Concurrent incompatible credentials
- **WHEN** concurrent operations supply incompatible credentials for one scope
- **THEN** a durable conflict is exposed and replication does not guess a credential.

#### Scenario: Credential changes preserve known ciphertext keys and pending uploads
- **GIVEN** a private connection has accepted ciphertext under an active or historical key and may have an uncertain encrypted upload
- **WHEN** a local edit or causally newer peer preference changes that connection
- **THEN** the epoch cannot decrease and every previously known epoch retains its exact key
- **AND** same-epoch replacement, missing history and substituted old keys fail atomically
- **AND** concurrent incompatible keys remain a durable conflict without arbitrary selection
- **AND** key/token migration with a pending upload requires an explicit recoverable transition; policy-only updates retain the exact pending ciphertext and request ID.

#### Scenario: Owner explicitly recovers incompatible same-epoch keys
- **GIVEN** a paused scope has concurrent credentials, including different content keys at the same epoch and an uncertain original encrypted upload
- **WHEN** the current Owner explicitly chooses recovery
- **THEN** the client freezes exact source/progress and approved Workers, creates fresh independent tokens and a key at max observed epoch+1, and retains every old candidate in required wire5
- **AND** signed current scope-policy CAS precedes replay of the original ciphertext/request ID using confirmed current transport credentials
- **AND** every Worker retains the full key set, causal activation is atomic, and completion requires a fresh snapshot receipt
- **AND** interruption retains the original freeze, request, receipts and keys for explicit retry without deleting data or selecting a timestamp winner.

#### Scenario: Older readers receive ambiguous historical keys
- **WHEN** variant history is hidden under private wire4 or an older required identity/Worker schema
- **THEN** decoding fails closed before importing credentials or acknowledging ciphertext
- **AND** a new reader authenticates all candidate keys for the declared epoch and preserves every candidate during later causal updates.

#### Scenario: Completed scope enrollment loses its response
- **GIVEN** Rusty committed token policy and its signed receipt atomically, but the client did not receive confirmation
- **WHEN** the same currently authorized device retries the exact original signed request after challenge cleanup or server restart
- **THEN** Rusty returns the identical signed receipt without advancing the policy again
- **AND** an expired challenge is accepted only for an already committed exact request
- **AND** changed tokens/signatures, superseded policy, revoked authority or corrupt stored receipt cannot recover success
- **AND** a retry reasserts directory durability after an uncertain filesystem commit.

#### Scenario: Cursor arrives after credential rotation
- **WHEN** a replication pass commits progress for a replaced credential revision
- **THEN** the progress write is rejected without modifying the new connection or other scopes.

### Requirement 5: One replica contract across execution hosts
Browser and Worker SHALL use the same replication state machine and host-independent
admission/receipt contracts. Host adapters SHALL preserve atomic persistence, exact
retry ciphertext and scoped author authority. Unchanged polls SHALL not process full
historical payloads.

#### Scenario: Unchanged browser or Worker polls
- **GIVEN** an acknowledged document/authority/profile/archive/blob revision
- **WHEN** either host polls without relevant changes
- **THEN** no historical payload is read, serialized or hashed and no new object is uploaded
- **AND** deterministic instrumentation demonstrates the skipped work.

#### Scenario: One changed card
- **WHEN** an authorized command changes one card against a valid frontier
- **THEN** local persistence and outgoing replication process the new bounded transition
- **AND** lifetime historical transitions are not replayed on the ordinary write path.

#### Scenario: Upload acknowledgment is lost
- **GIVEN** ciphertext was durably stored but the response was lost
- **WHEN** either host restarts and retries
- **THEN** it reuses the exact durable outbox bytes and advances acknowledgment only on a valid receipt.

#### Scenario: Shared engine hosts a restricted automation
- **WHEN** automation attempts a command outside its exact current signed scope
- **THEN** shared policy and every receiver reject it without Owner or Editor fallback.

### Requirement 6: Bounded active history with preserved verifiable archive
The system SHALL implement an explicit policy-authorized history baseline distinct
from storage-object pruning and local admission caches. Active history SHALL have a
configured finite budget; archived original history SHALL remain authenticated and
accessible. No automatic destructive retention is authorized by this change.

#### Scenario: Long editing history reaches the active budget
- **GIVEN** equal visible state with 1k, 10k or 100k historical transitions
- **WHEN** the active tail reaches the baseline trigger
- **THEN** a verified archive and owner-authorized baseline bound the active tail
- **AND** startup/ordinary-save work depends on current state plus that tail rather than lifetime history.

#### Scenario: Unauthorized history is present
- **GIVEN** pending or quarantined original changes
- **WHEN** a history baseline is prepared or received
- **THEN** those changes retain their classification and never gain admission through compaction
- **AND** archive provenance does not fabricate author signatures or historical permission.

#### Scenario: History beyond the baseline is opened or restored
- **GIVEN** a cold receiver with the authorized baseline, archive reading keys and storage access, without the sender or its preparation journal
- **WHEN** a user opens an archived revision or restores an item from it
- **THEN** only required authenticated segments are fetched for inspection
- **AND** a portable encrypted locator directory resolves those segments without loading a lifetime-sized local locator list
- **AND** restore creates a fresh currently authorized command while original history remains intact.

#### Scenario: Archive preparation or baseline activation fails
- **WHEN** a receipt, storage transaction, manifest verification or restart recovery fails
- **THEN** the prior usable basis/history remains recoverable and activation is incomplete
- **AND** no source history is retired before verified recovery coverage exists.

#### Scenario: Storage capacity is exhausted
- **WHEN** active content or retained archives reach a configured quota
- **THEN** pending changes remain recoverable and the product identifies capacity as the cause
- **AND** it does not silently erase history or advertise bounded total disk usage.

#### Scenario: Older client encounters a new baseline
- **WHEN** a client cannot validate the new baseline policy/schema
- **THEN** it cannot append incompatible writes and receives an explicit safe upgrade state.

#### Scenario: Authorized direct peer relays a compact baseline
- **GIVEN** an authenticated peer has current access to a workspace whose active document uses a compact baseline
- **WHEN** another authorized peer receives that document without the baseline already active locally
- **THEN** the sender relays a bounded baseline descriptor and content-addressed original archive records over the encrypted device channel
- **AND** the receiver independently verifies the owner-signed baseline, public scope authority, archive paths, and local-head coverage before admitting the compact tail
- **AND** baseline authority and archive-storage coverage remain separate proofs
- **AND** Rusty read/write tokens, content keys, and private replica preferences never cross the collaborator channel
- **AND** unavailable or incomplete archive data leaves the receiver's existing history intact and reports an explicit unavailable/upgrade state.

#### Scenario: A peer-only device creates and restores a private history backup
- **GIVEN** an authorized collaborator device received an Owner-attested baseline over an authenticated device channel, holds its own identity recovery key, and holds no Rusty content keys or tokens
- **WHEN** its user explicitly creates a private recovery backup
- **THEN** the exporter walks the signed catalogue, entity indexes, original changes, dependency bytes, authorization bytes and source-document/control byte trees
- **AND** available local/recovered objects are reused before requesting missing objects from an authorized device
- **AND** missing objects or unresolved index parents identify their baseline and content hash and force incomplete coverage
- **AND** inspection recomputes that coverage from the encrypted file's retained objects instead of trusting its complete/incomplete label
- **AND** restoration re-verifies baseline authority independently, preserves original journal rows and lets item history read the restored archive offline
- **AND** no Rusty credential is required or invented for the peer-only path.

#### Scenario: Add my device transfers an archived workspace
- **GIVEN** an Owner has an active verified compact basis and retained original history
- **WHEN** another device enrolls under the same identity
- **THEN** its invitation scope is independently validated before baseline preflight or identity adoption
- **AND** approved history requests remain restricted to the selected workspaces and currently authorized device
- **AND** acknowledgement proof paging cannot deadlock while either side waits for completion
- **AND** the host reuses only an exactly matching local history source for the acknowledgement
- **AND** the authorized enrollment channel retains independently verified predecessor descriptors, compact documents and proof bytes with bounded reads, without activating an ancestor or changing the current workspace head
- **AND** each retained predecessor matches the child's signed parent identity and passes Native parent-edge verification; private Rusty credentials remain restricted to same-identity transfer
- **AND** the enrolled device can inspect a complete backup and restore an original version after the source device closes
- **AND** a device without the identity recovery key can inspect and restore a full backup but cannot create a new identity-root recovery export; the UI explains this before offering creation.

#### Scenario: Cold Rusty inventory retains a snapshot from before the compact basis
- **GIVEN** a receiver already has a verified compact basis and Rusty retains older original-root snapshots
- **WHEN** the receiver reads inventory from its own initial cursor
- **THEN** Native may classify a snapshot as already archived only after verifying every original change byte against the signed archive catalogue
- **AND** that snapshot never merges its old document root into the compact document
- **AND** unknown, uncovered or altered changes retain rejection and cannot advance progress as covered history
- **AND** chat and attachment evidence still pass their independent admission paths.

#### Scenario: Compaction replaces the obsolete storage snapshot prefix
- **GIVEN** the current Owner has durably activated a Native-verified compact basis with verified original archive coverage
- **WHEN** that basis is published before coordinated writers resume
- **THEN** an Owner-authorized storage checkpoint publishes the current snapshot and replaces only the covered opaque snapshot prefix using an exact storage-sequence fence
- **AND** archive objects, original classifications and historical catalogue sources remain retained
- **AND** the target ciphertext, signed request and uncertain receipt survive interruption and retry without a second competing operation
- **AND** ordinary raw-history checkpoint restrictions remain unchanged.

#### Scenario: A fresh device reads history across multiple compact bases
- **GIVEN** the newest verified basis refers to an older signed catalogue
- **WHEN** a fresh authorized device requests an earlier item revision
- **THEN** it fetches only needed retained descriptors and records from the same workspace
- **AND** Native verifies each parent edge before that catalogue is exposed to history or recovery
- **AND** missing, substituted, forked or cross-workspace parents remain unavailable without replacing active state
- **AND** no eager traversal of lifetime history is required at startup.

#### Scenario: Stale writer uploads after an archive checkpoint
- **GIVEN** a snapshot outbox was prepared at admitted storage sequence N
- **WHEN** another Owner checkpoint replaces the storage prefix at sequence N+1
- **THEN** Rusty refuses a new append from that older outbox before storing bytes
- **AND** the shared replica engine persists the observed sequence with the original ciphertext and request ID; retries never substitute a newer cursor
- **AND** legacy pending uploads without this field retain sequence zero; existing stored identical objects remain idempotent under current authorization
- **AND** history archiving requires explicit observed-sequence checkpoint support; ordinary synchronization with older storage remains available
- **AND** the existing writer policy and document data formats remain unchanged.

### Requirement 7: Durable encrypted attachments and recoverable sessions
Private attachment manifests/chunks SHALL be available through authorized blind Rusty
storage without a live source browser. Coverage SHALL distinguish metadata, bytes and
admission. Transfer/session replacement SHALL recover or return an actionable state.
Each attachment SHALL expose an explicit coverage state; `Complete on Rusty` means
its authenticated manifest and every required encrypted chunk have verified durable
receipts. A replicated file reference or a locally cached byte copy alone SHALL NOT
be presented as complete Rusty coverage.
Raising a scope's minimum writer version SHALL first migrate its legacy attachment
index and SHALL NOT discard a pending same-scope outbox. A durable local upgrade
intent SHALL survive uncertain network or local transaction outcomes. Only a
verified service receipt and a compare-and-swap against the exact current profile
and preference may atomically publish the upgraded preference, rebound local
progress and clear that intent.
An already-approved automation Worker for the scope SHALL receive a separately
authorized policy-revision refresh before it resumes writes. This refresh SHALL
preserve its current grant, expiry, permissions, definition, control state and exact
pending replication state; it SHALL NOT weaken receipt verification or silently
renew the grant.

#### Scenario: Attachment arrives with the source browser closed
- **GIVEN** confirmed encrypted attachment coverage on Rusty
- **AND** completion was published only after both all file-object receipts and the locator-bearing workspace snapshot were acknowledged
- **WHEN** the source browser closes and another device opens preview/download
- **THEN** verified bytes arrive through Rusty and match the original content.

#### Scenario: Card details close while an attachment is being stored
- **GIVEN** an attachment submission captured its target card, workspace and identity
- **WHEN** file storage finishes after the card details close or another card opens
- **THEN** the attachment is saved to its original card without depending on the current selection
- **AND** a changed workspace, changed identity or missing original card rejects the stale submission
- **AND** current command authorization still applies before the document is committed.

#### Scenario: Session closes during a transfer
- **WHEN** the direct runtime/session closes or is replaced during a file request
- **THEN** the stale session is invalidated and the operation reacquires a current path
- **AND** it does not repeatedly call the closed connection or lose completed durable chunks.

#### Scenario: Oversized peer response is stopped before EOF
- **GIVEN** an attachment chunk is bounded at 256 KiB
- **AND** a peer response streams beyond the response-frame bound without sending FIN
- **WHEN** the bounded reader consumes that response
- **THEN** the chunk is rejected without exposing partial bytes or publishing a partial cache entry
- **AND** only that stream is stopped while the connection remains usable
- **AND** a normal chunk exactly at the response-frame limit still succeeds.

#### Scenario: Missing or corrupt chunks
- **WHEN** a chunk is absent, substituted, truncated or bound to another scope/epoch/purpose
- **THEN** the file remains incomplete/unavailable and unauthenticated bytes are never displayed.

#### Scenario: Network and authorization failures differ
- **WHEN** the service is offline, access revoked or upload pending
- **THEN** each produces a distinct useful state and never a false complete-backup status.
- **AND** failed or slow background file uploads do not block local card saves or replication of their metadata.

#### Scenario: Service storage and logs are inspected
- **WHEN** private attachment sentinels have been uploaded and Rusty restarted
- **THEN** Rusty retains ciphertext/opaque metadata only, without plaintext or content keys.

#### Scenario: Writer upgrade preserves legacy attachment discovery
- **GIVEN** a scope uses a legacy writer floor and its attachment locators exist under the legacy private-replica index key
- **WHEN** the owner requests a supported writer-version upgrade
- **THEN** the client additively migrates those locators before raising the remote floor
- **AND** after a verified receipt it atomically publishes the upgraded preference and newly bound local progress while clearing the durable intent.

#### Scenario: Writer upgrade retries after an uncertain receipt or local commit
- **GIVEN** a writer-upgrade intent was durably recorded and Rusty may have accepted the signed floor change
- **WHEN** the receipt is lost or the local compare-and-swap fails
- **THEN** the client retains the intent and does not claim the local connection is upgraded
- **AND** retry reuses the authorized monotonic operation, verifies the service receipt and commits against current profile/preference state without losing locators or progress.

#### Scenario: Pending outbox blocks writer upgrade
- **GIVEN** the same scope has a pending snapshot outbox
- **WHEN** the owner requests a writer-version upgrade
- **THEN** the client refuses before sending a floor-changing request
- **AND** preserves the exact pending ciphertext, request ID, preference and attachment index for ordinary retry.

#### Scenario: Concurrent preference or identity change blocks writer-upgrade publication
- **GIVEN** a durable upgrade intent was prepared for one identity and preference revision
- **WHEN** credentials, preference revision or the active identity changes before receipt publication
- **THEN** the stale operation cannot publish progress or clear another identity's intent
- **AND** the old intent remains scoped to its captured owner for safe retry or explicit recovery.

#### Scenario: Existing Worker access is refreshed with a writer-floor upgrade
- **GIVEN** an approved automation Worker still holds workspace access at the prior Rusty policy revision, with its own control state and possibly pending encrypted work
- **WHEN** the owner raises the Rusty writer floor and coordinates the new policy revision with that existing Worker
- **THEN** the Worker accepts receipts for the upgraded revision without weakening exact receipt verification
- **AND** its original grant, expiry, permissions, definition and paused/deleted state remain unchanged
- **AND** any pending ciphertext, request ID, deduplication state and cursor remain exact across refresh, retry and restart
- **AND** lost refresh replies can be retried without reporting unapplied work as applied or silently renewing authorization.
- **AND** a fresh upgrade preflights every affected Worker before freezing local replication or changing Rusty policy; unsupported Workers leave ordinary replication usable
- **AND** the durable local intent retains the exact service receipt and the union of discovered Worker routes, including routes removed from the document during a retry
- **AND** local activation waits for verified nonce-bound Worker confirmations; newly discovered Workers are captured and confirmed before completion, and a changing cohort retains its intent for a bounded retry.

#### Scenario: Own devices reaffirm the same writer policy
- **GIVEN** two authorized own devices retain the same Rusty scope credentials
- **WHEN** one device confirms floor 2 and the other obtains a fresh challenge for that already-confirmed target
- **THEN** Rusty signs confirmation at the current policy revision without rewriting the policy or replacing the original completed mutation receipt
- **AND** each receipt remains bound to the exact current device, service, scope, challenge, authorization hash, token commitments and requested floor
- **AND** settings do not diverge merely because another device reconfirmed identical access
- **AND** changed credentials, revocation or writer policy still require the normal revision transition; stale incompatible targets remain rejected.

#### Scenario: A new board connection starts at the current writer floor
- **GIVEN** a newly prepared board connection with no previous enrollment intent
- **WHEN** its owner enrolls and publishes access to another own device
- **THEN** the persisted setup and verified receipt require floor 2 before activation, with no intermediate floor-1 connection shared between devices
- **AND** an existing pending floor-1 intent resumes with its original credentials and request semantics rather than being rewritten.

### Requirement 8: Stable application source and explicit mail binding
Applications SHALL retain original source observations independently of editable
card labels. Email matching SHALL use specific source/thread references or retained
original posting evidence. Ambiguity SHALL support a signed durable owner binding.

#### Scenario: Display Role differs from original posting title
- **GIVEN** a retained original posting observation identifying the role in a rejection
- **WHEN** the email is processed after the card label is edited
- **THEN** that display edit cannot prevent a unique valid application match.

#### Scenario: Employer page changes or disappears
- **WHEN** a posting URL changes title, redirects to a generic page or returns 404
- **THEN** the original retained submission observation remains available and unchanged
- **AND** current page contents cannot silently replace application identity.

#### Scenario: Two applications or a renamed HR title are ambiguous
- **WHEN** source references and original evidence cannot identify one application
- **THEN** no automatic move occurs and the retained event offers explicit application selection
- **AND** no card title change or forwarding of the message is required.

#### Scenario: Owner binds and retries a retained rejection
- **WHEN** the owner signs an exact event/application/workflow binding and retries
- **THEN** classification, current grant, deduplication and causal workflow checks still apply
- **AND** the binding and resulting action remain durably auditable across restart.

#### Scenario: Binding is replayed against another card or newer workflow
- **WHEN** event, scope, integration, card, source identity or workflow precondition differs
- **THEN** the stale/tampered binding cannot authorize a move or broaden automation permissions.

### Requirement 9: Coordinated final release and truthful deployed state
A release SHALL bind exact compatible frontend, Worker, Rusty, policy/runtime and
schema versions. Final CI SHALL build, verify and stage immutable artifacts; release
completion SHALL require verified production activation of the entire cohort.

#### Scenario: Partial deployment fails
- **WHEN** one component fails staging, migration or health/version verification
- **THEN** the release remains incomplete and compatible prior data/readers remain recoverable
- **AND** an updated frontend or Rusty alone is not reported as the completed release.

#### Scenario: All final checks and deployments succeed
- **WHEN** every specification task, final E2E and required CI check passes
- **THEN** the coordinator activates the exact checked cohort and verifies production versions/capabilities.

#### Scenario: Existing phone tab uses an older build
- **WHEN** production is updated but the phone still runs an incompatible old client
- **THEN** the UI identifies the tab's version/upgrade requirement and preserves local data
- **AND** deployment status does not claim that device has acknowledged the new contract.
- **AND** an older writer that discards attachment locators cannot publish a replacement snapshot/checkpoint that strands retained file bytes.

#### Scenario: Rollback after a schema migration
- **WHEN** the release must roll back
- **THEN** only a reader compatible with retained baselines, archives and migration evidence is activated
- **AND** rollback cannot clear storage or strand pending events to hide incompatibility.

#### Release source implementation status
Exact component seals, captured compiled Worker reuse, staged provider UUIDs,
ordered cohort activation, executable/artifact health identities and tab upgrade
barriers are implemented in the working tree. Their acceptance cases remain
unrun. The implementation gate remains closed. Existing native host deployment
configuration and final execution of migration/rollback and deployed-cohort/device
acceptance remain required. Source now includes exact-run CI resume, compatible
prior-artifact selection, preserved schema floors and a sealed frontend rollback
envelope retaining current-tab chunks without extending existing expiries.

#### Scenario: Resume an interrupted activation through CI
- **GIVEN** an exact trusted production run and attempt with retained sealed bundles and journal
- **WHEN** recovery is requested through the production CI workflow
- **THEN** uncertain deployed components are confirmed before retry, existing exact provider UUIDs are reused, and only missing versions are staged
- **AND** a newer unrelated production cohort blocks stale recovery.

#### Scenario: Rollback retains current tabs and schema floors
- **GIVEN** a previously confirmed cohort whose actual readers, writers and capabilities cover retained current floors
- **WHEN** CI prepares rollback
- **THEN** it composes the old UI entry with verified current-tab chunks, preserves existing expiries and reseals both artifact parents
- **AND** it activates exact captured server bundles before the derived frontend without rebuilding or clearing data.

#### Scenario: Same source SHA, different uploaded bytes
- **GIVEN** two bundles built from the same source revision
- **WHEN** any module, WASM or served asset byte differs
- **THEN** their component artifact identities differ and the coordinator rejects the substituted bundle.

#### Scenario: Unfinished implementation cannot activate
- **GIVEN** at least one architecture implementation block remains unfinished
- **WHEN** a release attempts preparation or activation
- **THEN** the explicit implementation gate rejects before production mutation.

#### Scenario: Tab observes an older edge response after an upgrade requirement
- **GIVEN** the tab already observed a higher required reader or writer floor
- **WHEN** a subsequent edge response reports an older cohort
- **THEN** the tab keeps its upgrade barrier and local data until compatible code loads.

### Requirement: Owner's development and release gate
No tests, type/lint/format checks, builds, browser/E2E verification, CI, staging,
commit, push or deployment SHALL execute during partial implementation. Acceptance
scenarios and tests SHALL be authored before behavior changes and remain unrun
until all implementation source, migrations and documentation are complete. Final
verification starts only after all nine implementation areas close; release follows
the required checks and CI.

#### Scenario: Only some requirements are implemented
- **WHEN** a subset of the nine areas is ready
- **THEN** changes remain uncommitted and no checks, tests, builds, CI or partial release starts.

#### Scenario: Final verification exposes a defect
- **WHEN** final E2E or CI exposes a meaningful defect
- **THEN** implementation is repaired and affected final checks rerun
- **AND** failing checks are not removed or bypassed to declare completion.

### Requirement 10: Readable typography across dense workspaces
The application SHALL use locally bundled, licensed fonts with Latin and Cyrillic
coverage. Existing Caveat typography SHALL remain on the board, card titles,
company/location/priority/fit values, filters, navigation, forms and application
chrome, including all card notes/body text. Fira Sans SHALL be limited to long
detail descriptions/notes and discussion/chat prose. Fira Code SHALL be limited
to code and `settings.json`.
Font loading, fallback, text scaling and
reduced-motion settings SHALL preserve complete content without clipping or lost
UI, without changing established board styling.

#### Scenario: Dense bilingual board stays readable on desktop and mobile
- **GIVEN** a board with 74 cards containing long Latin and Cyrillic descriptions,
  role/company values and metadata
- **WHEN** the user views and navigates the board at desktop and mobile widths
- **THEN** all rendered card text, metadata, filters and controls retain their
  existing Caveat styling
- **AND** card content and controls remain readable and reachable without overlap
  or horizontal clipping.

#### Scenario: Long details, chat and settings remain readable
- **GIVEN** long bilingual content in card details, chat messages and settings
- **WHEN** the user opens each surface and reads or edits its content
- **THEN** detail descriptions and discussion prose use a proportional face,
  technical values remain monospaced, and long content wraps or scrolls
  within its intended surface
- **AND** labels, actions and content do not collide or disappear.

#### Scenario: Font load is blocked
- **GIVEN** locally bundled font requests fail or the preferred face is unavailable
- **WHEN** the application renders a board and opens a detail surface
- **THEN** system fallbacks keep text and controls visible and usable
- **AND** font failure does not block startup, hide UI or lose entered content.

#### Scenario: Text zoom and reduced motion preserve readability
- **GIVEN** the user enables 200% text zoom and reduced motion
- **WHEN** the user views the board, details, chat and settings
- **THEN** text and controls remain readable and reachable without clipping
- **AND** reduced motion does not suppress status or navigation information.
