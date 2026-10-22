# Target specification: shared identity in a local-first ecosystem

## 1. Product boundaries

Identity is the domain name used in this specification, not a selected product
brand. The ecosystem contains user applications and reusable infrastructure:

| Product or module | Owns | Does not acquire through login |
| --- | --- | --- |
| Identity domain in MetaMesh | Person identity, device authorizations, profile and recovery rules | Board ownership or service operator rights |
| Independent static Identity portal | Common sign-in, profile/device management and recovery UI | Direct access to another site's browser storage |
| Tincanban | Boards, content, membership/governance, publication and `.tincanban` files | Authority to replace a participant's identity |
| TinSink, Reflux and other applications | Their functions, sessions, data and service permissions | Universal rights attached to a person ID |
| Rusty | Encrypted replica storage, scoped access, durable receipts and public-copy hosting | Board content editing or decryption of private objects |
| MetaMesh SDK/runtime | Shared identity, verification, transport and replication mechanisms | Product-specific job-search or application-source policies |

The portal has its own repository and static build. Reuse the existing UI/CSS;
no new visual system is part of the change. Identity workflows can also be shown
inside applications. Opening a device dialog in Tincanban does not make board
membership and device identity the same domain operation.

## 2. Local work and account onboarding

Opening Tincanban immediately provides a local board. Existing SDK local signing
state may be generated automatically; no account, profile form, portal visit,
recovery acknowledgement or file download precedes first use. The local signing
identity already establishes the local board's technical owner.

Show adjacent sign-in and profile-creation actions; their final brand labels are
outside this specification. Explicit profile creation completes onboarding for
that same local identity, connects the portal, and associates its own local boards.
It does not generate a replacement person ID, rewrite signed history, publish board
contents or acquire ownership of foreign boards.

| User action | Required behavior |
| --- | --- |
| Open or edit a local board | Work immediately without account onboarding or live Identity checks |
| Create a profile | Keep the current local person and board data; explicitly enroll a new portal device under that person |
| Sign in to the same existing person | Enroll this application's device with that person; adopt only the approved identity and certificate for the exact local device key |
| Sign in to a different person | Show incoming person ID and known affected local boards; replace only after explicit consent, keep original profile bytes and board storage, and offer `.tincanban` export/import |
| Add own device or participant without a portal-connected profile | Complete the matching device enrollment first, then resume the captured action after authority checks |
| First public sharing without a portal-connected profile | Complete profile creation, recheck publication authority, then request explicit publication |
| Cancel or fail onboarding | Keep local editing and original data; issue no invitation, grant or public delivery |
| Use an already-shared board | Preserve its current access, editing and enrollment paths during staged adoption |
| Invite an existing participant | Use the participant's existing identity; grant only the selected board rights |

Cancelled publication onboarding also issues no public delivery. Existing already-shared boards keep their supported access and enrollment paths
until their replacement is verified. Introducing optional account UI must not force
all existing users through a new account gate in the first deployment.

## 3. Browser bootstrap and common login

IndexedDB/localStorage belong to each origin. The portal cannot discover or read
Tincanban's stored identity. Shared parent-domain cookies are not required.

There are two explicit device-enrollment directions. For profile creation from a
local Tincanban identity, Tincanban remains the person and root-key authority. The
portal generates only its own device key; the user approves that exact key under
the current local person. The portal adopts the same person and certificate chain
without creating a second root. For sign-in to an existing portal identity,
Tincanban generates its own device key; the portal approves that exact key and
Tincanban adopts only the returned person, key and certificate chain after explicit
consent. Each origin keeps its own private device key. Both directions bind the
invitation, selected person, device key, purpose and deadline. A connection that
does not finish remains retryable. A different person is a conflict, not a merge;
preserve the local identity and use an explicit `.tincanban` export/import when the
user chooses to switch.

Later, TinSink or another application opens the portal with a fresh, short-lived
origin-bound challenge. The user selects/confirms a profile. The application
verifies the response and establishes its own session. Ordinary login returns
identity, device certificates and a short-lived signed proof only; it creates no
local device authorization and grants no board or identity-management rights.
Verify exact message origin, source window, pending request and expiry. Never fall
back silently to a weaker protocol. No root or device private key travels through
an ordinary login URL or response. Device enrollment remains a separate, explicit
workflow with its own consent and certificate issuance.

A service-session login need not create a device capable of editing boards.
Existing board/service rights are checked separately. TinSink log-reader rights,
Reflux workspace rights and Rusty resource-management rights remain product-owned.
After initial portal connection, common login does not require Tincanban open.
A fresh browser needs device approval or recovery; Rusty cannot bootstrap a person
from no identifier, key or approval.

Use a visible navigation/window for initial browser connection. Do not depend on
hidden third-party iframe storage. A first-time unavailable portal leaves local
work usable; retry uses the same local identity. Cached portal assets can support
local workflows offline, but remote application functions still need their server.

## 4. Independent meshes

