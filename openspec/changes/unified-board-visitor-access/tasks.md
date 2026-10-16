## 1. Contract and acceptance

- [x] 1.1 Review this contract against the user's one-board/visitor requirements; supersede conflicting snapshot and separate-renderer documentation.
- [x] 1.2 Author outside-in scenarios for shared visitor UI/settings, live owner/editor/automation writes, withdrawal/recovery, readable private URLs and compact prose. Record source evidence separately from runtime/production evidence.

## 2. One visitor UI

- [x] 2.1 Extract shared board/presentation boundaries without private runtime initialization; reuse the real visitor board, details, files, chat and window components.
- [x] 2.2 Preserve exact board settings, computed summaries and archive/collapse semantics; remove public-specific templates/styles and duplicated presentation logic.
- [ ] 2.3 Prove shared rendering and unavailable/pending states at desktop and phone widths; retain anonymous no-identity/no-private-runtime boundaries.

## 3. One board and automatic delivery

- [x] 3.1 Bind public access to the existing board/access state; retain owner-only enable/disable and current writer/device authorization.
- [x] 3.2 Integrate durable conditional public delivery into all authorized writer paths, including editors and automation; preserve source identity, restart/retry and coherent file manifests.
- [x] 3.3 Implement reader revalidation/subscription with in-place updates, reconnect, error handling and withdrawal clearing; remove manual Update/comparison controls.
- [x] 3.4 Migrate existing public records from actual source settings without duplicate boards, guessed defaults or manual republishing.

## 4. Addresses and typography

- [x] 4.1 Add stable ID-plus-slug URLs to every board; handle private access, reload, switching, Back/Forward, rename, old links and message anchors.
- [x] 4.2 Apply shared compact Fira prose tokens in details/chat; keep Caveat board cards and controls, wrapping and accessibility scaling.
- [x] 4.3 Apply explicit semantic typography to descriptions, chat, quick notes, help/status text and technical metadata; resolve history author/action labels without changing provenance or authorization.
- [ ] 4.4 Remove redundant nested section frames and clarify properties/history/form grouping; verify desktop/mobile separators, scrolling, keyboard focus and pending/error presentation. Keep Rusty runtime failures visible and separately diagnosed.

## 5. Finish and release

- [ ] 5.1 After implementation blocks finish, run focused browser acceptance and required checks; include real editor and automation delivery with owner devices closed, pending/failure/restart and anonymous privacy cases.
- [ ] 5.2 Reconcile product/agent/API documentation and remove obsolete publication-copy behavior; strictly validate OpenSpec.
- [ ] 5.3 Repair any failing asset verification in its owning pipeline; stage all authorized work, commit/push main only when authorized, and release frontend/Worker and Rusty through their separate CI paths. Record each service's release evidence; keep manual phone verification separate.

## Evidence status by layer — 2026-10-16

- **Source implementation:** Owner/editor browser delivery now covers the active
  board and admitted non-active boards; automation Worker delivery persists and
  retries its admitted source. Native policy/writer protocol and coherent
  projection/file handling are present in the working tree. Focused owner/editor,
  Worker restart, and legacy public-record policy-adoption tests pass. Keep final
  browser/native acceptance open until the implementation blocks finish.
- **Local runtime:** Focused unit/type checks have passed in touched areas. Do not
  mark browser acceptance complete or run it until implementation blocks finish.
- **Production:** No per-component artifact verification, deployed release or
  phone check is established. Keep task 5.3 open until its full evidence exists;
  source presence does not satisfy release criteria.
