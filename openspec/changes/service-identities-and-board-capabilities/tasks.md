## 1. Product boundary
- [x] Author browser acceptance for settings without service consoles and with Rusty retained.
- [x] Remove Automation and diagnostic/log panels plus their background UI polling.
- [x] Remove obsolete tests of the removed embedded automation UI; retain service/API integration and signing/approval tests.
- [ ] Pass CI and confirm frontend deployment for the UI removal.

## 2. Shared SDK design and implementation
- [ ] Review resource/grant wire contract and freshness model before implementation.
- [ ] Implement shared core operations and browser/server/native SDK facade using existing identity/pairing/authority.
- [ ] Implement issuer-owned generic approval and external Connect board UI through the SDK.
- [ ] Implement identity-bound CLI single-use connection-code redemption.
- [ ] Prove cancellation, lost-response retry, wrong subject/audience, replay, expiry and revocation behavior.

## 3. Service authorization and keys
- [ ] Replace implicit board-role log access with explicit service grants; scope project discovery.
- [ ] Specify and implement actual read-resource isolation or explicit wider-scope consent.
- [ ] Specify root custody/recovery hardening and device capability limits.
- [ ] Verify independent services never receive owner private keys or secrets through shared CRDT.
- [ ] Roll out through CI with existing node identities and pending data retained.
