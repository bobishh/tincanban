import type { createWorkspacePeerHistorySource } from "./workspacePeerHistorySource"

/** Archive serving loads only when an authenticated channel requests history. */
export function createLazyWorkspacePeerHistorySource(input: Parameters<typeof createWorkspacePeerHistorySource>[0]): ReturnType<typeof createWorkspacePeerHistorySource> {
  let source: Promise<ReturnType<typeof createWorkspacePeerHistorySource>> | undefined
  let retryImport = false
  const load = () => {
    if (source) return source
    const pending = (retryImport
      ? import("./workspacePeerHistorySource?retry" as "./workspacePeerHistorySource")
      : import("./workspacePeerHistorySource")).then(module => module.createWorkspacePeerHistorySource(input))
    source = pending
    void pending.catch(() => {
      if (source === pending) {
        source = undefined
        retryImport = true
      }
    })
    return pending
  }
  return {
    readHistoryBaseline: async (...args) => (await load()).readHistoryBaseline(...args),
    readHistoryBaselineDocument: async (...args) => (await load()).readHistoryBaselineDocument(...args),
    readHistoryArchiveObject: async (...args) => (await load()).readHistoryArchiveObject(...args),
  }
}
