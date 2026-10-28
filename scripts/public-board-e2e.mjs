import { spawn, spawnSync } from "node:child_process"
import { createServer } from "node:net"

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") { server.close(); reject(new Error("Could not allocate test port")); return }
      server.close(error => error ? reject(error) : resolve(address.port))
    })
  })
}

const rustyBinary = process.env.TINCANBAN_RUSTY_BINARY ?? "../mesh-lighthouse/target/debug/mesh-lighthouse"
if (!process.env.TINCANBAN_RUSTY_BINARY) {
  const build = spawnSync("cargo", ["build", "--locked", "--manifest-path", "../mesh-lighthouse/Cargo.toml", "--bin", "mesh-lighthouse"], { stdio: "inherit" })
  if (build.status !== 0) process.exit(build.status ?? 1)
}
const [webPort, keeperPort] = await Promise.all([freePort(), freePort()])
if (webPort === keeperPort) process.exit(1)
const keeperOrigin = `http://127.0.0.1:${keeperPort}`
const previewBuild = process.env.TINCANBAN_PUBLIC_E2E_PREVIEW === "1"
if (previewBuild) {
  const build = spawnSync("npm", ["run", "build"], { stdio: "inherit", env: {
    ...process.env,
    VITE_PUBLIC_BOARD_ORIGIN: keeperOrigin,
    VITE_SYNC_TELEMETRY_URL: "", VITE_SYNC_TELEMETRY_BROWSER_KEY: "",
  } })
  if (build.status !== 0) process.exit(build.status ?? 1)
}
const child = spawn("npx", ["playwright", "test", "--config", "playwright.public-board.config.ts", ...process.argv.slice(2)], {
  stdio: "inherit", env: {
    ...process.env,
    TINCANBAN_PUBLIC_E2E_WEB_PORT: String(webPort),
    TINCANBAN_PUBLIC_E2E_KEEPER_ORIGIN: keeperOrigin,
    TINCANBAN_PUBLIC_E2E_PREVIEW: previewBuild ? "1" : "",
    TINCANBAN_PUBLIC_E2E_KEEPER_PORT: String(keeperPort),
    TINCANBAN_PUBLIC_E2E_OUTPUT_DIR: `test-results/public-board-${keeperPort}`,
    TINCANBAN_RUSTY_BINARY: rustyBinary,
    VITE_SYNC_TELEMETRY_URL: "", VITE_SYNC_TELEMETRY_BROWSER_KEY: "",
  },
})
const exitCode = await new Promise(resolve => child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0))))
process.exit(Number(exitCode))
