# unified-board-visitor-access

One board, shared visitor UI, live public access, preserved presentation settings and readable URLs for every board

## Evidence status — 2026-10-16

- **Source:** Shared visitor presentation, board addressing, selected-board
  projection and native/Worker writer paths are present in the working tree.
  Focused source checks exist; final integrated acceptance remains pending.
- **Local runtime:** Focused unit and type checks have passed for touched source
  areas. Browser acceptance remains deferred until implementation blocks finish.
- **Production:** No production artifact verification, deployed release or phone
  verification is established by this change. Frontend/Worker and Rusty releases
  run through separate owning pipelines; no cross-service release cohort is
  required.

Keep these evidence layers separate. Source code and unit tests do not prove that
public delivery works across owner/editor/automation writers or that production
serves the matching artifacts.

Public publication remains stored in Rusty's separate public namespace; it is not
a new backend service. Configure `VITE_PUBLIC_BOARD_ORIGIN` for the Rusty HTTPS
origin. App/Worker CI and Rusty CI release independently. TinSink diagnostics are
optional and use their own service pipeline. The reported WASM termination remains
an open diagnosis; do not claim it fixed.

Related diagnostics work: [standard observability](../standard-observability/tasks.md).
