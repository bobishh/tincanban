import { expect, it, vi } from "vitest"
import { AttachmentTransfer } from "./attachmentTransfer"
import { blindHash, blindObjectId, canonicalBlindJson, type BlindAccess } from "./blindClient"
import { encodeBlindBytes, type BlindObject } from "@meta-uber/mesh-replication/rusty-replica"
import { fixture, repository } from "./attachmentTransfer.testSupport"
import { selectWorkspaceAttachmentTransfer } from "./workspaceAttachmentTransfers"
import type { BlindReplicaConfig } from "./blindReplication"

it("Given lost upload confirmation, when durable transfer restarts, then retry identical ciphertext/request and recover a multi-chunk file without its source", async () => {
  const f = await fixture()
  const sender = repository()
  let lost = true
  const upload = vi.fn(async (access: BlindAccess, object: BlindObject, requestId: string) => {
    expect(sender.objects.get(await blindObjectId(object))).toEqual(object)
    const receipt = await f.upload(access, object, requestId)
    if (lost) { lost = false; throw new Error("Lost response") }
    return receipt
  })
  await expect(new AttachmentTransfer(f.scope, f.access, sender.port, async () => {}, { upload, download: f.download })
    .upload(f.descriptor, f.bytes)).rejects.toThrow("Lost response")
  const original = upload.mock.calls[0]!
  const locator = await new AttachmentTransfer(f.scope, f.access, sender.port, async () => {}, { upload, download: f.download })
    .upload(f.descriptor)
  expect(upload.mock.calls[1]).toEqual(original)
  expect(upload.mock.calls.at(-1)?.[1]).toEqual(f.remote.get(locator.manifestId))
  expect(f.remote.size).toBe(3)
  const recipient = repository()
  const received = await new AttachmentTransfer(f.scope, f.access, recipient.port, async () => {},
    { upload: async () => { throw new Error("Source is closed") }, download: f.download }).download(f.descriptor, locator)
  expect(received).toEqual(f.bytes)
  expect(f.download).toHaveBeenCalledTimes(3)
})

it("Given a completed downloaded chunk and network failure, when restarted, then preserve progress and fetch only missing ciphertext", async () => {
  const f = await fixture(), sender = repository(), recipient = repository()
  const locator = await new AttachmentTransfer(f.scope, f.access, sender.port, async () => {}, f).upload(f.descriptor, f.bytes)
  let calls = 0
  const interrupted = vi.fn(async (access: BlindAccess, id: string) => {
    if (++calls === 3) throw new Error("Offline")
    return f.download(access, id)
  })
  await expect(new AttachmentTransfer(f.scope, f.access, recipient.port, async () => {}, { upload: f.upload, download: interrupted })
    .download(f.descriptor, locator)).rejects.toThrow("Offline")
  expect(recipient.objects.size).toBe(2)
  f.download.mockClear()
  expect(await new AttachmentTransfer(f.scope, f.access, recipient.port, async () => {}, f).download(f.descriptor, locator)).toEqual(f.bytes)
  expect(f.download).toHaveBeenCalledTimes(1)
})

it("Given a forged storage receipt, when uploading, then keep durable pending ciphertext and return no confirmed locator", async () => {
  const f = await fixture(), sender = repository()
  const forged = async (access: BlindAccess, object: BlindObject, requestId: string) => ({
    ...await f.upload(access, object, requestId), signature: encodeBlindBytes(new Uint8Array(64)),
  })
  await expect(new AttachmentTransfer(f.scope, f.access, sender.port, async () => {}, { upload: forged, download: f.download })
    .upload(f.descriptor, f.bytes)).rejects.toThrow(/receipt|signature/i)
  expect(sender.objects.size).toBe(3)
  expect(sender.state()?.receipts).toEqual({})
})

it("Given authorization changes during chunk delivery, when transport completes, then publish neither file bytes nor successful progress", async () => {
  const f = await fixture(), sender = repository(), recipient = repository()
  const locator = await new AttachmentTransfer(f.scope, f.access, sender.port, async () => {}, f).upload(f.descriptor, f.bytes)
  let allowed = true
  const download = async (access: BlindAccess, id: string) => {
    const object = await f.download(access, id)
    allowed = false
    return object
  }
  await expect(new AttachmentTransfer(f.scope, f.access, recipient.port, async () => {
    if (!allowed) throw new Error("Device access revoked")
  }, { upload: f.upload, download }).download(f.descriptor, locator)).rejects.toThrow(/revoked/i)
  expect(recipient.objects.size).toBe(0)
})

it("Given a locator for another attachment, when downloading, then reject before reading local objects or making any network request", async () => {
  const f = await fixture(), recipient = repository()
  const object = vi.fn(recipient.port.object)
  await expect(new AttachmentTransfer(f.scope, f.access, { ...recipient.port, object }, async () => {}, f)
    .download(f.descriptor, { version: 1, blobId: `sha256:${"C".repeat(43)}`, transferId: "another-transfer", manifestId: "A".repeat(43) }))
    .rejects.toThrow(/attachment|locator/i)
  expect(object).not.toHaveBeenCalled()
  expect(f.download).not.toHaveBeenCalled()
})

