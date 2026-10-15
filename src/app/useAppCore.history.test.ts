import { effectScope } from "vue"
import { expect, it, vi } from "vitest"
import type { WorkspaceSetStore } from "../sync/workspaceSet"
const mocks = vi.hoisted(() => ({ readBaseline: vi.fn(), store: undefined as WorkspaceSetStore | undefined }))
vi.mock("../sync/workspacePeerHistorySourceLoader", () => ({ createLazyWorkspacePeerHistorySource: () => ({
  readHistoryBaseline: mocks.readBaseline, readHistoryBaselineDocument: vi.fn(), readHistoryArchiveObject: vi.fn(),
}) }))
vi.mock("../sync/useDeviceSync", async () => {
  const { ref } = await import("vue")
  return { useDeviceSync: (options: { workspaceStore: WorkspaceSetStore }) => {
    mocks.store = options.workspaceStore
    return { ownershipRevision: ref(0) }
  } }
})
vi.mock("../state", async () => {
  const { ref } = await import("vue")
  return { useTincanban: () => ({ ready: ref(false), activeWorkspace: { id: "board" }, docVersion: ref(0),
    availableWorkspaces: ref([]), getCurrentProfile: () => null }) }
})
vi.mock("../chat/service", () => ({ configureChat: vi.fn(), exportChat: vi.fn(), receiveChat: vi.fn(), subscribeChat: vi.fn() }))
vi.mock("../chat/useWorkspaceChat", () => ({ useWorkspaceChat: () => ({}) }))
vi.mock("../sync/useBlindReplication", () => ({ useBlindReplication: () => ({}) }))
vi.mock("./useAppMesh", () => ({ useAppMesh: () => ({}) }))
vi.mock("./useIdentityProfileRecovery", () => ({ useIdentityProfileRecovery: () => ({}) }))
vi.mock("../attachments", () => ({ configureAttachmentFetcher: vi.fn(), readStoredAttachment: vi.fn(), writeStoredAttachment: vi.fn() }))
import { useAppCore } from "./useAppCore"

it("Given two archived generations, when approved enrollment requests the exact predecessor through the app store, then preserve its baseline selector", async () => {
  const scope = effectScope(), ancestorId = "A".repeat(43), ancestor = { baselineId: ancestorId }
  mocks.readBaseline.mockResolvedValue(ancestor)
  try {
    scope.run(() => useAppCore())
    await expect(mocks.store!.readHistoryBaseline!("board", ancestorId)).resolves.toEqual(ancestor)
    expect(mocks.readBaseline).toHaveBeenCalledWith("board", ancestorId)
  } finally { scope.stop() }
})