| Mesh | Replicated state | Authority |
| --- | --- | --- |
| Personal Identity mesh | Profile and signed device enrollments, delegations and withdrawals | Explicit identity-management rights |
| Application data mesh | The resource's content, membership/governance and required proof material | That resource's owner/member policy |

Separate their keys and membership. Reuse transport connections, storage mechanics
and sync engine where possible; a domain boundary does not demand another server,
connection or database. An ordinary application signing key does not automatically
receive identity-management or device-enrollment rights. Resource peers receive
only the identity evidence needed for their access, not the user's private profile
or list of other boards. Root private keys are not ordinary broadcast mesh state.

Each replica retains sufficient verified authority for local operation. Board
open/edit/save/sign and available-file reads never wait for the Identity mesh,
a portal session or token refresh. An expired login proof does not expire a
separately issued local authorization. Identity changes and withdrawals propagate
through signed synchronization and are applied when learned.

No partitioned system can promise instantaneous global offline revocation.
Concurrent add/remove operations need deterministic causal rules, not wall-clock
last-writer-wins. Retain original evidence and distinguish current authority from
historically admitted work. These semantics are shared SDK contracts, not rules
reimplemented independently by every application.

## 5. Profile, devices and recovery

Profile name/photo have one signed causal source of truth in Identity. Board/chat
copies are projections. Move the existing conflict model rather than introduce a
second mutable profile authority. Treat a physical device label separately from
its app-origin signing keys and their individual permissions.

The person/root authority creates 12 or 24 recovery words and an encrypted identity
recovery file with the existing SDK format. Words unlock the matching file; words
alone do not derive the identity. Recovery restores the same person and portable
profile with a fresh device key, not a copied old device key. A rootless portal
device cannot create replacement root-recovery words from its delegated key. If
the user separately approves transferring full recovery material during the
secret-bound device-enrollment flow, the encrypted file may be retained by the
portal and the words may be shown transiently for the user to save. The words must
not be persisted beside the file, copied into the Identity mesh or logged. This
transfer grants full root-recovery authority and requires recipient consent signed
into the enrollment request plus explicit sender consent before disclosure. An
opted-out request receives no recovery file or words. Once disclosed, full recovery
authority cannot be recalled; cancellation cannot reverse that disclosure. Device
enrollment alone does not imply recovery transfer. Wrong words, damaged files, cancelled
replacement or partial writes preserve prior state. The final identity file
extension is not a selected brand or protocol requirement.

The portal is the ordinary identity export/import UI; Tincanban retains board
files only after the replacement works. Root recovery material stays separate
from ordinary login and replica signing. A delegated signing certificate alone
cannot recreate the root. Changing recovery words rewraps the same root; it is
not root-compromise recovery.

An added device receives explicit person authority from an authorized existing
device or root recovery. Board membership remains unchanged; board restrictions
and missing storage material can still prevent access. No live owner device is
required after valid participant delegation and decryption material were delivered.

Before a device operation replaces a different current identity, show locally
known affected board names and count, retained access and unknown outcomes. Require
explicit confirmation. Do not delete original boards. The list covers this local
replica, not an invented global inventory. Choosing an existing account does not
silently transfer board ownership; such a transfer must satisfy board governance.

## 6. Authorization and board ownership

| Concept | Meaning |
| --- | --- |
| Person | Stable cryptographic identity; profile edits do not change it |
| Device key | Signing-key identity, not a permission or proof of a unique physical device |
| Authorization | Exact signed issuer/subject/resource/rights with a fresh authorization ID |
| Membership | A person's particular board grant, role and governance lineage |
| Storage connection | Accepted service pin/generation, scope policy and encrypted key delivery |

A new explicit authorization has a new ID. Retrying its issuance retains its
original ID. Withdrawal permanently targets that exact authorization. Re-adding
the same key issues new rights; it never restores old rights, signatures or jobs.
Select proofs by exact authorization ID/hash rather than first matching device ID.

An authorization declares its delegation power. A withdrawn issuer cannot mint
new accepted children beyond its admitted frontier. Revocation scope explicitly
identifies affected existing descendants; independently issued child rights are
not silently assumed revoked or preserved by an unspecified cascade rule. Show
the scope during compromise review. Copies of one private key are indistinguishable;
compromise response needs a fresh key, not just another certificate for the old key.

Board commands bind exact actor authorization and membership evidence. Local
verification checks person rights, board membership, board-specific device
restrictions and applicable owner/quorum rules. Recovery cannot undo another
owner's removal, ownership transfer or quorum. Self-device withdrawal does not
require owning every board the person participates in.

Historical commands retain their original proofs and causal frontier. Current
rights cannot authorize an old rejected signature. Preserve quarantined originals;
explicitly reapplying old intent creates a new command under current authority.
Old withdrawal evidence remains where needed to prevent replay and verify history;
an active set of current rights must not become an endlessly growing list of
restorable deleted device identities.

## 7. Rusty connections and storage continuity

