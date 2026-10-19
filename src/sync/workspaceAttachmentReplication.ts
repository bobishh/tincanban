import type { BlobDescriptor } from "@meta-uber/mesh-blob"
import type { BlobByteSource } from "@meta-uber/mesh-blob/stream"
import type { AttachmentLocator } from "../product-replica"
import type { AttachmentCoverageStatus } from "./attachmentReplicationTypes"

type Guard = () => Promise<void>
export type AttachmentReplicationPorts = {
  list: () => Promise<BlobDescriptor[]>
  locators: () => Promise<AttachmentLocator[]>
  current: Guard
  guard: (descriptor: BlobDescriptor, mode: "read" | "upload") => Promise<Guard>
  prepared: (descriptor: BlobDescriptor) => Promise<boolean>
  local: (descriptor: BlobDescriptor) => Promise<BlobByteSource | undefined>
  upload: (descriptor: BlobDescriptor, source: BlobByteSource | undefined, guard: Guard) => Promise<AttachmentLocator>
  confirm: (descriptor: BlobDescriptor, locator: AttachmentLocator, guard: Guard) => Promise<void>
  publish: (locator: AttachmentLocator) => Promise<void>
  flush: Guard
  supportsCoverage: () => Promise<boolean>
  report: (states: AttachmentCoverageStatus[]) => void
}

const labels: Record<AttachmentCoverageStatus["phase"], string> = {
  checking: "Checking Rusty…", uploading: "Uploading to Rusty…", complete: "Complete on Rusty",
  "missing-source": "File needed to complete backup", incomplete: "Incomplete on Rusty",
  unavailable: "Rusty unavailable — retrying", denied: "File access denied", unsupported: "Rusty upgrade required",
  capacity: "Rusty storage full",
}
const descriptorKey = (descriptor: BlobDescriptor) => JSON.stringify([descriptor.blobId, descriptor.name,
  descriptor.mediaType, descriptor.size, descriptor.hash ?? ""])

/** File work has its own lifetime; callers can schedule it without delaying board metadata. */
export class WorkspaceAttachmentReplication {
  private running?: Promise<void>
  private states = new Map<string, AttachmentCoverageStatus>()
  private complete = new Set<string>()
  constructor(private readonly workspaceId: string, private readonly ports: AttachmentReplicationPorts) {}

  run(): Promise<void> {
    if (this.running) return this.running
    const running = this.pass()
    this.running = running.finally(() => { this.running = undefined })
    return this.running
  }

  private async pass() {
    await this.ports.current()
    const descriptors = structuredClone(await this.ports.list())
    await this.ports.current()
    const keys = new Set(descriptors.map(descriptorKey))
    this.states = new Map([...this.states].filter(([key]) => keys.has(key)))
    this.complete = new Set([...this.complete].filter(key => keys.has(key)))
    const locators = structuredClone(await this.ports.locators())
    await this.ports.current()
    this.ports.report(structuredClone([...this.states.values()]))
    for (const descriptor of descriptors) {
      try { await this.replicate(descriptor, locators) }
      catch (cause) {
        await this.ports.current()
        this.set(descriptor, failurePhase(cause), cause instanceof Error ? cause.message : "File transfer failed. Retry.")
      }
    }
  }

  private set(descriptor: BlobDescriptor, phase: AttachmentCoverageStatus["phase"], error?: string) {
    this.states.set(descriptorKey(descriptor), { workspaceId: this.workspaceId, descriptor: structuredClone(descriptor),
      phase, label: labels[phase], ...(error ? { error } : {}) })
    this.ports.report(structuredClone([...this.states.values()]))
  }

  private async permission(descriptor: BlobDescriptor, mode: "read" | "upload") {
    try {
      const guard = await this.ports.guard(descriptor, mode)
      return async () => {
        try { await guard() }
        catch (cause) { throw Object.assign(new Error("File access is no longer available.", { cause }), { status: 403 }) }
      }
    }
    catch (cause) { throw Object.assign(new Error("File access is no longer available.", { cause }), { status: 403 }) }
  }

  private async replicate(descriptor: BlobDescriptor, locators: AttachmentLocator[]) {
    const guard = await this.permission(descriptor, "read")
    await guard()
    await this.ports.current()
    const key = descriptorKey(descriptor)
    if (this.complete.has(key)) { this.set(descriptor, "complete"); return }
    this.set(descriptor, "checking")
    const known = locators.filter(locator => locator.blobId === descriptor.blobId)
    const prepared = await this.ports.prepared(descriptor)
    await this.ports.current()
    let missing: unknown
    if (known.length) {
      if (await this.ports.supportsCoverage()) {
        for (const locator of known) {
          const result = await this.confirm(descriptor, locator, guard)
          if (result === undefined) return
          missing = result
        }
      } else if (!prepared) { this.set(descriptor, "unsupported"); return }
    }
    const uploadGuard = await this.permission(descriptor, "upload")
    await uploadGuard()
    const source = prepared ? undefined : await this.ports.local(descriptor)
    await this.ports.current()
    await uploadGuard()
    if (!prepared && !source) {
      this.set(descriptor, missing ? failurePhase(missing) : "missing-source",
        missing instanceof Error ? missing.message : undefined)
      return
    }
    this.set(descriptor, "uploading")
    const locator = await this.ports.upload(descriptor, source, uploadGuard)
    await this.ports.current()
    await uploadGuard()
    await this.ports.publish(locator)
    await this.acknowledge(descriptor, uploadGuard)
  }

  private async confirm(descriptor: BlobDescriptor, locator: AttachmentLocator, guard: Guard): Promise<unknown> {
    try {
      await this.ports.confirm(descriptor, locator, guard)
      await this.acknowledge(descriptor, guard)
      return undefined
    } catch (cause) {
      await this.ports.current()
      await guard()
      if (failurePhase(cause) === "denied") throw cause
      return cause ?? new Error("File coverage could not be confirmed.")
    }
  }

  private async acknowledge(descriptor: BlobDescriptor, guard: Guard) {
    await this.ports.current()
    await guard()
    // A durable file must remain discoverable after its source closes.
    await this.ports.flush()
    await this.ports.current()
    await guard()
    this.complete.add(descriptorKey(descriptor))
    this.set(descriptor, "complete")
  }
}

function failurePhase(cause: unknown): AttachmentCoverageStatus["phase"] {
  const status = cause && typeof cause === "object" && "status" in cause ? cause.status : undefined
  if (status === 401 || status === 403) return "denied"
  if (status === 404) return "incomplete"
  if (status === 426 || status === 409) return "unsupported"
  if (status === 507) return "capacity"
  return "unavailable"
}
