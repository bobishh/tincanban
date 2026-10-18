import { nextTick, ref, watch } from "vue"
import { describe, expect, it } from "vitest"
import type { WorkspaceAuthorityRecord, WorkspaceMeshCredential } from "./peerStore"
import { workspaceAuthorityFingerprint } from "./authorityFingerprint"
import { DeviceSyncController } from "./deviceSyncController"
import type { DurableMeshOptions } from "./durableMesh"

describe("mesh policy refresh", () => {
  it("does not reload all nine boards for repeated status notifications, while heartbeat work stays responsive", async () => {
    const workspaces = ref(Array.from({ length: 9 }, (_, index) => ({ id: `board-${index}`, title: `Board ${index}` })))
    const controller = new DeviceSyncController({
      workspace: {} as never,
      workspaceStore: {} as never,
      origin: () => "http://localhost",
      availableWorkspaces: workspaces,
    })
    const sync = controller.api()
    const meshOptions = (controller as unknown as { meshOptions: (store: unknown) => { onChange: NonNullable<DurableMeshOptions["onChange"]> } })
      .meshOptions({})
    const onChange = meshOptions.onChange
    const credential: WorkspaceMeshCredential = {
      version: 1, workspaceId: "board-0", ownerPersonId: "owner", ownerPublicKey: "owner-key",
      transportSecret: "secret", epoch: 1, updatedAt: "today", localGrant: { personId: "local", role: "editor" },
      ownerCertificates: [], catalog: { revocations: [], departures: [], deviceRevocations: [] },
    }
    const authority: WorkspaceAuthorityRecord = {
      version: 1, workspaceId: "board-0", ownerPersonId: "owner", ownerPublicKey: "owner-key",
      epoch: 1, updatedAt: "today", ownerCertificates: [], catalog: credential.catalog,
    }
    const fingerprint = workspaceAuthorityFingerprint([credential], [authority])
    const passes: Promise<void>[] = []
    let boardRoleChecks = 0
    watch(sync.ownershipRevision, () => {
      boardRoleChecks += workspaces.value.length
      passes.push(Promise.all(workspaces.value.map(() => new Promise<void>(resolve => setTimeout(resolve, 25))))
        .then(() => undefined))
    })
    const peers = (online: boolean) => [{ workspaceId: "board-0", personId: "remote", deviceId: "device",
      role: "editor" as const, endpoint: "endpoint", lastSeen: "today", online, instances: 1 }]

    onChange(["board-0"], peers(true), [], [], fingerprint)
    await nextTick()
    expect(boardRoleChecks).toBe(9)
    let heartbeatFired = false
    const heartbeat = new Promise<void>(resolve => setTimeout(() => { heartbeatFired = true; resolve() }, 0))
    for (let round = 0; round < 12; round += 1) onChange(["board-0"], peers(round % 2 === 0), [], [], fingerprint)
    await heartbeat
    expect(heartbeatFired).toBe(true)
    expect(sync.meshPeers.value[0]?.online).toBe(false)
    expect(boardRoleChecks).toBe(9)
    await Promise.all(passes)

    const changed = { ...credential, localGrant: { personId: "local", role: "visitor" } }
    onChange(["board-0"], peers(false), [], [], workspaceAuthorityFingerprint([changed], [authority]))
    await nextTick()
    expect(boardRoleChecks).toBe(18)
    await Promise.all(passes)
    await sync.shutdown()
  })
})
