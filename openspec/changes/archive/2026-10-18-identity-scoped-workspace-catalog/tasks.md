# Tasks

- [x] Filter available and archived workspace lists by active personal-root references.
- [x] Prevent startup from adding every local document to the active identity's root.
- [x] Repair mismatched legacy `genesis` refs without deleting local document bytes or explicit invitation refs.
- [x] Register validated workspace invitation memberships in the personal root.
- [x] Add unit checks for identity filtering, visitor refs, legacy root shapes, and stale genesis repair.
- [x] Add and run bounded identity/catalog TLC scenario.
- [x] Pass real device-enrollment BDD for pending and post-adoption catalog scope, local-data preservation, reload, and remote write propagation (focused scoped-enrollment run passed on `0ff`).
- [x] Verify identity replacement preserves the prior workspace bytes while hiding its ID from the replacement identity's catalog/UI; focused existing-identity BDD passed.
- [x] Record a fresh full enrollment BDD pass on the current source after the catalog refresh and owner-offer registration changes (Match run `37577926234`, current source `9df48e7`).
