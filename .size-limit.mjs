import { readFileSync } from "node:fs"
import { startupBudgetFiles } from "./scripts/build-budget-files.mjs"

const manifest = JSON.parse(readFileSync(new URL("./dist/.vite/manifest.json", import.meta.url), "utf8"))
const privateStartup = startupBudgetFiles(manifest, "private")
const publicStartup = startupBudgetFiles(manifest, "public")

export default [
  { name: "initial JavaScript (private app and static dependencies)", path: privateStartup.js, limit: "235 kB" },
  // Include the synchronous startup status/loader; anonymous-reader budget stays separate.
  { name: "application CSS (private app and static dependencies)", path: privateStartup.css, limit: "10.75 kB" },
  { name: "public reader JavaScript", path: publicStartup.js, limit: "235 kB" },
  { name: "public reader CSS", path: publicStartup.css, limit: "10.5 kB" },
  { name: "Markdown renderer (loaded on demand)", path: "dist/assets/MarkdownContent-*.js", limit: "40 kB" },
  { name: "Markdown styles (loaded on demand)", path: "dist/assets/MarkdownContent-*.css", limit: "1 kB" },
  { name: "Automerge WebAssembly", path: "dist/assets/automerge-*.wasm", limit: "1.1 MB" },
  { name: "transport WebAssembly (loaded on network demand)", path: "dist/assets/meta_mesh_bg-*.wasm", limit: "2.3 MB" },
  { name: "policy WebAssembly (required for local access)", path: "dist/assets/meta_mesh_policy_bg-*.wasm", limit: "1.2 MB" },
]
