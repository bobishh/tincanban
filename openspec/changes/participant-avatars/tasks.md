## 1. Outer BDD first
- [x] 1.1 Add failing real-route browser scenarios for avatars in chat and participant settings on desktop and narrow portrait.
- [x] 1.2 Cover stable appearance across reload/name changes/devices, same-name participants, and missing-profile offline fallback.
- [x] 1.3 Cover pending/failed send author attribution and unchanged status/draft recovery.

## 2. Default avatars
- [x] 2.1 Define fixed versioned identity hash, bounded feature palette, and illustrated renderer with neutral invalid-ID fallback.
- [x] 2.2 Build accessible shared avatar component using trusted vector primitives and no external requests.
- [x] 2.3 Integrate chat author headers and existing participant lists while preserving names, disambiguation, actions, and presence semantics.
- [x] 2.4 Preserve per-message attribution/status if grouping adjacent messages; expose component for future mention/discussion surfaces without implementing those flows.

## 3. Verification
- [x] 3.1 Pass happy-path and pending/failure browser scenarios with isolated browsers.
- [x] 3.2 Verify deterministic fixtures, invalid-ID fallback, accessible labels, and unchanged existing chat behavior.
- [x] 3.3 Run relevant type/lint/build checks and strict OpenSpec validation.

## 4. Custom photo profiles
- [x] 4.1 Add real-route crop, save, reload, invalid-image, and persistence-failure BDD before UI integration.
- [x] 4.2 Encode bounded metadata-free 128 × 128 WebP/JPEG output and expose crop cancel/error behavior.
- [x] 4.3 Store avatar bytes and timestamp together in per-person Automerge profile entity; support removal.
- [x] 4.4 Enforce own-profile-only changes from verified signed person ID, including visitor grants.
- [x] 4.5 Render shared profile photos in settings, participant lists, and workspace chat with deterministic fallback.
- [x] 4.6 Pass custom-avatar real-route happy path and failure/retry browser scenarios, including peer projection (3/3 focused cases passed).
- [x] 4.7 Pass profile command, visitor security, merge-preservation, type, lint, and OpenSpec checks (prior verify/build passed; current `npm run quality` passed with avatar sources unchanged).

## 5. Production participant preview follow-up
- [x] 5.1 Diagnose the silent photo selection failure: stale crop imports requested removed CSS chunks (production 404). A blocked crop import reproduces the failure; reload recovery and reselect/save now pass. Bo's photo is visible in the supplied 19:46 participant screenshot. Keep old build chunks for seven days and expose crop-loading errors.
- [ ] 5.2 Verify the intended photo in the participant row after reload and on another device; verify fallback after removal or unavailable profile data.
- [x] 5.3 Wrap participant names and device counts without clipping; verify long names and complete device counts at 1280, 390 and 320 pixels.
