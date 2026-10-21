# Rusty publication owner retention review

## Summary

Scope: Rusty `8530151…` to `ded16d6b8f74cc0ebcc566154a0430e5c85a6f67`, following owner-pin removal in
`4cce540…`. Risk: high, because this chooses the root identity used to authorize
public-board writes. Recommendation: approve the reviewed candidate for CI and
controlled activation. Local durable retry tests and the formerly failing full
native application delivery scenario pass. Production activation subsequently
completed in Rusty deployment 39599470611; health identifies this exact candidate.

| Severity | Open | Corrected before publication |
| --- | --- | --- |
| Critical | 0 | 0 |
| High | 0 | 0 |
| Medium | 0 | 2 |
| Low | 0 | 0 |

Five changed files reviewed, including README and both test files. Three HTTP
owner-lookup callers, one owner-retention commit caller, three management callers
of the changed identity predicate. No removed authorization check accepted as a
replacement for stored owner evidence. Branch coverage percentages were not
measured for this focused review.

| Finding | Status |
| --- | --- |
| Owner identity unavailable for editor delivery after owner publishes without management policy | Reproduced through real HTTP; repair passes the new focused restart scenario |
| Existing-sidecar retry could skip a previously failed directory sync | Corrected; fault injection at owner, management and root directories passes repeated failure, recovery and reopen |
| Requesting editor promoted to board owner | No such fallback accepted in the reviewed candidate |

## Changed paths and history

`git blame` attributes `publication_owner`'s management-record-only lookup to
`4cce540…`. The application native scenario exposes that a supported initial
publication can have no such record. The earlier server HTTP test installed one
before editor delivery, so it did not cover this case.

Reviewed production paths: `src/management.rs` and the publication commit in
`src/blind.rs`; test coverage in `src/publication_security_tests.rs` and
`src/management_tests.rs`, with the README compatibility contract.
`publication_owner` has three HTTP callers: challenge, publication update and
asset staging. The owner-retention write has one publication-commit caller.
`resource_identity_allowed` has three management callers and must also respect
an owner retained before a publication commit.

## Authority and crash checks

- Preserve the publication schema. Store auxiliary evidence under
  `management/publication-owners`, outside the strictly checked publication
  namespace.
- Verify the service signature, exact board ID, root-key hash/person ID, current
  publication controller and agreement with board management evidence.
- Resolve existing authenticated person-management evidence for the stored
  controller when a legacy publication has no sidecar. If no root identity is
  recoverable, require that actual owner to confirm; an editor cannot supply it.
- Write owner evidence only after complete publication authorization, projection,
  source, revision and attachment validation. A forged initial command must not
  reserve the board.
- A crash after owner retention but before publication commit must preserve the
  original owner's retry and reject a different identity's first management
  claim.
- Retrying after a failed file/directory durability step must repeat that step,
  including when the signed sidecar is already visible locally. No receipt may
  imply durability that was not confirmed.

## Concrete adversarial cases

1. An unrelated identity requests an owner challenge or creates management for
   an already published board: reject and retain the original controller.
2. A legitimate editor omits its delivery grant and attempts owner management:
   reject; its grant authorizes only scoped delivery.
3. An attacker copies another board's sidecar, alters its root key or changes its
   signer: reject before treating it as authority.
4. A retained owner exists without its publication after an interrupted commit:
   another identity must not claim management during that window.
5. A directory sync fails after rename and a retry observes the file: continue
   rejecting receipts until the missing durability confirmation succeeds.

## Evidence and limits

The new HTTP test exercises an owner publication with neither board nor person
management policy, full store reopen, editor and automation delivery to revision
two, and rejected foreign owner access. The final server suite reports 109
passing tests, including the signed management/sidecar conflict case.
The previously failing application public-delivery native scenario now passes
unchanged against the repaired binary (3.29 seconds), including lost-response
retry, automation delivery, revocation and withdrawal. Existing eight native
application storage/management/archive scenarios also pass against `4cce540…`.
Their subsequent application CI rerun against `ded16d6b…` passed, including the
public-delivery case (39599019212); the unrelated WebKit enrollment failure kept
the application frontend release from activating.

Live health reports build `ded16d6b8f74cc0ebcc566154a0430e5c85a6f67`, artifact
`36ccd5a726449a72060043f2c079b4076be86364d9aaaceee07a65c73e794e38`,
and the unchanged service identity. Old-binary rollback execution and the live
owner's saved device-removal operation remain unverified. Directory
placement preserves the existing reader schema by inspection; it is not a claim
that an older binary was executed against the new evidence yet.
