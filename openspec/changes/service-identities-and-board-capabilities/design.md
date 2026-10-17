## Context

Verified current behavior:
- TinSink production pins owner person ID `QyfKlOj-8LNclXyOnPsbtudHSTEi7ecyLvFK7HZkRpY`. Certified devices of this identity are operators independently of board metadata.
- TinSink verifies signed device challenges and authority in `sink/identity/src/main.rs`. An unrelated scope creator cannot claim an existing board by copying its ID.
- `console_projects!` currently exposes enabled project metadata to admitted readers; log queries separately filter their board scopes.
- Board Owner/Editor currently implies board log access. This is a service authorization policy, not a property of cryptographic identity.
- The browser identity SDK serializes available root/device private keys as exportable PKCS8 into local storage. This is a concrete key-custody risk under same-origin script compromise; signatures do not solve it.
- Current automation activation exports workspace bytes and storage reading credentials. Its restricted write grant is not restricted decryption.
- Existing meta-mesh provides identity, pairing, signed grants and scope authority; no generic `add_resource`/resource-connection facade was found in the current SDK.

## Decisions

### Shared SDK boundary

Protocol validation and signing rules belong in platform-neutral meta-mesh core. Browser, server and native SDKs expose the same operations over injected transport/storage. Reuse current identity, pairing and grant verification; do not add parallel application-specific auth.

Conceptual operations (names are provisional): register a resource/provider; request access to an existing resource; approve a request; redeem a connection invitation; authorize an operation; revoke a grant. Registering a resource is separate from connecting a subject to an existing resource. A resource descriptor is not a grant.

Applications own their button and resource picker. An optional UI wrapper may invoke the SDK; the protocol has no Vue/React dependency and no built-in board/jobs schema. Tincanban declares its resource IDs and action meanings. Automation/Reflux owns execution, intake and settings. Tincanban hosts only generic participant/resource permission approval.

### User story

1. In Automation choose Connect board. The node already owns a persistent independent identity.
2. The SDK opens the issuer's approval surface in Tincanban.
3. Choose the board; review the exact requesting identity, read disclosure, permitted actions and expiry.
4. Approve. Tincanban signs a grant bound to that subject and resource.
5. Return to Automation; the SDK completes authenticated activation and reports Connected only after acknowledgement.
6. Inspect/revoke the service participant from Tincanban. Configure workflows and intake in Automation/Reflux.

For a CLI `node init -> enter key`, use the same protocol through a short-lived single-use connection code bound to the requesting node public key. The code is not the owner's seed or the permanent board encryption key. Exact text/URI encoding remains a wire-format decision, not an existing API claim.

### Authentication and authorization

Authentication proves possession of a certified device key for an audience-bound, expiring, single-use challenge. It must not send the entire board catalog by default. Login alone grants no project/log/board action.

Authorization verifies an owner-signed resource grant with issuer, subject identity, resource ID, allowed actions, audience, expiry and authority epoch. Validate at every privileged operation, including retries and cached results. Foreign genesis, stale epoch, changed subject, wrong audience and revoked devices/grants fail closed. Explicit service operator configuration is distinct from ownership of a user-created board.

Read/write/intake/log access are distinct capabilities. Public intake can submit bounded input to an external workflow without receiving board reading credentials or direct CRDT writing rights. A node may accept grants from several independent owners without creating a new identity per connection.

### Key material

A public identity key/fingerprint identifies the subject; a device certificate authenticates its device; a signed grant conveys authority; a symmetric content key decrypts data. These are not interchangeable strings. Personal root/device private keys never enter another service's setup form or shared CRDT.

Deliver private bootstrap material only through an authenticated encrypted channel bound to the approved node. Public signed grants may be replicated; secret keys/tokens may not. If a resource is not cryptographically isolated, disclose the actual larger read scope or reject the narrower request. Do not promise field-only reading using a whole-workspace key.

### Revocation and custody

Services need a trusted way to observe current authority and bound stale authorization; copying an old signed CRDT snapshot is insufficient. The implementation must define and test freshness/expiry behavior before claiming prompt revocation. Revocation stops future authorized operations and delivery; it cannot erase plaintext already received.

Root custody hardening is a separate explicit implementation task: routine login signs through certified device capabilities, with protected root recovery/administration. Changing exportability requires recovery and browser/native evidence, not a claim that existing local storage is protected.

## Delivery scope

UI removal is authorized now. The generic SDK protocol, TinSink authorization policy change, read-scope isolation and root custody changes remain proposed work, not silently deployed changes. Preserve existing identity, grants and pending ciphertext during the transition; no automatic identity regeneration or blanket data migration.
