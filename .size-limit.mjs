import { readFileSync } from "node:fs"
import { startupBudgetFiles } from "./scripts/build-budget-files.mjs"

const manifest = JSON.parse(readFileSync(new URL("./dist/.vite/manifest.json", import.meta.url), "utf8"))
const privateStartup = startupBudgetFiles(manifest, "private")
const publicStartup = startupBudgetFiles(manifest, "public")

export default [
  // Stable board routes, public-delivery scheduling and optional OTel admission add 11 kB.
  // Signing, projection, delivery transport and the OTel SDK load on demand.
  // Workspace settings, sync controls and dialog windows add 21 kB to the initial app closure.
  { name: "initial JavaScript (private app and static dependencies)", path: privateStartup.js, limit: "275 kB" },
  // Shared reading typography and window controls fit within 11 kB compressed.
  { name: "application CSS (private app and static dependencies)", path: privateStartup.css, limit: "13 kB" },
  { name: "public reader JavaScript", path: publicStartup.js, limit: "235 kB" },
  // Shared keyboard focus frames add 24 bytes to the previous public CSS budget.
  { name: "public reader CSS", path: publicStartup.css, limit: "10.6 kB" },
  { name: "Markdown renderer (loaded on demand)", path: "dist/assets/MarkdownContent-*.js", limit: "40 kB" },
  { name: "Markdown styles (loaded on demand)", path: "dist/assets/MarkdownContent-*.css", limit: "1 kB" },
  { name: "Automerge WebAssembly", path: "dist/assets/automerge-*.wasm", limit: "1.1 MB" },
  { name: "transport WebAssembly (loaded on network demand)", path: "dist/assets/meta_mesh_bg-*.wasm", limit: "2.3 MB" },
  { name: "policy WebAssembly (required for local access)", path: "dist/assets/meta_mesh_policy_bg-*.wasm", limit: "1.2 MB" },
]
