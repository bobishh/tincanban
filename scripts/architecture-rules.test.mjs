import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { createRequire } from "node:module"
import { test } from "node:test"

const root = fileURLToPath(new URL("../", import.meta.url))
const require = createRequire(import.meta.url)
const config = require("../.dependency-cruiser.cjs")

test("Given real imports, when checking architecture, then reject forbidden edges and preserve public interfaces", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tincanban-architecture-"))
  try {
    const files = {
      "tsconfig.app.json": JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext" } }),
      "config.cjs": `module.exports = ${JSON.stringify(config)}`,
      "node_modules/vue/package.json": JSON.stringify({ name: "vue", main: "index.js" }),
      "node_modules/vue/index.js": "export const reactive = value => value",
      "node_modules/@vue/reactivity/package.json": JSON.stringify({ name: "@vue/reactivity", main: "index.js" }),
      "node_modules/@vue/reactivity/index.js": "export const reactive = value => value",
      "node_modules/@meta-uber/mesh-replication/package.json": JSON.stringify({
        name: "@meta-uber/mesh-replication", exports: { "./rusty-scope-authority": "./client.js" },
      }),
      "node_modules/@meta-uber/mesh-replication/client.js": "export const publish = () => {}",
      "src/app/publish.ts": 'export { publish } from "@meta-uber/mesh-replication/rusty-scope-authority"',
      "src/components/publish.ts": 'import { publish } from "@meta-uber/mesh-replication/rusty-scope-authority"; publish()',
      "src/components/allowed.ts": 'import { publish } from "../app/publish"; publish()',
      "src/components/Publish.vue": '<script setup lang="ts">import { publish } from "@meta-uber/mesh-replication/rusty-scope-authority"; publish()</script>',
      "src/domain/vue.ts": 'import { reactive } from "vue"; export const state = reactive({})',
      "src/domain/reactivity.ts": 'import { reactive } from "@vue/reactivity"; export const state = reactive({})',
      "src/domain/indirect.ts": 'export { state } from "./vue"',
      "src/sync/storage.ts": "export const read = () => 1",
      "src/domain/storage.ts": 'export { read } from "../sync/storage"',
      "src/ui/storage.ts": 'export { read } from "../sync/storage"',
      "src/public/publicReaderLeak.ts": 'export { publish } from "../app/publish"',
      "src/cycle/a.ts": 'export { b } from "./b"; export const a = 1',
      "src/cycle/b.ts": 'export { a } from "./a"; export const b = 2',
    }
    for (const [path, source] of Object.entries(files)) {
      await mkdir(dirname(join(directory, path)), { recursive: true })
      await writeFile(join(directory, path), source)
    }
    const result = spawnSync(process.execPath, [join(root, "node_modules/dependency-cruiser/bin/dependency-cruiser.mjs"),
      "src", "--config", "config.cjs", "--output-type", "json"], { cwd: directory, encoding: "utf8" })
    assert.ifError(result.error)
    assert.ok(result.stdout.trim().startsWith("{"), result.stderr)
    const { summary } = JSON.parse(result.stdout)
    const violates = (name, from) => summary.violations.some(row => row.rule.name === name && row.from === from)
    for (const [rule, from] of [
      ["ui-does-not-call-protocol-sdk", "src/components/publish.ts"],
      ["ui-does-not-call-protocol-sdk", "src/components/Publish.vue"],
      ["domain-does-not-initialize-vue", "src/domain/vue.ts"],
      ["domain-does-not-initialize-vue", "src/domain/reactivity.ts"],
      ["domain-does-not-initialize-vue", "src/domain/indirect.ts"],
      ["domain-does-not-depend-on-infrastructure", "src/domain/storage.ts"],
      ["ui-does-not-own-infrastructure", "src/ui/storage.ts"],
      ["public-reader-stays-anonymous", "src/public/publicReaderLeak.ts"],
      ["no-circular", "src/cycle/a.ts"],
    ]) assert.ok(violates(rule, from), `Missing architecture violation: ${rule} from ${from}`)
    for (const from of ["src/app/publish.ts", "src/components/allowed.ts"]) {
      assert.deepEqual(summary.violations.filter(row => row.from === from), [], `Allowed interface rejected: ${from}`)
    }
    assert.equal(summary.violations.some(row => row.rule.name === "no-unresolvable"), false, result.stdout)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
