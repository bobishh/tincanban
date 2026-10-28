import type { createIdentityRegistrationGate } from "./identityRegistrationGate"
import { readLocal } from "../localDb"
import { parsePublicationRecord, publicationRecordKey } from "../domain/publicationState"
import type { LocalProfile } from "../domain/identity"

type RegistrationGate = ReturnType<typeof createIdentityRegistrationGate>
type PublicAccess = {
  origin: { value: string }
  published: { value: boolean }
  revision: { value: number }
  setPublic(enabled: boolean): Promise<void>
}

export function createIdentityOwnerActions(options: {
  gate: RegistrationGate
  portalOrigin: string | null
  publicAccess: PublicAccess
  getProfile(): LocalProfile | null | undefined
  getBoard(): { boardId: string; workspaceId: string; sourceHeads: string[] }
  isOwner(): boolean
  addMyDevice(): Promise<void> | void
  isSyncChooserOpen(): boolean
}) {
  return {
    async setPublic(enabled: boolean): Promise<void> {
      if (!enabled || !options.portalOrigin) return await options.publicAccess.setPublic(enabled)
      await options.gate.run({
        capture: async () => ({ ...options.getBoard(), origin: options.publicAccess.origin.value, enabled }),
        skipRegistration: async (profile, intent) => !await isFirstPublication(profile, options.publicAccess.origin.value, intent,
          options.publicAccess.published.value, options.publicAccess.revision.value),
        assertCurrent: async (_profile, intent) => assertBoardCurrent(options, intent),
        recheckAuthority: async (_profile, intent) => {
          assertBoardCurrent(options, intent)
          if (!options.isOwner()) throw new Error("Board owner access changed during Identity enrollment")
        },
        execute: async (_profile, intent) => {
          await options.publicAccess.setPublic(intent.enabled)
        },
      })
    },
    async addMyDevice(): Promise<void> {
      if (!options.portalOrigin) return await options.addMyDevice()
      await options.gate.run({
        capture: async () => ({ ...options.getBoard() }),
        assertCurrent: async (_profile, intent) => {
          if (!options.isSyncChooserOpen() || options.getBoard().workspaceId !== intent.workspaceId) {
            throw new Error("Sync request changed during Identity enrollment")
          }
        },
        recheckAuthority: async (_profile, intent) => {
          if (!options.isSyncChooserOpen() || options.getBoard().workspaceId !== intent.workspaceId) {
            throw new Error("Sync request changed during Identity enrollment")
          }
        },
        execute: async () => { await options.addMyDevice() },
      })
    },
  }
}

async function isFirstPublication(profile: LocalProfile, origin: string,
  board: { workspaceId: string; boardId: string }, remotelyPublished: boolean, revision: number): Promise<boolean> {
  if (remotelyPublished || revision > 0) return false
  const raw = await readLocal(publicationRecordKey(origin, board.workspaceId, board.boardId, profile))
  return !parsePublicationRecord(raw)
}

function assertBoardCurrent(options: Parameters<typeof createIdentityOwnerActions>[0],
  intent: { boardId: string; workspaceId: string; sourceHeads: string[]; origin: string }) {
  const current = options.getBoard()
  if (options.publicAccess.origin.value !== intent.origin || current.boardId !== intent.boardId || current.workspaceId !== intent.workspaceId ||
      current.sourceHeads.join("\u0000") !== intent.sourceHeads.join("\u0000")) {
    throw new Error("Board changed while Identity enrollment was in progress")
  }
}
