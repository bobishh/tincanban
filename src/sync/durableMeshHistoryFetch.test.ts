import { expect, it, vi } from "vitest"
import { MeshNetworkError } from "@meta-uber/mesh-transport"
import { readDurableMeshTransferAuthority } from "./durableMeshTransferAuthority"
vi.mock("./durableMeshTransferAuthority", () => ({ readDurableMeshTransferAuthority: vi.fn() }))
import { DurableMeshSessions } from "./durableMeshSessions"
import { PeerHistoryObjectUnavailableError } from "./peerHistoryTransport"

function fixture() {
  const workspaceId = "workspace", baselineId = "A".repeat(43), objectId = "B".repeat(43)
  const binding = { workspaceId, historyEpoch: 1, indexId: "catalogue", objectKind: "record" as const, partIndex: 0, partCount: 1 }
  const entry = { workspaceId, deviceId: "remote", instanceId: "instance", connectionId: "connection",
    session: { readHistoryObject: vi.fn(async () => new Uint8Array([7])) } }
  const host = Object.create(DurableMeshSessions.prototype)
  host.currentRunId = 4; host.lifecycle = { stopped: false }
  host.sessions = new Map([["session", entry]])
  host.peerKey = () => "session"
  const authority = vi.mocked(readDurableMeshTransferAuthority).mockReset()
  authority.mockResolvedValue({ identity: "identity", credential: "authority", transportSecret: "secret", profile: {} as never })
  return { host, entry, workspaceId, baselineId, objectId, binding, authority }
}

it("Given a reconnected durable mesh session after reload, when requesting archived history, then use that current session without a pairing session", async () => {
  const f = fixture()
  await expect(f.host.fetchHistoryObject(f.workspaceId, f.baselineId, f.objectId, f.binding)).resolves.toEqual(new Uint8Array([7]))
  expect(f.entry.session.readHistoryObject).toHaveBeenCalledWith(f.baselineId, f.objectId, f.binding)
})

it("Given archive access changed during a durable peer read, when bytes arrive, then reject them rather than return or cache stale data", async () => {
  const f = fixture()
  f.authority.mockResolvedValueOnce({ identity: "identity", credential: "old", transportSecret: "secret", profile: {} as never })
  await expect(f.host.fetchHistoryObject(f.workspaceId, f.baselineId, f.objectId, f.binding)).rejects.toThrow(/authority|access/i)
})

it("Given a missing object, when all current durable sessions report unavailable, then return missing coverage but preserve other protocol failures", async () => {
  const f = fixture()
  f.entry.session.readHistoryObject.mockRejectedValue(new PeerHistoryObjectUnavailableError())
  await expect(f.host.fetchHistoryObject(f.workspaceId, f.baselineId, f.objectId, f.binding)).resolves.toBeUndefined()
  f.entry.session.readHistoryObject.mockRejectedValue(new Error("Invalid peer history response"))
  await expect(f.host.fetchHistoryObject(f.workspaceId, f.baselineId, f.objectId, f.binding)).rejects.toThrow("Invalid peer history response")
})

it("Given a peer closes during a read, when its session disappears, then discard late bytes as unavailable coverage", async () => {
  const f = fixture()
  f.entry.session.readHistoryObject.mockImplementation(async () => {
    f.host.sessions.clear()
    return new Uint8Array([9])
  })
  await expect(f.host.fetchHistoryObject(f.workspaceId, f.baselineId, f.objectId, f.binding))
    .rejects.toBeInstanceOf(PeerHistoryObjectUnavailableError)
})

it("Given network loss without an authority change, when reading history, then mark missing while preserving same-text protocol errors", async () => {
  const f = fixture()
  f.entry.session.readHistoryObject.mockRejectedValueOnce(new MeshNetworkError("connection lost"))
  await expect(f.host.fetchHistoryObject(f.workspaceId, f.baselineId, f.objectId, f.binding)).resolves.toBeUndefined()
  f.entry.session.readHistoryObject.mockRejectedValueOnce(new Error("connection lost"))
  await expect(f.host.fetchHistoryObject(f.workspaceId, f.baselineId, f.objectId, f.binding)).rejects.toThrow("connection lost")
})

it("Given two history peers, when the first session closes during its read, then fetch from the other current peer without returning stale bytes", async () => {
  const f = fixture()
  const other = { ...f.entry, deviceId: "other", session: { readHistoryObject: vi.fn(async () => new Uint8Array([8])) } }
  f.host.peerKey = (_workspaceId: string, deviceId: string) => deviceId
  f.host.sessions = new Map([[f.entry.deviceId, f.entry], [other.deviceId, other]])
  f.entry.session.readHistoryObject.mockImplementation(async () => {
    f.host.sessions.delete(f.entry.deviceId)
    return new Uint8Array([9])
  })
  await expect(f.host.fetchHistoryObject(f.workspaceId, f.baselineId, f.objectId, f.binding)).resolves.toEqual(new Uint8Array([8]))
  expect(other.session.readHistoryObject).toHaveBeenCalledOnce()
})

it("Given a disconnected history peer and changed authority, when another peer is available, then reject before asking it for bytes", async () => {
  const f = fixture()
  const other = { ...f.entry, deviceId: "other", session: { readHistoryObject: vi.fn(async () => new Uint8Array([8])) } }
  f.host.peerKey = (_workspaceId: string, deviceId: string) => deviceId
  f.host.sessions = new Map([[f.entry.deviceId, f.entry], [other.deviceId, other]])
  f.entry.session.readHistoryObject.mockImplementation(async () => {
    f.host.sessions.delete(f.entry.deviceId)
    f.authority.mockResolvedValue({ identity: "identity", credential: "revoked", transportSecret: "secret", profile: {} as never })
    throw new MeshNetworkError("connection lost")
  })
  await expect(f.host.fetchHistoryObject(f.workspaceId, f.baselineId, f.objectId, f.binding)).rejects.toThrow(/authority|access/i)
  expect(other.session.readHistoryObject).not.toHaveBeenCalled()
})

it("Given a history peer reconnects during its read, when its replacement is current, then retry that replacement once and discard the old response", async () => {
  const f = fixture()
  const replacement = { ...f.entry, session: { readHistoryObject: vi.fn(async () => new Uint8Array([8])) } }
  f.entry.session.readHistoryObject.mockImplementation(async () => {
    f.host.sessions.set("session", replacement)
    return new Uint8Array([9])
  })
  await expect(f.host.fetchHistoryObject(f.workspaceId, f.baselineId, f.objectId, f.binding)).resolves.toEqual(new Uint8Array([8]))
  expect(replacement.session.readHistoryObject).toHaveBeenCalledOnce()
})

it("Given a history peer keeps reconnecting, when its replacement also closes, then stop without reading a third session", async () => {
  const f = fixture()
  const third = { ...f.entry, session: { readHistoryObject: vi.fn(async () => new Uint8Array([8])) } }
  const replacement = { ...f.entry, session: { readHistoryObject: vi.fn(async () => {
    f.host.sessions.set("session", third)
    throw new MeshNetworkError("connection lost")
  }) } }
  f.entry.session.readHistoryObject.mockImplementation(async () => {
    f.host.sessions.set("session", replacement)
    throw new MeshNetworkError("connection lost")
  })
  await expect(f.host.fetchHistoryObject(f.workspaceId, f.baselineId, f.objectId, f.binding))
    .rejects.toBeInstanceOf(PeerHistoryObjectUnavailableError)
  expect(third.session.readHistoryObject).not.toHaveBeenCalled()
})
