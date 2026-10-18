# Coverage and typed lint

## Unit coverage

Run `npm run test:coverage`. Open `coverage/unit/index.html`; machine-readable data is in `coverage/unit/coverage-final.json`, `coverage/unit/coverage-summary.json`, and `coverage/unit/lcov.info`.

V8 coverage includes production TypeScript and Vue under `src`, including files never imported by unit tests. Tests, declarations, test bootstrap, and copied third-party animation code are excluded. This report does not measure E2E execution, Rust, or WASM.

Baseline on 2026-10-02: 754 passing tests, one skipped; statements 47.19%, branches 41.25%, functions 45.77%, lines 51.44%. All 37 Vue files have zero unit execution coverage. Keeping them in the denominator makes the report honest about the scope of the unit suite.

CI runs coverage instead of a second duplicate unit run and uploads the report for 14 days, including failed runs. Initial global floors are statements 47%, branches 41%, functions 45%, lines 51%. These prevent material regression; they are not a claim of adequate product coverage. Increase floors after adding meaningful coverage. Do not reduce them or exclude production files merely to make a run pass.

Keeper pairing has a separate 95% floor for statements, branches, functions, and lines. `src/sync/keeperPairing.test.ts` exercises real controller/service signatures, ownership proof validation, transcript and origin binding, durable provisioning, retry idempotency, activation persistence, and exact removal receipts. The service wire contract retains its published identifiers; application modules and UI use keeper terminology.

## Typed lint

Production rules now reject explicit `any` and unsafe assignment, arguments, calls, member access, and returns. Existing rules also catch floating promises, invalid `await`, misused promises, non-exhaustive switches, excessive complexity/depth/function size, dead code/dependencies, import cycles, architecture violations, duplication, and forbidden AST patterns. TypeScript already uses `strict`.

Unit tests also reject explicit `any`. Unsafe-value and size/complexity rules remain disabled for test files, where malformed runtime fixtures and long acceptance stories are intentional. These test-only exclusions live in `eslint.config.js`; they do not apply to production files.

`npm run quality:lint` runs without a bulk suppression baseline. Fix unsafe values at their source: give JSON and IndexedDB reads an `unknown` boundary, validate external shapes before use, and type internal callbacks and mocks accurately. Do not generate a new `eslint-suppressions.json` or replace findings with unchecked cast chains.

The Markdown component retains a local `vue/no-v-html` exception at its shared parser output. That renderer disables raw HTML; the directive documents the rendering sink rather than permitting unvalidated application HTML. Unused disable directives are errors.

References: [Vitest coverage](https://vitest.dev/guide/coverage.html), [typescript-eslint unsafe values](https://typescript-eslint.io/blog/avoiding-anys/).

## Browser coverage for redundancy review

Run `npm run test:e2e:coverage` for core coverage, or select a smaller candidate group with `TINCANBAN_E2E_COVERAGE=1 npx playwright test --project=core <specs>` followed by `node scripts/e2e-coverage.mjs`. Raw source coverage is attached to each test's output directory; the converter writes `coverage/e2e/index.html` and `coverage/e2e/test-contributions.json`.

The contribution report counts statements uniquely executed by each passed scenario within the selected group. A zero count is a review signal, not proof that the assertions duplicate another test. Failed attempts are excluded from the aggregate. Unimported files are included by the unit report; the browser report lists executed modules only. Do not compare its percentage directly to the unit denominator.

Collection covers the fixture page's main-thread JavaScript in Chromium. It checkpoints before explicit `page.goto` and `page.reload`: despite `resetOnNavigation: false`, Chrome was reporting zero counts for previously executed restore handlers after reload. Each checkpoint is merged into the scenario report. Navigation initiated inside the application has no guaranteed pre-navigation checkpoint. Additional pages, Workers, WASM and CSS are outside this scope. A closed fixture page retains earlier checkpoints, with an `unavailable` notice for its final uncaptured context. The performance benchmark remains uninstrumented because coverage changes execution cost. Keep raw reports from before/after reductions in distinct directories; Playwright clears its output directory between runs.

Reference: [Playwright JavaScript coverage](https://playwright.dev/docs/api/class-coverage).

ESLint's typed rules currently cover `src` production and unit tests. E2E fixtures use the Playwright runner and are not included in the typed `src` lint gate. The browser coverage fixture was separately type-checked; broad E2E typed lint is a separate migration.
