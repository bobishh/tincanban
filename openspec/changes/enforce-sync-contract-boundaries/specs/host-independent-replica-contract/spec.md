## ADDED Requirements

### Requirement: Independently consumable replica protocol

MetaMesh SHALL expose the common Rusty HTTP, authenticated ciphertext envelope,
receipt and reusable history contracts through public package exports. These
exports SHALL NOT depend on Tincanban source paths, product models or host storage
implementations. Browser and automation SHALL consume those exports while retaining
explicit product admission and workflow adapters.

#### Scenario: A second host consumes the protocol without the browser source tree

- **GIVEN** an independent consumer with only declared MetaMesh packages and host ports
- **WHEN** it compiles and exchanges an encrypted replica through the public exports
- **THEN** no Tincanban `src/`, DOM or browser storage dependency is required
- **AND** the browser and automation pass the same ciphertext, receipt and history vectors.

#### Scenario: Shared I/O does not grant product write authority

- **GIVEN** a valid storage receipt for ciphertext containing a product-unauthorized change
- **WHEN** either host receives that object
- **THEN** receipt validation does not substitute for product admission
- **AND** the unauthorized change is not published as admitted state.

### Requirement: Exact durable outbox across hosts

The shared contract SHALL require durable retention of ciphertext, request ID and
expected revision before upload. It SHALL acknowledge only an exact verified
service receipt and successful host CAS. Host lifetime/authority changes SHALL
prevent stale asynchronous completion from advancing progress.

#### Scenario: An upload outcome is uncertain and the host restarts

- **GIVEN** a retained pending upload and a lost HTTP response
- **WHEN** browser or automation restarts and retries
- **THEN** it sends the same ciphertext and request ID
- **AND** advances acknowledgment only after the matching receipt and durable CAS succeed.

#### Scenario: A receipt is valid for different data

- **GIVEN** a signed receipt with a different scope, epoch, pin, object or request ID
- **WHEN** the host attempts to confirm its pending upload
- **THEN** the shared verifier rejects it
- **AND** the pending upload and cursor remain retryable without replacement.
