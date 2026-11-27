import { expect, it } from "vitest"
import { createAutomationConnection, parseAutomationConnectionRequest } from "./automationConnection"

const owner = "a".repeat(43)
const intent = "a126f135-cc53-4849-ae8b-404d20759b09"
function request() {
  return { kind: "mesh-reflux-automation-request", version: 1, reflux_origin: "https://reflux.example",
    workflow_slug: "job-search-automation", intent_id: intent, owner_person_id: owner,
    expires_at: Date.now() + 60_000, handoff_code: "b".repeat(43),
    return_to: `https://reflux.example/workflows/job-search-automation?automation_connection=${intent}` }
}

it("Given a connection request, when its origin, lifetime or return path escapes its workflow, then reject before contacting Reflux", () => {
  expect(parseAutomationConnectionRequest(request()).intent_id).toBe(intent)
  for (const changed of [
    { reflux_origin: "http://reflux.example" }, { return_to: "https://elsewhere.example/" },
    { return_to: "https://reflux.example/redirect" }, { expires_at: Date.now() - 1 },
    { expires_at: Date.now() + 16 * 60_000 }, { handoff_code: "short" },
  ]) expect(() => parseAutomationConnectionRequest({ ...request(), ...changed })).toThrow()
})

it("Given activation loses its response, when retried after a client restart, then send the retained packet without issuing another grant", async () => {
  let retained: string | null = null, exports = 0, activations = 0
  const packets: unknown[] = []
  const current = parseAutomationConnectionRequest(request())
  const options = { request: current,
    store: { load: async () => retained, save: async (value: string) => { retained = value } },
    sign: async () => ({ signed: "owner-proof" }),
    fetcher: async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.credentials).toBe("omit")
      expect(init?.redirect).toBe("error")
      const path = new URL(String(input)).pathname
      if (path.endsWith("/resolve")) return Response.json({ integrationId: intent, automationOrigin: "https://reflux.example",
        workflowSlug: current.workflow_slug, workflowTitle: "Job search", ownerPersonId: owner,
        expiresAt: current.expires_at, returnTo: current.return_to,
        configuration: { name: "Job search", type: "job-intake", typeVersion: 2, parameters: { sources: ["website", "email"] } } })
      if (path.endsWith("/enrollment")) return Response.json({ state: "enrolled", integrationId: intent,
        workspaceId: "workspace-1", identity: { integrationId: intent, origin: "https://reflux.example" } })
      if (path.endsWith("/activation")) {
        packets.push(JSON.parse(String(init?.body)).packet)
        if (++activations === 1) throw new TypeError("Network connection lost")
        return Response.json({ state: "active", integrationId: intent, returnTo: current.return_to })
      }
      throw new Error("Unexpected request")
    },
    exportPacket: async () => { exports++; return JSON.stringify({ version: 2, workspaceId: "workspace-1", retainedGrant: exports }) },
  }
  await expect(createAutomationConnection(options).approve(owner, "workspace-1", "reviewed-scope")).rejects.toThrow("Network connection lost")
  expect(retained).toContain("retainedGrant")
  await expect(createAutomationConnection(options).approve(owner, "workspace-1", "changed-scope")).rejects.toThrow(/scope changed/i)
  expect(activations).toBe(1)
  expect(await createAutomationConnection(options).approve(owner, "workspace-1", "reviewed-scope")).toBe(current.return_to)
  expect(exports).toBe(1)
  expect(packets[1]).toEqual(packets[0])
  expect(JSON.parse(retained!)).not.toHaveProperty("packet")
  await expect(createAutomationConnection(options).approve(owner, "different-workspace", "reviewed-scope")).rejects.toThrow(/different board/i)
})

it("Given another Identity is signed in, when approving a workflow connection, then reject before enrollment or grant creation", async () => {
  let requests = 0
  const connection = createAutomationConnection({ request: parseAutomationConnectionRequest(request()),
    fetcher: async () => { requests++; throw new Error("Must not run") },
    store: { load: async () => null, save: async () => {} }, sign: async () => ({}), exportPacket: async () => "{}" })
  await expect(connection.approve("c".repeat(43), "workspace-1", "reviewed-scope")).rejects.toThrow(/workflow owner/i)
  expect(requests).toBe(0)
})

it("Given an existing expired participant, when its owner approves regular connection, then upgrade its exact route and keep the packet after response loss", async () => {
  const existing = { workspaceId: "existing-board", executorPersonId: "d".repeat(43) }
  const current = parseAutomationConnectionRequest({ ...request(),
    return_to: `https://reflux.example/workflows/job-search-automation/edit?automation_connection=${intent}` })
  let saved: string | null = null
  let prepares = 0
  let activations = 0
  const connection = createAutomationConnection({
    request: current,
    store: { load: async () => saved, save: async value => { saved = value } },
    sign: async () => { throw new Error("Existing access uses a signed instance request") },
    exportPacket: async () => { throw new Error("Existing access cannot enroll another participant") },
    existing: {
      async prepare(target, relay) {
        expect(target).toEqual({ ...existing, definitionId: intent, integrationId: intent, origin: "https://reflux.example" })
        await relay("identity", { signed: true }, target)
        prepares++
        return { packet: JSON.stringify({ approved: true }) }
      },
      async activate(target, relay, packet) {
        expect(packet).toEqual({ approved: true })
        await relay("activate", { signed: true }, { ...target, packet })
      },
    },
    fetcher: async (url, init) => {
      const path = new URL(String(url)).pathname
      if (path.endsWith("/resolve")) return Response.json({
        integrationId: intent, automationOrigin: "https://reflux.example", workflowTitle: "Jobs",
        workflowSlug: current.workflow_slug, ownerPersonId: owner, expiresAt: current.expires_at, returnTo: current.return_to,
        configuration: { name: "Jobs", type: "job-intake", typeVersion: 2, parameters: { sources: ["website", "email"] } },
        existing,
      })
      expect(path).toMatch(/\/instance$/)
      const body = JSON.parse(String(init?.body))
      expect(body.handoffCode).toBe(current.handoff_code)
      if (body.action === "activate" && ++activations === 1) throw new TypeError("Response lost")
      return Response.json({ status: "active", synced: true })
    },
  })
  await expect(connection.approve(owner, "another-board", "scope")).rejects.toThrow(/different|existing board/i)
  await expect(connection.approve(owner, existing.workspaceId, "scope")).rejects.toThrow("Response lost")
  expect(await connection.approve(owner, existing.workspaceId, "scope")).toBe(current.return_to)
  expect(prepares).toBe(1)
  expect(activations).toBe(2)
})
