## Context

The workspace catalog exposes board ID, title, and update time. Owner identity lives in each workspace document. Board discovery preferences belong to the local person and browser.

## Decisions

1. Resolve each selectable board's owner from its stored workspace document. Show current identity name or a known participant name when available; otherwise show a unique short participant identifier.
2. Search title, displayed owner, and owner ID. Mine means owner ID matches current identity; Shared means it does not.
3. Store pinned IDs, pin order, and the five most recently opened IDs in local storage, keyed by current person ID. Missing boards are omitted from display.
4. Preserve existing board switching and keep card search separate from board discovery.
5. Remove legacy bottom padding from floating chat, now that SpatialWindow owns resize controls. Keep message-list overflow so long conversations remain scrollable.

## Validation

Use isolated Playwright on the real route. Verify owner presentation, title and owner search, ownership filters, pin order, recent shortcut, and empty results. Verify empty chat fits its window and long messages scroll inside the message list. Run focused type and lint checks.
