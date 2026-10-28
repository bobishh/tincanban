import { effectScope } from "vue"
import { expect, it, vi } from "vitest"
import type { WorkspaceSetStore } from "../sync/workspaceSet"
import type * as Authorization from "../sync/changeAuthorization"
const mocks = vi.hoisted(() => ({ readBaseline: vi.fn(), withDoc: vi.fn(), exportBytes: vi.fn(), exportRoot: vi.fn(), store: undefined as WorkspaceSetStore | undefined }))
vi.mock("../sync/changeAuthorization", async original => ({ ...await original<typeof Authorization>(),
  exportAuthorizationBundle: mocks.exportBytes, exportDocumentAuthorizationBundle: mocks.exportRoot,
}))
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
    availableWorkspaces: ref([]), getCurrentProfile: () => null, withWorkspaceDoc: mocks.withDoc }) }
})

it("Given a known scope during typing publication, when authorization is exported, then read current scoped root metadata without decoding the document again", async () => {
  const scope = effectScope(), root = { id: "board", ownerPersonId: "genesis-owner", entities: {} }, bundle = { version: 1 }
  mocks.withDoc.mockImplementation(async (_id, read) => read(root))
  mocks.exportRoot.mockResolvedValue(bundle)
  mocks.exportBytes.mockResolvedValue(bundle)
  mocks.exportRoot.mockClear(); mocks.exportBytes.mockClear(); mocks.withDoc.mockClear()
  try {
    scope.run(() => useAppCore())
    await expect(mocks.store!.readAuthorization!(Uint8Array.of(1), root.id)).resolves.toBe(bundle)
    expect(mocks.withDoc).toHaveBeenCalledWith(root.id, expect.any(Function))
    expect(mocks.exportRoot).toHaveBeenCalledWith({ id: root.id, ownerPersonId: root.ownerPersonId })
    expect(mocks.exportBytes).not.toHaveBeenCalled()
  } finally { scope.stop() }
})

it("Given a scoped document resolves to another board, when authorization is exported, then reject before using its authority", async () => {
  const scope = effectScope()
  mocks.withDoc.mockImplementation(async (_id, read) => read({ id: "different-board", ownerPersonId: "owner" }))
  mocks.exportRoot.mockClear()
  try {
    scope.run(() => useAppCore())
    await expect(mocks.store!.readAuthorization!(Uint8Array.of(1), "requested-board")).rejects.toThrow(/scope|workspace/i)
    expect(mocks.exportRoot).not.toHaveBeenCalled()
  } finally { scope.stop() }
})

it("Given a generic byte-only export caller, when no scope ID is supplied, then preserve the exact-byte export fallback", async () => {
  const scope = effectScope(), bytes = Uint8Array.of(1, 2), bundle = { version: 1 }
  mocks.exportBytes.mockResolvedValue(bundle); mocks.exportBytes.mockClear()
  try {
    scope.run(() => useAppCore())
    await expect(mocks.store!.readAuthorization!(bytes)).resolves.toBe(bundle)
    expect(mocks.exportBytes).toHaveBeenCalledWith(bytes)
  } finally { scope.stop() }
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
