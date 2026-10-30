import { expect, it, vi } from "vitest"
import { DurableMeshSessions } from "./durableMeshSessions"
import type { SessionEntry } from "./durableMeshBase"
import type { LocalProfile } from "../domain/identity"
import type { WorkspaceMeshCredential } from "./peerStore"

vi.mock("./durableMeshTransferAuthority", () => ({ readDurableMeshTransferAuthority: async () => ({
  identity: "identity", credential: "authority", transportSecret: "secret",
}) }))
vi.mock("./participantWorkspaceStore", () => ({
  participantWorkspaceSession: (_store: unknown, context: { assertSession(): void }) => ({
    session: { readHistoryObject: async () => { context.assertSession(); return new Uint8Array([9]) } },
    maintenance: {},
  }),
}))

it("Given an authenticated history channel, when its direct session is replaced before reading, then recover through the current channel without returning old bytes", async () => {
  const profile = { identity: { personId: "person" }, device: { deviceId: "local" } } as LocalProfile
  const mesh = new DurableMeshSessions({ transport: {} as never, workspace: {} as never, workspaceStore: {} as never,
    getProfile: async () => profile, store: {} as never })
  const host = mesh as unknown as {
    currentRunId: number; lifecycle: { stopped: boolean }; sessions: Map<string, SessionEntry>
    peerKey(): string
    browserSessions: { host: { create(input: Record<string, unknown>): { session: SessionEntry["session"] } } }
  }
  const lifecycle = host.lifecycle
  host.currentRunId = 4
  host.lifecycle = { stopped: false }
  host.peerKey = () => "session"
  const workspaceId = "workspace", baselineId = "A".repeat(43), objectId = "B".repeat(43)
  const created = host.browserSessions.host.create({ workspaceId, deviceId: "remote", instanceId: "slot",
    remotePersonId: "person", connection: {}, profile, credential: { transportSecret: "secret" } as WorkspaceMeshCredential })
  const read = vi.fn(async () => new Uint8Array([8]))
  const replacement = { workspaceId, session: { readHistoryObject: read } } as unknown as SessionEntry
  const original = { workspaceId, deviceId: "remote", instanceId: "slot", session: {
    readHistoryObject: async (...args: Parameters<NonNullable<SessionEntry["session"]["readHistoryObject"]>>) => {
      host.sessions.set("session", replacement)
      return created.session.readHistoryObject!(...args)
    },
  } } as unknown as SessionEntry
  host.sessions.set("session", original)
  const binding = { workspaceId, historyEpoch: 1, indexId: "catalogue", objectKind: "record" as const, partIndex: 0, partCount: 1 }
  try {
    await expect(mesh.fetchHistoryObject(workspaceId, baselineId, objectId, binding)).resolves.toEqual(new Uint8Array([8]))
    expect(read).toHaveBeenCalledOnce()
  } finally {
    host.sessions.clear()
    host.lifecycle = lifecycle
    await mesh.dispose()
  }
})
