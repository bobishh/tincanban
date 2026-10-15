import assert from "node:assert/strict"
import { test } from "node:test"
import { startupBudgetFiles } from "./build-budget-files.mjs"

const manifest = {
  "index.html": { isEntry: true, file: "assets/index.js", css: ["assets/index.css"], imports: ["shared"], dynamicImports: ["src/App.vue", "src/sync/startupDiagnostics.ts", "src/public/PublicBoardApp.vue"] },
  "src/App.vue": { file: "assets/App.js", css: ["assets/App.css"], imports: ["shared", "private"], dynamicImports: ["markdown"] },
  "src/sync/startupDiagnostics.ts": { file: "assets/diagnostics.js", imports: ["private"] },
  "src/vendor/berlin-tower.js": { file: "assets/berlin-tower.js" },
  "src/public/PublicBoardApp.vue": { file: "assets/PublicBoardApp.js", css: ["assets/public.css"], imports: ["shared"] },
  shared: { file: "assets/shared.js" },
  private: { file: "assets/private.js", imports: ["shared"], css: ["assets/private.css"] },
  markdown: { file: "assets/MarkdownContent.js" },
}

test("Given split startup, When measuring private board startup, Then entry and private static closure are counted once", () => {
  const files = startupBudgetFiles(manifest, "private")
  assert.deepEqual(files.js, ["dist/assets/App.js", "dist/assets/diagnostics.js", "dist/assets/index.js", "dist/assets/private.js", "dist/assets/shared.js"])
  assert.deepEqual(files.css, ["dist/assets/App.css", "dist/assets/index.css", "dist/assets/private.css"])
})

test("Given split startup, When measuring public viewing, Then private and lazy modules are excluded", () => {
  assert.deepEqual(startupBudgetFiles(manifest, "public").js, ["dist/assets/PublicBoardApp.js", "dist/assets/index.js", "dist/assets/shared.js"])
})

test("Given Vite promotes a shared private entry, When its manifest key is hashed, Then the full private startup is still measured", () => {
  const promoted = { ...manifest,
    "index.html": { ...manifest["index.html"], dynamicImports: ["_App-hash.js", "src/sync/startupDiagnostics.ts", "src/public/PublicBoardApp.vue"] },
    "_App-hash.js": { ...manifest["src/App.vue"], name: "App", isDynamicEntry: true },
  }
  delete promoted["src/App.vue"]
  assert.deepEqual(startupBudgetFiles(promoted, "private"), startupBudgetFiles(manifest, "private"))
  assert.throws(() => startupBudgetFiles({ ...promoted,
    "index.html": { ...promoted["index.html"], dynamicImports: [...promoted["index.html"].dynamicImports, "_App-other.js"] },
    "_App-other.js": { ...promoted["_App-hash.js"] },
  }, "private"), /Ambiguous/)
})

test("Given missing or invalid manifest roots, When collecting startup files, Then budget verification fails closed", () => {
  assert.throws(() => startupBudgetFiles({}, "private"), /entry/)
  assert.throws(() => startupBudgetFiles({ "index.html": manifest["index.html"] }, "private"), /Missing/)
  assert.throws(() => startupBudgetFiles({ ...manifest, shared: { file: "../outside.js" } }, "private"), /Unsafe/)
})