it("Given this engine already confirmed the complete transfer, when polled unchanged, then hash no ciphertext and make no new upload", async () => {
  const f = await fixture(), sender = repository()
  const engine = new AttachmentTransfer(f.scope, f.access, sender.port, async () => {}, f)
  const locator = await engine.upload(f.descriptor, f.bytes)
  f.upload.mockClear()
  const digest = vi.spyOn(crypto.subtle, "digest")
  try {
    expect(await engine.upload(f.descriptor)).toEqual(locator)
    expect(digest).not.toHaveBeenCalled()
    expect(f.upload).not.toHaveBeenCalled()
  } finally { digest.mockRestore() }
})

it("Given a partially confirmed upload, when policy and tokens change, then retain old verified receipts and retry identical pending ciphertext without its source", async () => {
  const f = await fixture(), sender = repository()
  let attempts = 0
  const upload = vi.fn(async (access: BlindAccess, object: BlindObject, requestId: string) => {
    const receipt = await f.upload(access, object, requestId)
    if (++attempts === 2) throw new Error("Second chunk confirmation lost")
    return receipt
  })
  await expect(new AttachmentTransfer(f.scope, f.access, sender.port, async () => {}, { upload, download: f.download })
    .upload(f.descriptor, f.bytes)).rejects.toThrow("confirmation lost")
  const prepared = sender.state()!
  expect(Object.keys(prepared.receipts)).toHaveLength(1)
  const originalPending = upload.mock.calls[1]!
  const storedObjects = structuredClone([...sender.objects])
  f.access.policyRevision = 2
  f.access.readToken = "R".repeat(43)
  f.access.writeToken = "W".repeat(43)
  const locator = await new AttachmentTransfer(f.scope, f.access, sender.port, async () => {}, { upload, download: f.download })
    .upload(f.descriptor)
  expect(locator).toEqual(prepared.locator)
  expect(upload.mock.calls[2]!.slice(1)).toEqual(originalPending.slice(1))
  expect([...sender.objects]).toEqual(storedObjects)
  expect(sender.state()!.objects).toEqual(prepared.objects)
  expect(sender.state()!.receipts[prepared.objects[0]!.objectId]).toEqual(prepared.receipts[prepared.objects[0]!.objectId])
  expect(Object.keys(sender.state()!.receipts)).toHaveLength(prepared.objects.length)
})

it("Given key rotation after a lost chunk reply, When the background adapter resumes without source, Then retain original ciphertext, requests and historical receipts under current access", async () => {
  const f = await fixture(), old = repository(), active = repository()
  let calls = 0
  const upload = vi.fn(async (access: BlindAccess, object: BlindObject, requestId: string) => {
    const receipt = await f.upload(access, object, requestId)
    if (++calls === 2) throw new Error("Confirmation lost before rotation")
    return receipt
  })
  await expect(new AttachmentTransfer(f.scope, f.access, old.port, async () => {}, { upload, download: f.download })
    .upload(f.descriptor, f.bytes)).rejects.toThrow("Confirmation lost before rotation")
  const saved = structuredClone(old.state()!), ciphertext = structuredClone([...old.objects])
  const pending = upload.mock.calls[1]!
  const rotated: BlindReplicaConfig = { ...f.access, purpose: "workspace", workspaceId: f.scope.workspaceId,
    keyEpoch: f.scope.keyEpoch + 1, contentKey: encodeBlindBytes(new Uint8Array(32).fill(91)),
    historicalContentKeys: { [String(f.scope.keyEpoch)]: f.scope.contentKey },
    readToken: encodeBlindBytes(new Uint8Array(32).fill(92)), writeToken: encodeBlindBytes(new Uint8Array(32).fill(93)),
    policyRevision: f.access.policyRevision + 1, cursor: 0, lastUploaded: "" }
  const selected = await selectWorkspaceAttachmentTransfer(rotated, 2,
    async candidate => candidate.keyEpoch === f.scope.keyEpoch ? old.port : active.port, async () => {})
  // Test transport signs new replies under the currently installed server policy.
  Object.assign(f.access, { ...rotated })
  const locator = await new AttachmentTransfer({ workspaceId: rotated.workspaceId, scopeId: rotated.scopeId,
    keyEpoch: selected.config.keyEpoch, contentKey: selected.config.contentKey }, rotated,
  selected.repository, async () => {}, { upload, download: f.download }).upload(f.descriptor)
  expect(selected.prepared).toBe(true)
  expect(locator).toEqual(saved.locator)
  expect(upload.mock.calls[2]!.slice(1)).toEqual(pending.slice(1))
  expect(upload.mock.calls[2]![0]).toMatchObject({ readToken: rotated.readToken, writeToken: rotated.writeToken })
  expect([...old.objects]).toEqual(ciphertext)
  expect(old.state()!.receipts[saved.objects[0]!.objectId]).toEqual(saved.receipts[saved.objects[0]!.objectId])
  expect(active.state()).toBeNull()
})

