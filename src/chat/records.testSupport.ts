import { canonicalizeJson, type LocalProfile } from "../domain/identity"
import { resolveSigningContext } from "../domain/signingContext"
import type { DeviceCertificate } from "../domain/model"
import { createChatRecord } from "./signing"
import type { ChatAuthority, ChatPayload, ChatRecord } from "./records"
import type { MessageContext } from "./context"

/** Builds signed historical records for tests; production writers must supply live local contexts. */
export async function createChatRecordFixture(profile: LocalProfile, certificates: DeviceCertificate[], authority: ChatAuthority,
  workspaceId: string, kind: ChatPayload["kind"], text: string, revision = 0, context?: MessageContext): Promise<ChatRecord> {
  const authorityRevision = canonicalizeJson({ fixture: true, authority })
  const signingContext = await resolveSigningContext({ profile, certificates, purpose: kind, binding: { workspaceId },
    authorityRevision, current: async () => ({ personId: profile.identity.personId, deviceId: profile.device.deviceId, authorityRevision }),
  })
  const record = await createChatRecord(profile, authority, workspaceId, kind, text, revision, context, signingContext)
  // Some rejection tests intentionally assemble incomplete certificate evidence.
  return { ...record, certificates }
}
