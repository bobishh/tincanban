## 1. Acceptance and migration evidence

- [x] 1.1 Author an acceptance scenario for upgrading an expired Reflux
  participant through the regular connection flow and using it after the
  original expiry with the owner offline.
- [x] 1.2 Verify the existing Rusty storage credential path, signed scope
  support and legacy transition requirements for the Job Hunt connection.

## 2. Shared authority and credential enforcement

- [x] 2.1 Add failing contract tests for the standing grant, exact scope and
  legacy expiry, then implement compatible MetaMesh readers and verifiers.
- [x] 2.2 Add failing native tests for credential issuance, use and rejection
  on wrong binding, expiry, revocation or stale authority. Implement Rusty
  issuance and the SDK client using the current scope and principal gates.
- [x] 2.3 Verify revocation, including a lost response, concurrent use, and a
  restart, through the existing signed revocation operation. Retain compatible
  readers and the admitted history.

## 3. Existing participant upgrade and execution

- [x] 3.1 Implement owner approval of standing access in the normal connection
  flow, bound to the same participant and exact scope. Retire the temporary
  renewal route and its dedicated test.
- [x] 3.2 Prove that the activation upgrade can resume after interruption while
  preserving authorized devices, old ciphertext, pending uploads and retained
  event identities. Fence prior bearer credentials.
- [x] 3.3 Use the credential lifecycle for board reads and writes in the script
  participant and the Worker. Verify expiry between search and publication,
  unavailable issuer recovery, and revocation with a credential in memory.

## 4. Reflux connection status

- [x] 4.1 Persist and project typed, owner-scoped access observations from the
  reaction refresh and board operations. Test expiry, renewal failure,
  revocation, stale observations and recovery.
- [x] 4.2 Verify the edit screen and scheduled run behavior on real routes.
  Confirm the status remains stable during pending and refresh states.

## 5. Release and production recovery

- [x] 5.1 Run the relevant unit, native interoperation, and browser checks
  locally, then release compatible readers, credential enforcement, and the
  connection flow through the project release workflows.
- [ ] 5.2 Confirm the owner can upgrade the existing Job Hunt participant.
  Verify it can renew its credential and read the board, then rerun Job Hunt
  once and verify the run and configured deliveries complete.
