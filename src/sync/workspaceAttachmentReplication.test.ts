import { expect, it, vi } from "vitest"
import { createBlobDescriptor } from "@meta-uber/mesh-blob"
import type { AttachmentLocator } from "../product-replica"
import type { AttachmentCoverageStatus } from "./attachmentReplicationTypes"
import { WorkspaceAttachmentReplication, type AttachmentReplicationPorts } from "./workspaceAttachmentReplication"

async function fixture() {
  const descriptor = await createBlobDescriptor(new Uint8Array([1, 2, 3]), "proof.txt", "text/plain")
  const locator: AttachmentLocator = { version: 1, blobId: descriptor.blobId, transferId: "file-transfer", manifestId: "A".repeat(43) }
  const reports: AttachmentCoverageStatus[][] = []
  const guard = vi.fn(async () => {})
  async function* source() { yield new Uint8Array([1, 2, 3]) }
  const localSource = source()
  const ports: AttachmentReplicationPorts = {
    list: vi.fn(async () => [descriptor]), locators: vi.fn(async () => []),
    guard: vi.fn(async () => guard), current: vi.fn(async () => {}),
    prepared: vi.fn(async () => false), local: vi.fn(async () => localSource),
    upload: vi.fn(async () => locator), confirm: vi.fn(async () => {}),
    publish: vi.fn(async () => {}), flush: vi.fn(async () => {}), supportsCoverage: vi.fn(async () => true),
    report: states => reports.push(structuredClone(states)),
  }
  return { descriptor, locator, ports, guard, reports, localSource, runtime: new WorkspaceAttachmentReplication("workspace", ports) }
}

it("Given a local attachment, when background replication runs, then publish complete only after blob receipts and acknowledged locator discovery", async () => {
  const f = await fixture()
  let release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  f.ports.flush = vi.fn(async () => { await barrier })
  const running = f.runtime.run()
  await vi.waitFor(() => expect(f.ports.flush).toHaveBeenCalledOnce())
  expect(f.ports.upload).toHaveBeenCalledWith(f.descriptor, f.localSource, expect.any(Function))
  expect(f.ports.publish).toHaveBeenCalledWith(f.locator)
  expect(f.reports.flat().some(state => state.phase === "complete")).toBe(false)
  release()
  await running
  expect(f.reports.at(-1)?.[0]).toMatchObject({ workspaceId: "workspace", phase: "complete", label: "Complete on Rusty" })
  vi.mocked(f.ports.local).mockClear(); vi.mocked(f.ports.upload).mockClear()
  await f.runtime.run()
  expect(f.ports.local).not.toHaveBeenCalled()
  expect(f.ports.upload).not.toHaveBeenCalled()
  expect(f.guard).toHaveBeenCalled()
})

it("Given a prepared transfer without source bytes, when retrying, then reuse its journal and never read the original file", async () => {
  const f = await fixture()
  f.ports.prepared = vi.fn(async () => true)
  f.ports.local = vi.fn(async () => { throw new Error("Source closed") })
  await f.runtime.run()
  expect(f.ports.local).not.toHaveBeenCalled()
  expect(f.ports.upload).toHaveBeenCalledWith(f.descriptor, undefined, expect.any(Function))
  expect(f.reports.at(-1)?.[0]?.phase).toBe("complete")
})

it("Given a cold recipient with a known locator, when its read-only proof succeeds, then require neither local bytes nor upload permission", async () => {
  const f = await fixture()
  f.ports.locators = vi.fn(async () => [f.locator])
  await f.runtime.run()
  expect(f.ports.confirm).toHaveBeenCalledWith(f.descriptor, f.locator, expect.any(Function))
  expect(f.ports.guard).toHaveBeenCalledWith(f.descriptor, "read")
  expect(f.ports.guard).not.toHaveBeenCalledWith(f.descriptor, "upload")
  expect(f.ports.upload).not.toHaveBeenCalled()
  expect(f.ports.local).not.toHaveBeenCalled()
  expect(f.reports.at(-1)?.[0]?.phase).toBe("complete")
})

