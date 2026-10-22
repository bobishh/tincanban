import { defineConfig } from "vite"
import vue from "@vitejs/plugin-vue"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

function buildCommit() {
  try {
    const commit = execFileSync("git", ["rev-parse", "--verify", "HEAD"], { encoding: "utf8" }).trim()
    return /^[0-9a-f]{40}$/i.test(commit) ? commit : "unknown"
  } catch {
    return "unknown"
  }
}

export default defineConfig(({ command }) => ({
  build: {
    manifest: true,
    target: ["chrome107", "edge107", "firefox104", "safari16"],
    minify: "terser",
    terserOptions: { compress: { passes: 2, unsafe: false } },
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: "framework", test: /node_modules\/(?:vue|@vue|zod)\// },
          ],
        },
      },
    },
  },
  worker: { format: "es" },
  resolve: {
    alias: [{
      find: /^@automerge\/automerge$/,
      replacement: fileURLToPath(new URL("./node_modules/@automerge/automerge/dist/mjs/entrypoints/fullfat_base64.js", import.meta.url)),
    }],
  },
  server: process.env.TINCANBAN_E2E_NO_HMR === "1" ? { hmr: false, watch: { ignored: ["**/*"] } } : undefined,
  define: {
    __VUE_OPTIONS_API__: false,
    __TINCANBAN_BUILD_COMMIT__: JSON.stringify(command === "build" ? buildCommit() : "dev"),
    __TINCANBAN_RELEASE_CANDIDATE__: JSON.stringify(command === "build" ? process.env.RELEASE_CANDIDATE_ID ?? "uncoordinated" : "dev"),
  },
  plugins: [
    vue({ template: { compilerOptions: { isCustomElement: (tag) => tag === "berlin-tower" } } }),
    {
      name: "agent-route",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url === "/agent" || req.url === "/agent/") {
            res.writeHead(302, { Location: "/agent/index.html" })
            res.end()
            return
          }
          next()
        })

      },
    },
  ],
}))
