## Why

Tincanban currently embeds automation management and diagnostics controls. Service login, board membership, service permissions and decryption access need distinct contracts: creating a board must not confer service administration, and a board write grant does not limit what a shared workspace key can decrypt.

## What Changes

- Remove Automation and diagnostics/log-console UI from Tincanban; retain Rusty storage and generic participants/access approval.
- Specify reusable resource connection and service authentication in meta-mesh SDK, built on existing identity, pairing and authority primitives.
- External applications own their Connect board button, workflows, intake, schedules and operational status.
- A connection binds an existing service identity to an owner-approved resource, allowed actions, audience and expiry. No personal private key is transferred.
- **BREAKING**: board Editor rights must not implicitly grant TinSink log-reader rights. Service access requires an explicit service-scoped grant.
- Do not claim restricted board/field reading while exporting a key that decrypts a larger workspace.

## Capabilities

### New Capabilities

- `resource-connection-sdk`: shared connection/approval protocol, proof of possession, grants, cancellation and revocation.
- `service-access-boundaries`: independent service permissions and product UI boundaries.

### Modified Capabilities

None.

## Impact

meta-mesh core and TypeScript/native SDKs; Tincanban participant approval; external Automation/Reflux connection flow; TinSink session and project discovery policies. Existing production identities, encrypted state and pending uploads must remain unchanged. This proposal does not implement the new authorization protocol.