Rusty serves independent resource owners without a global owner pin. Its hosting
of an encrypted Identity replica does not grant access to application replicas.
Application sessions and Identity portal availability are not prerequisites for
ordinary authorized storage operations.

For each newly created Rusty storage scope, persist a random generation before
signing evidence. Normal restart retains it; fresh/reset storage gets a new one
even with the same service key. Compare revisions only within the same origin,
service identity, generation and resource. New request proofs, credentials,
receipts and ciphertext AAD bind that generation; original objects keep their old
readers and envelopes.

A new generation requires explicit signed continuity approval by the relevant
person or board owner/quorum. Bind predecessor, successor, scope, rights, credential
commitments and operation ID. Server status cannot approve continuity. Conflicting
successors remain a conflict; known newer evidence cannot be rolled back. No
protocol detects an unseen rollback when every available witness is equally old.

On private routes using this model, verify current scoped device/resource authorization
for reads, writes, inventory, blobs, archives, checkpoints, management and retries.
Bearer secrets alone are insufficient. Owners provision eligible participants
through retained delegation and encrypted key delivery: editors read/append,
visitors read, with owners offline. Missing keys stay pending. Participants receive
no private-person settings or owner-management powers.

Routine withdrawal must not require rotating unrelated scopes or Workers. Rotation
for future-content secrecy after compromise remains a separate operation; neither
revocation nor rotation erases plaintext or keys already obtained.

## 8. Public boards

Publication owns three separate facts: the owner's public/private decision, the
verified delivered projection/receipt, and observed remote availability. Retain
exact board/source/policy binding and pending operation before effects.

| Event | Result |
| --- | --- |
| Owner approves publication | Save exact intent, stage only approved public material, verify confirmation |
| Server loses the public copy or returns missing revision zero | Retain prior intent/receipt; show unavailable or recovery-needed; do not auto-publish |
| Owner requests private access | Stop new automatic public deliveries; retain withdrawal pending remote confirmation |
| Withdrawal confirms | Retain tombstone/evidence; delayed snapshots and retries cannot republish |
| Identity or private board recovers | Recover private data; produce no publication command |

A remote observation does not rewrite the owner's decision. Remote withdrawal
blocks automatic delivery pending explicit owner resolution. Preserve selected
projection/file policy, owner/quorum proof and bounded automation permissions.
Anonymous public reading needs no account, Identity mesh or private app startup.
Withdrawal stops future served reads; it cannot recall previously downloaded bytes.

## 9. Durable effects and consistency

Each domain owns its allowed transition, authority and completion. Save immutable
intent, stable operation ID, exact payload/ciphertext, target and authority/version
preconditions before sending. Retrying reuses these values. Verify durable server
confirmation for that exact operation before atomically publishing local effects.
Retain uncertain effects through restart and use authenticated result lookup before
renewing an expired attempt. Attempt renewal does not create another logical effect.

Independent resources have independent confirmed child outcomes. Partial completion
is not a distributed transaction or global success. Repositories persist valid
plans and CAS conditions; they do not select authority winners, enroll devices or
parse another domain's private operation journals. Shared delivery mechanics are
not a universal authorization/recovery manager.

## 10. Independent delivery and content transfer

1. Extend the already separate MetaMesh identity package additively. Pin tested SDK
   revisions and shared browser/native protocol vectors. Keep current board formats,
   certificate verification and storage behavior.
2. Deliver the independent portal: profile/recovery, device enrollment, independent
   Identity replication and cross-origin common login. Login does not transfer boards.
3. Add login to TinSink, then Reflux alongside existing supported entry points.
   Configure service permissions explicitly for the selected identity; login itself
   neither transfers operator ownership nor replaces scoped board-log authority.
4. Connect Rusty user-facing management where applicable. Preserve existing storage
   scopes, bearer material, pins and receipts. Newly created scopes use the target
   generation and device-authorization rules.
5. Add optional account actions and resumable invitation onboarding to Tincanban.
   Preserve immediate local use, supported existing collaboration and anonymous
   public routes. Remove superseded recovery UI after replacement is usable.
For existing board content, users may export `.tincanban`, create a fresh profile,
then import the files as new boards. Import preserves board content while assigning
new board identities; it does not promise old person/board IDs, memberships, public
URLs, storage policies or complete signed-history continuity. Source boards and
files remain intact until the user separately removes them. Configure new
service/operator rights, board connections and publication explicitly.

Same-person continuity uses the separate explicit device-enrollment and recovery
flows above. Neither content import nor identity recovery silently activates
resource permissions. Retain original credentials, history, attachments and
unresolved operations under their current owners while obligations remain. Existing
scopes keep their current behavior; new scopes use the target authority and
generation rules.

Publication fixes can ship independently. Product-specific policy relocation is a
separate change. No rollout here requires deleting working crypto, board commands,
replication or history modules. Production deployment and destructive data changes
are separate authorized actions, not effects of updating this specification.
