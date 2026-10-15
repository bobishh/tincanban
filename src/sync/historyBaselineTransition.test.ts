import { beforeEach, expect, it, vi } from "vitest"
import { runWorkspaceHistoryBaselineTransition } from "./historyBaselineTransition"

const workspaceId = `workspace-${crypto.randomUUID()}`
const route = { origin: "https://worker.example", workspaceId, definitionId: "definition", executorPersonId: "executor", integrationId: "integration" }
const profile = { identity: { personId: "owner", publicKey: "owner-key", displayName: "Owner" }, device: { deviceId: "device" },
  certificate: {}, privateKeys: {} } as never
const config = { origin: "https://rusty.example", workspaceId, scopeId: "scope", keyEpoch: 1, contentKey: "YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE",
  servicePublicKey: "service-key", policyRevision: 2, readToken: "read", writeToken: "write", cursor: 0, lastUploaded: "" } as never
const head = "a".repeat(64)
const baselineId = "b".repeat(43)

beforeEach(() => { vi.restoreAllMocks() })

it("Given a Worker freeze and published baseline whose activation reply is lost, when owner retries same transition, then journal reuses freeze and baseline and activates exact same ID", async () => {
  const prepare = vi.fn(async () => ({ transitionId: "00000000-0000-4000-8000-000000000001", state: "frozen" as const, sourceHeads: [head] }))
  const drainOwner = vi.fn(async () => {})
  const captureAndPublish = vi.fn(async () => ({ baselineId }))
  const activate = vi.fn().mockRejectedValueOnce(new Error("reply lost")).mockResolvedValueOnce(baselineId)
  const transitionId = "00000000-0000-4000-8000-000000000001"
  const ports = { assertSupported: vi.fn(async () => {}), readPublishedBaseline: vi.fn(async () => ({ baselineId })),
    prepare, drainOwner, captureAndPublish, activate, ensureCurrent: () => {} }
  const input = { profile, config, routes: [route], transitionId, scopeAuthoritySnapshot: { genesis: {} }, ports }

  await expect(runWorkspaceHistoryBaselineTransition(input)).rejects.toThrow("reply lost")
  await expect(runWorkspaceHistoryBaselineTransition(input)).resolves.toEqual({ transitionId, baselineId, workers: 1 })

  expect(prepare).toHaveBeenCalledTimes(1)
  expect(drainOwner).toHaveBeenCalledTimes(2)
  expect(captureAndPublish).toHaveBeenCalledTimes(1)
  expect(activate.mock.calls.map(call => call[2])).toEqual([baselineId, baselineId])
})

it("Given a durable transition for one Worker cohort, when caller changes a route or Rusty scope, then transition refuses to reuse its freeze", async () => {
  const transitionId = crypto.randomUUID()
  const ports = { assertSupported: vi.fn(async () => {}), readPublishedBaseline: vi.fn(async () => ({ baselineId })),
    prepare: vi.fn(async () => ({ transitionId, state: "frozen" as const, sourceHeads: [] })),
    drainOwner: vi.fn(async () => {}), captureAndPublish: vi.fn(async () => ({ baselineId })),
    activate: vi.fn(async () => baselineId), ensureCurrent: () => {} }
  const common = { profile, config, transitionId, scopeAuthoritySnapshot: { genesis: {} }, ports }
  await runWorkspaceHistoryBaselineTransition({ ...common, routes: [route] })
  await expect(runWorkspaceHistoryBaselineTransition({ ...common, routes: [{ ...route, integrationId: "other" }] })).rejects.toThrow(/routes|scope/)
  expect(ports.prepare).toHaveBeenCalledTimes(1)
})

it("Given a published basis with a lost storage-checkpoint reply, when resuming, then preserve the original drained fence before any Worker activation", async () => {
  const transitionId = crypto.randomUUID(), order: string[] = []
  const ports = { assertSupported: vi.fn(async () => {}), readPublishedBaseline: vi.fn(async () => ({ baselineId })),
    prepare: vi.fn(async () => ({ transitionId, state: "frozen" as const, sourceHeads: [] })),
    drainOwner: vi.fn(async () => { order.push("drain") }), captureAndPublish: vi.fn(async () => ({ baselineId })),
    checkpointPublishedBaseline: vi.fn().mockRejectedValueOnce(new Error("checkpoint reply lost")).mockImplementationOnce(async () => { order.push("checkpoint") }),
    activate: vi.fn(async () => { order.push("activate"); return baselineId }), ensureCurrent: () => {} }
  const input = { profile, config, routes: [route], transitionId, scopeAuthoritySnapshot: { genesis: {} }, ports }
  await expect(runWorkspaceHistoryBaselineTransition(input)).rejects.toThrow("checkpoint reply lost")
  expect(ports.activate).not.toHaveBeenCalled()
  await expect(runWorkspaceHistoryBaselineTransition(input)).resolves.toMatchObject({ baselineId })
  expect(ports.drainOwner).toHaveBeenCalledOnce()
  expect(ports.captureAndPublish).toHaveBeenCalledOnce()
  expect(order).toEqual(["drain", "checkpoint", "activate"])
})
