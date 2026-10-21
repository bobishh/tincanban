import {
  noUnknown, objectInput, optionalString, requiredString,
  type RegisterTool, type ToolStore,
} from "../webmcpContract"

export async function registerUtilityTools(store: ToolStore, register: RegisterTool): Promise<void> {
  await register({
    name: "get_sync_trace",
    title: "Read sync trace",
    description: "Read this browser's bounded sync event trace and diagnostic export queue/failure status. Does not change connections or workspace data; no collector credentials are returned.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    execute(input) {
      noUnknown(objectInput(input), [])
      return { capturedAt: new Date().toISOString(), events: store.getSyncTrace?.() ?? [], diagnostics: store.getSyncDiagnostics?.() }
    },
  })

  await register({
    name: "list_placement_issues",
    title: "List placement issues",
    description: "List entities that have broken ancestry, cycles, or missing parents needing recovery.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    execute() {
      if (store.placementIssues) {
        const list = Array.isArray(store.placementIssues) ? store.placementIssues : store.placementIssues.value ?? []
        return list.map((item) => ({
          id: item.entity?.id ?? item.id,
          title: item.entity?.title ?? item.title,
          issue: item.issue,
        }))
      }
      return []
    },
  })

  await register({
    name: "create_column",
    title: "Create column",
    description: "Create a new column under the board.",
    inputSchema: {
      type: "object",
      properties: {
        boardId: { type: "string" },
        title: { type: "string" },
        beforeId: { type: ["string", "null"] },
      },
      required: ["boardId", "title"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
    async execute(input) {
      const value = objectInput(input)
      noUnknown(value, ["boardId", "title", "beforeId"])
      const boardId = requiredString(value, "boardId")
      const title = requiredString(value, "title")
      const beforeId = optionalString(value, "beforeId") ?? null

      if (store.executeCommandAsync) {
        await store.executeCommandAsync({ kind: "createColumn", boardId, title, beforeId })
        return { created: true, boardId, title }
      }
      throw new Error("Command execution not supported by store")
    },
  })

  await register({
    name: "send_chat_message",
    title: "Send workspace chat message",
    description: "Send one message to the active workspace chat.",
    inputSchema: {
      type: "object",
      properties: { body: { type: "string" } },
      required: ["body"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
    async execute(input) {
      const value = objectInput(input)
      noUnknown(value, ["body"])
      const body = requiredString(value, "body")
      if ([...body].length > 8000) throw new Error("Message must contain 1–8,000 characters")
      if (!store.sendChatMessage) throw new Error("Workspace chat is not available")
      await store.sendChatMessage(body)
      return { sent: true }
    },
  })
}
