import { createSSRApp, ref } from "vue"
import { renderToString } from "@vue/server-renderer"
import { expect, it } from "vitest"
import AutomationsPanel from "./AutomationsPanel.vue"
import type { AutomationManagement } from "../app/useAutomations"

it("Given retained email outcomes, When opening automation settings, Then expose connection controls without an accumulating processing feed", async () => {
  const management = { types: ref([]),
    records: ref([{ entity: { id: "automation", executor: { origin: "https://automation.example" } },
      definition: { name: "Job intake", type: "job-intake", typeVersion: 2, parameters: { sources: ["website", "email"] } }, control: { state: "active" } }]),
    busy: ref(false), failure: ref(""), observationErrors: ref({}), storage: ref([]),
    email: ref({ automation: { route: { mailbox: "owner@example.test", address: "private@example.test" }, receipt: {
      events: [{ eventId: "one", subject: "Private retained email", status: "review", createdAt: "2026-10-14", result: { reason: "Needs a match" } }], confirmation: null } } }),
    confirmation: () => true, instanceDescription: () => undefined,
  } as unknown as AutomationManagement
  const html = await renderToString(createSSRApp(AutomationsPanel, { management, owner: true }))
  expect(html).toContain("Forwarding address")
  expect(html).toContain("Pause")
  expect(html).not.toMatch(/Private retained email|Needs a match|Recent email processing|Retry processing|Bind application|Mail received/)
})
