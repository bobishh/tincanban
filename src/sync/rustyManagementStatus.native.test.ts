import { spawn, type ChildProcess } from "node:child_process"
import { createServer } from "node:net"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { afterEach, expect, it, vi } from "vitest"
import { IDBFactory } from "fake-indexeddb"
import { resetIdentityStorageForTest } from "../domain/identity"
import { bootstrapConfirmedIdentityFixture } from "./identityAuthority.testSupport"
import { discoverBlindKeeper } from "./blindClient"
import { ensureRustyPersonPolicy, readRustyManagementStatus } from "./rustyManagementClient"
import { enrollmentManagementConflictResolver } from "./enrollmentManagementReconciliation"
import { verifyRustyManagementStatus } from "@meta-uber/mesh-replication/rusty-management"

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); resetIdentityStorageForTest() })

async function nativeService() {
  const listener = createServer()
  await new Promise<void>((accept, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", accept) })
  const address = listener.address()
  if (!address || typeof address === "string") throw new Error("No native status test port")
  await new Promise<void>((accept, reject) => listener.close(error => error ? reject(error) : accept()))
  const directory = await mkdtemp(resolve(tmpdir(), "tincanban-management-status-"))
  const origin = `http://127.0.0.1:${address.port}`
  const child = spawn(resolve(process.cwd(), process.env.TINCANBAN_RUSTY_BINARY ?? "../mesh-lighthouse/target/debug/mesh-lighthouse"),
    [directory, `127.0.0.1:${address.port}`], { env: { ...process.env, RUSTY_PUBLIC_ORIGIN: origin, RUSTY_LOG: "off" }, stdio: "ignore" })
  let spawnError: Error | undefined
  child.once("error", error => { spawnError = error })
  const close = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGINT")
      if (!await waitForExit(child)) { child.kill("SIGTERM"); if (!await waitForExit(child)) throw new Error("Native test service did not stop; preserving state") }
    }
    await rm(directory, { recursive: true, force: true })
  }
  try {
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError
      if (child.exitCode !== null || child.signalCode !== null) throw new Error("Native status test service exited")
      try {
        if ((await fetch(`${origin}/health`, { signal: AbortSignal.timeout(1000) })).ok) return { origin, directory, close }
      } catch { /* Test process has not bound its port yet. */ }
      await delay(100)
    }
    throw new Error("Native status service startup timed out")
  } catch (error) { await close(); throw error }
}

function waitForExit(child: ChildProcess): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); resolve(true) }
    const timer = setTimeout(() => { child.removeListener("exit", done); resolve(false) }, 5000)
    child.once("exit", done)
  })
}

async function policyFiles(directory: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  const walk = async (path: string, prefix = "") => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.name === "status-nonces.json") continue
      if (entry.isDirectory()) await walk(resolve(path, entry.name), `${prefix}${entry.name}/`)
      else result[`${prefix}${entry.name}`] = await readFile(resolve(path, entry.name), "base64")
    }
  }
  await walk(resolve(directory, "management"))
  return result
}

it("Given actual Rusty management policy, when ordinary and prospective enrollment status replies are lost and retried, then verify fresh receipts without changing any control-plane policy", async () => {
  vi.stubGlobal("indexedDB", new IDBFactory())
  resetIdentityStorageForTest()
  const profile = await bootstrapConfirmedIdentityFixture("Native status owner")
  const service = await nativeService()
  try {
    const discovery = await discoverBlindKeeper(service.origin)
    await ensureRustyPersonPolicy(discovery, profile, true, { allowLegacyMigration: true })
    const binding = { origin: service.origin, servicePublicKey: discovery.servicePublicKey,
      resourceKind: "person" as const, resourceId: profile.identity.personId }
    const before = await policyFiles(service.directory), originalFetch = globalThis.fetch
    const requests: Array<{ method: string; url: string; nonce: string }> = []
    let loseNext = true
    vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
      const response = await originalFetch(url, init)
      const body = JSON.parse(String(init?.body))
      requests.push({ method: init?.method ?? "GET", url: String(url), nonce: body.authorization.payload.requestId })
      if (loseNext) { loseNext = false; await response.body?.cancel(); throw new Error("Lost native status response") }
      return response
    })
    await expect(readRustyManagementStatus(binding, profile)).rejects.toThrow(/Lost native status response/i)
    await expect(readRustyManagementStatus(binding, profile)).resolves.toMatchObject({ revision: 1, migrationPending: false })
    resetIdentityStorageForTest()
    const original = await bootstrapConfirmedIdentityFixture("App identity before adoption")
    expect(original.identity.personId).not.toBe(profile.identity.personId)
    const prospective = enrollmentManagementConflictResolver({ profile, certificates: [profile.certificate] }, original, () => {})
    loseNext = true
    await expect(prospective(binding, 1)).rejects.toThrow(/Lost native status response/i)
    const observation = await prospective(binding, 1)
    await expect(verifyRustyManagementStatus(observation.response, binding, { personId: profile.identity.personId,
      deviceId: profile.device.deviceId, resourceKind: "person", resourceId: profile.identity.personId,
      operation: "management.update", minimumRevision: 1 }, observation.authorization)).resolves.toMatchObject({ revision: 1 })
    expect(requests).toHaveLength(4)
    expect(new Set(requests.map(request => request.nonce)).size).toBe(4)
    expect(requests.every(request => request.method === "POST" && request.url.endsWith("/status"))).toBe(true)
    expect(await policyFiles(service.directory)).toEqual(before)
  } finally { await service.close() }
}, 45_000)
