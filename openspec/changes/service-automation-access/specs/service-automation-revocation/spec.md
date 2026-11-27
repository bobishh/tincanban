## ADDED Requirements

### Requirement: Separate owner revocation

A current workspace owner SHALL be able to withdraw a named service grant
through a separate authenticated operation. Issuance, refresh, pause and
connection status SHALL preserve that decision. Revocation SHALL be
idempotent and preserve retained board data, committed work and service
history.

#### Scenario: A revocation response is lost
- **WHEN** the owner retries the same revocation after it was committed
- **THEN** the system returns its committed result with the same grant
  identity and authority generation

#### Scenario: Pause and resume with the same approval
- **WHEN** the service is paused and resumed under an otherwise valid grant
- **THEN** the existing approval and pending work remain recoverable without
  issuing a new owner grant

### Requirement: Withdrawal fences credentials and operations

Every issuance and protected-use gate SHALL reject credentials from a revoked grant.
This includes unexpired credentials and requests cached before the
authoritative revocation was committed.
Renewal SHALL NOT recreate a withdrawn policy. An explicit new owner approval
is required to grant access again.

#### Scenario: An unexpired credential is presented after revocation
- **GIVEN** the service holds an unexpired credential when withdrawal is
  committed
- **WHEN** it presents that credential for a new protected operation or
  requests renewal
- **THEN** the operation is denied and the connection reports revocation

#### Scenario: A revoked participant restarts with stale state
- **WHEN** the participant restarts using retained activation state and an
  earlier credentials response
- **THEN** the revoked grant cannot authorize a new read or write
- **AND** existing accepted board and automation history remain available
  to their authorized owners

#### Scenario: A peer receives a record after the issuer withdrew access
- **GIVEN** Rusty confirmed the exact signature of a service record before withdrawal
- **WHEN** a replica receives the record or a different record with the old credential
- **THEN** only the exact confirmed record can pass the issuer evidence check
- **AND** current workspace authority and causal revocation rules still apply
