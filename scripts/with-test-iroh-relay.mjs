import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"

const [command, ...args] = process.argv.slice(2)
if (!command) throw new Error("A test command is required")

const reservation = createServer().listen(0, "127.0.0.1")
await once(reservation, "listening")
const { port } = reservation.address()
await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()))

const origin = `http://127.0.0.1:${port}`
const directory = await mkdtemp(join(tmpdir(), "tincanban-iroh-relay-"))
const config = join(directory, "relay.toml")
let relay, stopped
try {
  await writeFile(config, `http_bind_addr = "127.0.0.1:${port}"\nenable_quic_addr_discovery = false\nenable_metrics = false\n`)
  relay = spawn(process.env.TINCANBAN_E2E_IROH_RELAY_BINARY ?? "iroh-relay", ["--dev", "--config-path", config], { stdio: "inherit" })
  stopped = once(relay, "exit")
  void stopped.catch(() => {})
  const deadline = Date.now() + 10_000
  while (true) {
    const ready = await fetch(origin + "/healthz", { signal: AbortSignal.timeout(500) }).then(response => response.ok, () => false)
    if (ready) break
    if (Date.now() >= deadline) throw new Error("The Iroh test relay did not start")
    await Promise.race([delay(100), stopped.then(() => { throw new Error("The Iroh test relay exited before startup") })])
  }

  const child = spawn(command, args, { stdio: "inherit", env: { ...process.env, TINCANBAN_E2E_IROH_RELAY_ORIGIN: origin } })
  const [code] = await once(child, "exit")
  process.exitCode = code ?? 1
} finally {
  if (relay?.pid && relay.exitCode === null && relay.signalCode === null) relay.kill("SIGTERM")
  await stopped?.catch(() => {})
  await rm(directory, { recursive: true, force: true })
}
