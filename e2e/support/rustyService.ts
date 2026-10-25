import { spawn, type ChildProcess } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

export async function startRustyService(owner: unknown, corsOrigin: string) {
  return startRustyServiceWithEnvironment(corsOrigin, {
    RUSTY_TRUSTED_OWNER: JSON.stringify(owner),
    RUSTY_CORS_ORIGINS: corsOrigin,
  })
}

export async function startIdentityRustyService(corsOrigin: string) {
  const origins = [...new Set([corsOrigin, process.env.IDENTITY_E2E_ORIGIN].filter(Boolean))].join(",")
  return startRustyServiceWithEnvironment(corsOrigin, {
    RUSTY_IDENTITY_AUTHORITY_ENFORCEMENT: "strict",
    RUSTY_CORS_ORIGINS: origins,
  })
}

async function startRustyServiceWithEnvironment(corsOrigin: string, env: Record<string, string>) {
  const directory = await mkdtemp(join(tmpdir(), "rusty-mobile-"))
  let child: ChildProcess
  const origin = await new Promise<string>((ready, reject) => {
    child = spawn(resolve(process.env.TINCANBAN_RUSTY_BINARY ?? "../mesh-lighthouse/target/debug/mesh-lighthouse"), [directory, "127.0.0.1:0"], {
      env,
    })
    const timer = setTimeout(() => reject(new Error("Rusty did not start")), 10_000)
    child.stdout?.on("data", chunk => {
      const address = String(chunk).match(/listening on (127\.0\.0\.1:\d+)/)?.[1]
      if (address) { clearTimeout(timer); ready(`http://${address}`) }
    })
    child.once("error", error => { clearTimeout(timer); reject(error) })
    child.once("exit", code => { clearTimeout(timer); reject(new Error(`Rusty exited ${code}`)) })
  })
  return { origin, close: async () => {
    const exited = new Promise<void>(done => child.once("exit", () => done()))
    child.kill("SIGTERM")
    await exited
    await rm(directory, { recursive: true, force: true })
  } }
}
