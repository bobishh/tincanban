## ADDED Requirements

### Requirement: Common ingress budget profile

Core framing and browser/native adapters SHALL consume one exported, finite budget
profile covering header, complete frame, payload kind, assembled transfer and
concurrent bytes. The ordinary outer wire budget SHALL be at most 16 MiB and the
header budget at most 4 KiB. Existing stricter per-kind budgets SHALL remain in
force with explicit wire-versus-payload units. Optional caller limits SHALL only
tighten these limits; omission SHALL NOT mean unlimited input.

#### Scenario: A delimiter is missing or the header exceeds its budget

- **GIVEN** a stream with no newline within the allowed header bytes
- **WHEN** browser or native ingress receives it
- **THEN** it stops the read before unbounded buffering or JSON parsing
- **AND** core `inspect` and `decode` independently reject an equivalent supplied slice.

#### Scenario: A payload exceeds its frame-kind limit

- **GIVEN** a control, proof, heartbeat or sync payload one byte over its declared limit
- **WHEN** it enters through a stream or direct core/FFI call
- **THEN** it is rejected before copying/deserializing the entire unchecked payload
- **AND** no workspace, chat, authority or replica progress changes.

#### Scenario: Boundary values agree across hosts

- **GIVEN** shared vectors at limit-minus-one, exact limit and limit-plus-one
- **WHEN** they pass through actual browser WASM and native adapters
- **THEN** both hosts make the same decisions, including framing overhead
- **AND** encoder acceptance never implies an oversized single-frame receiver requirement.

### Requirement: Bounded bulk content without silent loss

Logical history, enrollment and owner-offer content larger than a frame SHALL use
bounded chunks/pages with authenticated transfer binding, aggregate byte/page caps
and a deadline. A 24 MiB logical allowance SHALL NOT authorize a 24 MiB native RPC.
Incompatible peers SHALL receive an explicit limit/capability result; content SHALL
NOT be truncated, partially adopted, or marked durably delivered.

#### Scenario: A legitimate owner offer exceeds the native frame budget

- **GIVEN** authorized logical content above 16 MiB within its declared aggregate allowance
- **WHEN** compatible browser and native peers transfer it
- **THEN** the content is reconstructed from bounded authenticated frames
- **AND** its exact original bytes and evidence are verified before activation
- **WHEN** the peer lacks that bulk capability
- **THEN** the operation fails explicitly before sending an oversized frame and preserves retry state.

### Requirement: Cancellation and peer isolation

Timeouts, oversize input and closed sessions SHALL cancel/reset the underlying
stream and release buffers and processing slots. Per-peer concurrency and aggregate
assembly SHALL be bounded. Errors SHALL expose only safe stage/kind/size metadata.
A bad transfer SHALL NOT poison unrelated peers or require discarding local data.

#### Scenario: A peer never finishes a frame

- **GIVEN** an incomplete frame and a separate healthy authorized peer
- **WHEN** the first frame reaches its deadline or byte budget
- **THEN** the read is canceled, buffers/slots are released and no late result is adopted
- **AND** the healthy peer can still synchronize a valid frame.
