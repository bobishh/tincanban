import { ref } from "vue"
import { afterEach, expect, it, vi } from "vitest"
import { connectWorkspaceJoin, isWorkspacePairingLocation } from "./workspaceJoinBrowserView"
import * as telemetry from "./telemetry"

const flow = vi.hoisted(() => vi.fn())
vi.mock("./workspaceJoinBrowserFlow", () => ({ connectWorkspaceJoin: flow }))
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })

it("Given a pairing URL, when startup inspects its route, then report route and fragment presence without exporting its URL or secret", () => {
  const record = vi.spyOn(telemetry, "record").mockImplementation(() => {})
  const prepare = vi.fn()
  try {
    expect(isWorkspacePairingLocation("https://example.test/pair#secret=private-invitation", prepare)).toBe(true)
    expect(record).toHaveBeenCalledWith("pairing.route.checked", { phase: "pairing", mode: "fragment_present" })
    expect(isWorkspacePairingLocation("https://example.test/pair", prepare)).toBe(false)
    expect(record).toHaveBeenLastCalledWith("pairing.route.checked", { phase: "pairing", mode: "fragment_absent" })
    expect(JSON.stringify(record.mock.calls)).not.toContain("private-invitation")
    expect(JSON.stringify(record.mock.calls)).not.toContain("https://")
  } finally { record.mockRestore() }
})

it("Given an invitation accepted offline, when connectivity returns, then load the join flow only after showing automatic retry", async () => {
  const network = { onLine: false }
  vi.stubGlobal("navigator", network)
  const step = ref("workspace-guest-waiting")
  const waitToReconnect = vi.fn().mockImplementation(() => {
    expect(step.value).toBe("workspace-reconnecting")
    expect(flow).not.toHaveBeenCalled()
    network.onLine = true
    return Promise.resolve()
  })
  const context = { state: { step }, currentRun: () => 1, waitToReconnect } as unknown as Parameters<typeof connectWorkspaceJoin>[0]
  await connectWorkspaceJoin(context, 1, {} as Parameters<typeof connectWorkspaceJoin>[2])
  expect(waitToReconnect).toHaveBeenCalledOnce()
  expect(flow).toHaveBeenCalledWith(context, 1, {})
})

it("Given an offline join waiting for connectivity, when cancelled, then never start the late join flow", async () => {
  vi.stubGlobal("navigator", { onLine: false })
  let run = 1
  const context = { state: { step: ref("workspace-guest-waiting") }, currentRun: () => run,
    waitToReconnect: () => { run = 2; return Promise.resolve() } } as unknown as Parameters<typeof connectWorkspaceJoin>[0]
  await connectWorkspaceJoin(context, 1, {} as Parameters<typeof connectWorkspaceJoin>[2])
  expect(flow).not.toHaveBeenCalled()
})