it("Given a missing source and no prepared transfer, when a pass runs, then preserve metadata and report missing bytes without claiming complete", async () => {
  const f = await fixture()
  f.ports.local = vi.fn(async () => undefined)
  await f.runtime.run()
  expect(f.ports.upload).not.toHaveBeenCalled()
  expect(f.ports.publish).not.toHaveBeenCalled()
  expect(f.reports.at(-1)?.[0]?.phase).toBe("missing-source")
})

it.each([[403, "denied"], [404, "incomplete"], [426, "unsupported"], [507, "capacity"], [503, "unavailable"]] as const)(
  "Given a %s file failure, when replicating, then keep the corresponding %s state and allow a later retry", async (status, phase) => {
    const f = await fixture()
    f.ports.upload = vi.fn(async () => { throw Object.assign(new Error("File transfer failed"), { status }) })
    await f.runtime.run()
    expect(f.reports.at(-1)?.[0]?.phase).toBe(phase)
    expect(f.ports.publish).not.toHaveBeenCalled()
    f.ports.upload = vi.fn(async () => f.locator)
    await f.runtime.run()
    expect(f.reports.at(-1)?.[0]?.phase).toBe("complete")
  })

it("Given a locator on an older service, when coverage cannot be confirmed, then do not equate its presence with a durable backup", async () => {
  const f = await fixture()
  f.ports.locators = vi.fn(async () => [f.locator])
  f.ports.supportsCoverage = vi.fn(async () => false)
  f.ports.local = vi.fn(async () => undefined)
  await f.runtime.run()
  expect(f.ports.confirm).not.toHaveBeenCalled()
  expect(f.reports.at(-1)?.[0]?.phase).toBe("unsupported")
})

it("Given a changed identity during delivery, when late completion arrives, then publish no locator or completion status", async () => {
  const f = await fixture()
  let current = true
  f.ports.current = async () => { if (!current) throw new Error("Identity changed") }
  f.ports.upload = async () => { current = false; return f.locator }
  await expect(f.runtime.run()).rejects.toThrow("Identity changed")
  expect(f.ports.publish).not.toHaveBeenCalled()
  expect(f.reports.flat().some(state => state.phase === "complete")).toBe(false)
})

it("Given concurrent background ticks, when one transfer is pending, then share one pass without duplicate uploads", async () => {
  const f = await fixture()
  let release!: () => void
  f.ports.upload = vi.fn(async () => { await new Promise<void>(resolve => { release = resolve }); return f.locator })
  const first = f.runtime.run()
  await vi.waitFor(() => expect(f.ports.upload).toHaveBeenCalledOnce())
  const second = f.runtime.run()
  release()
  await Promise.all([first, second])
  expect(f.ports.upload).toHaveBeenCalledOnce()
})

it("Given device permission is revoked during an upload, when its reply arrives, then report denied and never publish discovery", async () => {
  const f = await fixture()
  let allowed = true
  f.ports.guard = async () => async () => { if (!allowed) throw new Error("Workspace signing permission is revoked") }
  f.ports.upload = async () => { allowed = false; return f.locator }
  await f.runtime.run()
  expect(f.reports.at(-1)?.[0]?.phase).toBe("denied")
  expect(f.ports.publish).not.toHaveBeenCalled()
})

it("Given encrypted bytes are durable but index delivery fails, when retrying without the source, then recover discovery before reporting complete", async () => {
  const f = await fixture()
  let prepared = false
  f.ports.prepared = async () => prepared
  f.ports.upload = async () => { prepared = true; return f.locator }
  f.ports.flush = async () => { throw new Error("Index delivery failed") }
  await f.runtime.run()
  expect(f.reports.at(-1)?.[0]?.phase).toBe("unavailable")
  expect(f.reports.flat().some(state => state.phase === "complete")).toBe(false)
  expect(f.ports.local).toHaveBeenCalledOnce()
  f.ports.flush = async () => {}
  await f.runtime.run()
  expect(f.ports.local).toHaveBeenCalledOnce()
  expect(f.reports.at(-1)?.[0]?.phase).toBe("complete")
})
