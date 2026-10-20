# Contributor setup and checks

This page holds local setup and verification detail. For the short product
overview, see the [README](../README.md); product behavior and limits live in the
[product guide](product-guide.md).

## Set up a checkout

Requirements: Git and Node.js 22.12 or newer (Node.js 22, 24, or 26+ for
Vitest). Rust is not needed to run tincanban: the pinned MetaMesh submodule
contains the browser JavaScript and WebAssembly, and Automerge ships its compiled
WASM in its npm package.

For an existing checkout:

```sh
git submodule sync --recursive
git submodule update --init --recursive
npm ci
```

Run `npm run dev` and open Vite's printed URL. A second physical device needs a
secure browser context for cryptographic APIs; use the deployed HTTPS demo or
configure local HTTPS. Run `npm run build` to type-check and create `dist/`; use
`npm run preview` to serve that build locally.

MetaMesh is a public repository pinned as a Git submodule. Its packages are
consumed from source, not npm. Contributors changing its Rust runtime can follow
the [WASM build instructions](https://github.com/bobishh/meta-mesh/blob/main/scripts/build-wasm.sh).

## Run checks

[Architecture fitness notes](architecture-fitness.md) list startup and sync
contracts with implementation and bounded formal checks.

```sh
npm run verify:meta-mesh
npm run quality
npm test
npm run test:coverage
npx playwright install chromium
npx playwright test --project=core
```

The core browser project covers local UI and persistence. Network projects use
Iroh connectivity; run focused groups with:

```sh
npx playwright test --project=scoped-enrollment
npx playwright test --project=workspace-roles
npx playwright test --project=workspace-sync-data
npx playwright test --project=durable-mesh
```

See [coverage and typed lint](testing/coverage-and-lint.md) for report files,
regression floors, and lint scope. The [scenario audit](testing/test-suite-audit.md)
records browser-scenario risks. The
[description inventory](testing/test-description-inventory.tsv) covers browser,
application, Worker, SDK, Rust, and formal tests. Regenerate it with:

```sh
npm run --silent test:inventory > docs/testing/test-description-inventory.tsv
```

Parameterized declarations are marked in the inventory; it is not an execution
count. `playwright.config.ts` lists the browser projects.

## Rusty integration checks

`playwright.rusty.config.ts` selects the Rusty connection, mobile, and credential
conflict scenarios. Locally these start the binary at
`../mesh-lighthouse/target/debug/mesh-lighthouse`, or use
`TINCANBAN_RUSTY_BINARY` to select another build. CI checks out a pinned Rusty
revision, builds its binary, and runs dedicated native-storage and browser
scenarios. See the [current CI workflow](../.github/workflows/ci.yml) and the
[Rusty verification reference](https://github.com/bobishh/rusty/blob/main/docs/storage-protocol-and-operations.md#verification).

GitHub CI runs core Chromium tests in four shards, grouped network suites, and
dedicated pinned-Rusty storage and browser checks. See the workflow for its
current matrix. CI configuration describes checks to run; it is not a record
that a particular build passed or that a production deployment occurred. Source
tests, browser acceptance, and each service's deployment have separate evidence.