it("Given an older valid receipt, when it arrives as a new reply under current policy, then reject it instead of treating it as stored historical confirmation", async () => {
  const f = await fixture(), sender = repository()
  await expect(new AttachmentTransfer(f.scope, f.access, sender.port, async () => {}, {
    upload: async () => { throw new Error("Upload interrupted") }, download: f.download,
  }).upload(f.descriptor, f.bytes)).rejects.toThrow("interrupted")
  const prepared = sender.state()!, item = prepared.objects[0]!
  const oldReceipt = await f.sign(sender.objects.get(item.objectId)!, item.requestId)
  f.access.policyRevision = 2
  await expect(new AttachmentTransfer(f.scope, f.access, sender.port, async () => {}, {
    upload: async () => oldReceipt, download: f.download,
  }).upload(f.descriptor)).rejects.toThrow(/receipt/i)
  expect(sender.state()).toEqual(prepared)
})

it("Given a legacy credential-bound journal, when reopened with its original access, then verify and migrate only its binding before continuing", async () => {
  const f = await fixture(), sender = repository()
  await expect(new AttachmentTransfer(f.scope, f.access, sender.port, async () => {}, {
    upload: async () => { throw new Error("Prepared only") }, download: f.download,
  }).upload(f.descriptor, f.bytes)).rejects.toThrow("Prepared only")
  const prepared = sender.state()!
  const legacy = await blindHash(new TextEncoder().encode(canonicalBlindJson([f.scope.workspaceId, f.scope.scopeId,
    f.scope.keyEpoch, f.scope.contentKey, f.access.origin, f.access.servicePublicKey,
    f.access.readToken, f.access.writeToken, f.access.policyRevision])))
  await sender.port.commit(prepared.generation, { ...prepared, generation: prepared.generation + 1, binding: legacy })
  const migrate = vi.fn(sender.port.migrateBinding!)
  const locator = await new AttachmentTransfer(f.scope, f.access, { ...sender.port, migrateBinding: migrate }, async () => {}, f)
    .upload(f.descriptor)
  expect(migrate).toHaveBeenCalledTimes(1)
  expect(locator).toEqual(prepared.locator)
  const adopted = migrate.mock.calls[0]![2]
  expect(adopted.binding).not.toBe(legacy)
  expect({ ...adopted, generation: prepared.generation, binding: prepared.binding }).toEqual(prepared)
})

it("Given a route ticket changes during restart, when retrying an attachment, then reuse the prepared transfer instead of binding progress to the old peer session", async () => {
  const f = await fixture(), sender = repository()
  const original = { ...f.descriptor, ticket: "old-peer-session" }
  const locator = await new AttachmentTransfer(f.scope, f.access, sender.port, async () => {}, f).upload(original, f.bytes)
  f.upload.mockClear()
  expect(await new AttachmentTransfer(f.scope, f.access, sender.port, async () => {}, f)
    .upload({ ...original, ticket: "new-peer-session" })).toEqual(locator)
  expect(f.upload).not.toHaveBeenCalled()
  expect(sender.state()!.descriptor).not.toHaveProperty("ticket")
})

it("Given an older journal retained an expired peer ticket, when migrating and resuming with a new session, then preserve the exact journal and ciphertext without needing the source", async () => {
  const f = await fixture(), sender = repository()
  await expect(new AttachmentTransfer(f.scope, f.access, sender.port, async () => {}, {
    upload: async () => { throw new Error("Prepared only") }, download: f.download,
  }).upload(f.descriptor, f.bytes)).rejects.toThrow("Prepared only")
  const prepared = sender.state()!
  const legacy = await blindHash(new TextEncoder().encode(canonicalBlindJson([f.scope.workspaceId, f.scope.scopeId,
    f.scope.keyEpoch, f.scope.contentKey, f.access.origin, f.access.servicePublicKey,
    f.access.readToken, f.access.writeToken, f.access.policyRevision])))
  const older = { ...prepared, generation: prepared.generation + 1, binding: legacy,
    descriptor: { ...prepared.descriptor, ticket: "expired-session-ticket" } }
  await sender.port.commit(prepared.generation, older)
  const objects = structuredClone([...sender.objects])
  const migrate = vi.fn(sender.port.migrateBinding!)
  const locator = await new AttachmentTransfer(f.scope, f.access, { ...sender.port, migrateBinding: migrate }, async () => {}, f)
    .upload({ ...f.descriptor, ticket: "replacement-session-ticket" })
  expect(locator).toEqual(prepared.locator)
  expect(migrate).toHaveBeenCalledTimes(1)
  const adopted = migrate.mock.calls[0]![2]
  expect({ ...adopted, generation: older.generation, binding: older.binding }).toEqual(older)
  expect([...sender.objects]).toEqual(objects)
  f.upload.mockClear()
  expect(await new AttachmentTransfer(f.scope, f.access, sender.port, async () => {}, f).upload(f.descriptor)).toEqual(locator)
  expect(f.upload).not.toHaveBeenCalled()
})
