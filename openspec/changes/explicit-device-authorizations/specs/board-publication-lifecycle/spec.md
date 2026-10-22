## ADDED Requirements

### Requirement: Owner publication intent survives changes in copy availability
Publication SHALL retain explicit public/private intent separately from verified
receipt/projection and observed availability. Operations SHALL bind exact board,
source, policy and request. Missing copies, unreachable servers or remote status
SHALL NOT rewrite owner intent or trigger automatic publication. Reset generation
SHALL require reviewed continuity. Existing projection, file staging, governance
and bounded automation checks SHALL remain enforced. Anonymous reading SHALL NOT
require Identity, membership or private application startup.

#### Scenario: A confirmed public copy disappears
- **GIVEN** retained public intent and verified publication confirmation
- **WHEN** the server returns missing revision zero or becomes unreachable
- **THEN** confirmation/intent remain retained with unavailable or recovery-needed status
- **AND** no implicit withdrawal or replacement publication is issued.

### Requirement: Withdrawal prevents stale delivery from reestablishing publication
Public/private operations SHALL save intent before effects and verify exact durable
confirmation before claiming completion. Private intent SHALL stop new automatic
public delivery while remote withdrawal remains pending. Confirmed withdrawal or
observed remote tombstone SHALL block stale automatic delivery; a new publication
SHALL require explicit valid owner resolution. Identity/private-data recovery SHALL
NOT publish material. Withdrawal SHALL NOT claim to erase previously downloaded bytes.

#### Scenario: Old delivery resumes after withdrawal
- **GIVEN** explicit private intent and confirmed withdrawal
- **WHEN** a delayed public snapshot, previous retry or recovered private board returns
- **THEN** the old evidence cannot republish content
- **AND** unresolved outcomes remain visible without false claims of remote deletion.
