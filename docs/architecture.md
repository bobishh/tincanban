# tincanban architecture

tincanban is a local-first board application. Its data model and authorization are
application concerns; shared networking and cryptographic primitives live in
[MetaMesh](https://github.com/bobishh/meta-mesh).

## Boundaries

| Area | Responsibility | Must not substitute for |
| --- | --- | --- |
| Vue components | Presentation, drafts, user events | Authorization or durable storage |
| Application modules (`src/app`) | Compose board, access, chat, and lifecycle operations | A public bag of every state field |
| Domain commands (`src/domain`) | Validate and apply board changes | Transport or peer discovery |
| State/persistence | Serialize local mutations and publish committed state | Permission checks based only on visible buttons |
| Authorization (`src/sync/changeAuthorization.ts`) | Validate local roles and signed incoming changes | Automerge merge semantics |
| Workspace replication (`src/sync`) | Connect tincanban documents and proofs to mesh sessions | Generic product-independent domain rules |
| MetaMesh | Identity, protocol framing, transport, shared runtime state machines | tincanban's card/board UI |

Automerge records concurrent changes. IndexedDB persists snapshots and public
proofs. Live sync exchanges missing document changes; attachments use a separate
content-addressed transfer. Same-device tabs refresh committed state through
browser notifications rather than pretending each tab is a different user.

## Startup is not transport startup

The browser build has separate policy and transport WASM artifacts. Startup loads
policy before validating and hydrating local documents. Policy has no Iroh or
WebRTC dependency. Local-only workspaces do not start a transport node; invitations
and reconnecting known remote devices load the transport artifact when needed.
The access, admission, and scope workers use the same policy entry point.

A failed policy download blocks local access with an explicit runtime error.
A failed transport download leaves local data usable; retrying a network action
can initialize transport after assets become available. Hydration still follows
policy initialization because local authority checks require Rust policy.

Packaging checks and browser acceptance scenarios are tracked in
[policy/transport packaging tasks](../openspec/changes/split-policy-transport-wasm/tasks.md).

## Identity and access

A person owns workspaces. Devices have individual signing keys and certificates.
Enrollment authorizes another device for the same identity without copying the
root private key. Both devices should have the same ordinary workspace rights.
Some recovery paths still depend on the root key; this is a known limitation, not
a deliberate primary-device product role.

A workspace invitation gives another person a scoped role. Owner authority,
transfer history, grants, and revocations persist separately from disposable
connection routes. Do not infer owner rights merely from an imported document's
owner ID. Local creation must establish its authority as part of the application
flow, including a replacement board after the last workspace is deleted.

MetaMesh recovery words wrap a random root key in an encrypted envelope. They do
not independently reconstruct it. tincanban does not yet provide a complete backup,
recovery-envelope export, key rotation, or stolen-device recovery flow.

## Connection protocol

A session authenticates its remote identity and negotiates capabilities. Owner
workspace offers use `mesh-owner-workspace-offer` / `owner-workspace` and are
sent only to a supported same-person session. `mesh-iroh-gossip` carries actual
Iroh gossip packets. These are different messages and have different receivers.
Logs associate session closure and receive failures with a connection, workspace,
and browser instance. One device may have multiple workspace/instance sessions;
a temporary session replacement is not proof of a whole-device network outage.

## Remaining compromises

- The browser runtime and application still share some lifecycle and workspace
  orchestration. A complete product-independent runtime extraction is unfinished.
- Trusted-group succession handles conflicts by pausing writes; it is not a
  Byzantine consensus or stolen-device recovery mechanism.
- There is no permanent hosted replica or account service. Discovery/relay
  infrastructure is still used for connectivity.
- Framework/component tests and browser regressions exercise behavior, but do not
  constitute an independent cryptographic audit.

For a short demonstration, use [the demo guide](demo.md). For the full current
feature/tool catalog, see [the protocol reference](protocol-and-tools.md).

## Workspace commit boundary

Local commands and incoming replication share `withWorkspaceMutation`. Its queue
serializes one workspace in a runtime; the Web Lock
`tincanban-workspace-command:<workspaceId>` serializes independent tabs. The lock
covers loading the durable base, validation, merge, and commit. Browsers with
IndexedDB but no Web Locks reject writes instead of silently accepting unsafe
cross-tab writes. Other workspaces use separate locks.

`WorkspaceStorage.commitWorkspace` writes the snapshot and signed change
authorizations in one IndexedDB transaction. Local commands include their
change bytes, change proof, and transaction receipt in that same transaction.
Signing prepares evidence without publishing it. Reactive state, tab invalidation,
replication notifications, and a successful replication return follow completion
of the transaction. An abort preserves the previous document and proofs.

Pending item moves have a separate in-memory presentation. Stage selection and
board placement update immediately while commands remain serialized against the
durable document. Each completed or failed command removes only its own preview;
later moves remain visible, and failure restores the latest committed placement.
Previews never enter replication, history, or exported documents. Saving remains
visible until commit completes; closing or reloading during a pending write asks
the browser to confirm leaving.

Ordinary local commands extend the saved admission checkpoint when its raw history,
proofs, projection heads, policy build and current authority still match and all
stored changes are admitted. Current access checks remain in place. The new signed
change must depend on the exact admitted frontier; its root and affected-entity
transitions are checked without replaying historical transitions or signatures.
Ambiguous operation targets use a complete check of that one transition. Changed
authority, proofs, policy, missing checkpoints or unresolved history use full causal
admission. Review actions and incoming replication retain full reclassification.
The extended evidence and checkpoint commit atomically with the snapshot and new
proof, so a failed write cannot advance the durable frontier. Reload uses the same
checkpoint. Snapshot serialization, checkpoint hashing and storage still scale
with document/evidence size; this is not a constant-time storage format.

The workspace journal now includes `snapshots` and `authorizations` stores beside
`changes`, `proofs`, and `receipts`. Snapshot records contain catalog metadata,
so a successful document commit does not depend on a second catalog write.
Legacy local snapshots and the separate authorization database remain readable;
the next commit migrates their content into the journal transaction. Legacy
records are retained for recovery. Once an authorization record is migrated,
the journal is authoritative for that workspace.

Rollout requires reloading old tincanban tabs. An old tab holding the previous journal
schema can block its upgrade; the error asks users to close other tabs and reload.
A pre-migration build cannot safely consume new journal snapshots and
authorizations, so rollback requires a compatible reader or exporting workspace
state with its proofs before switching builds. No deployment is implied by this
storage change.

Authorization export still returns the complete history and retains the existing
record/byte limits. Paging, restart-safe transfer cursors, and any authenticated
history checkpoint remain separate protocol work. This commit boundary does not
fix transport timeout causes or establish replication coverage on Keeper.

## Causal write admission

The journal retains raw signed history separately from the authorized document.
New authority evidence reclassifies already-known hashes as well as incoming
changes. A valid old-grant write outside the signed revocation frontier becomes
quarantined; descendants with missing or unadmitted dependencies remain pending.
Invalid signatures and unauthorized visitor writes still reject admission.
Raw history, verified proofs, decisions, and the authorized snapshot commit
atomically before the UI or replication announces success.

The board shows quarantined changes for explicit review. Applying a reviewed edit
creates a new signed command against the current authorized document; it does not
rewrite the original or attach a renewed grant to its old hash. Receiver clocks
and transaction timestamps do not decide write authority.

Match negotiates `causal-write-admission-v1` in both handshake directions. Older
clients must upgrade. Other MetaMesh consumers require their own integration.
The core accepts detached pending change bytes, but Match currently transports
serialized Automerge documents. Its review UI covers pending descendants already
in retained history, without an orphan-byte transport or persistence path.
See [admission policy and limits](../vendor/meta-mesh/docs/causal-admission.md).
