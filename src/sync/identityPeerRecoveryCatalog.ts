import { z } from "zod"
import { invitationUrl, parseInvitation, type DeviceEnrollmentInvitation } from "@meta-uber/mesh-pairing"
import { canonicalizeJson } from "../domain/identity"
import { compareAndSwapLocal, readLocal, type LocalStatePlan } from "../localDb"
import type { IdentityDeviceComponent } from "./identityDeviceStateCodec"
import { identityDevicePreferencesChanged } from "./identityDevicePreferenceEvents"

export type IdentityPeerRecoverySource = { workspaceId: string; invite: DeviceEnrollmentInvitation }
const componentName = "peerRecovery"
const schema = "identity-peer-recovery@1"
const key = (personId: string) => `tincanban.identity-peer-recovery.v1.${personId}`
type Manifest = { personId: string; components: Record<string, IdentityDeviceComponent> }

export function isIdentityPeerRecoveryComponent(name: string, component: IdentityDeviceComponent): boolean {
  return name === componentName && component.schema === schema && !component.required
}

function normalize(personId: string, input: unknown): IdentityPeerRecoverySource[] {
  const entries = z.array(z.object({ workspaceId: z.string().min(1).max(512), invite: z.unknown() }).strict()).max(1024).parse(input)
  const unique = new Map<string, IdentityPeerRecoverySource>()
  for (const raw of entries) {
    const rawInvite = raw.invite as DeviceEnrollmentInvitation
    const invite = parseInvitation(invitationUrl("https://identity-peer.invalid", rawInvite), Date.parse(rawInvite.createdAt))
    if (invite.kind !== "device-enrollment" || invite.issuerPersonId !== personId ||
        Date.parse(invite.expiresAt) - Date.parse(invite.createdAt) > 10 * 60_000) throw new Error("Peer recovery source belongs to another Identity")
    if (Date.parse(invite.expiresAt) <= Date.now()) continue
    const entry = { workspaceId: raw.workspaceId, invite }
    unique.set(canonicalizeJson(entry), entry)
  }
  if (unique.size > 512) throw new Error("Identity peer recovery catalog exceeds unique-source limit")
  return [...unique.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, entry]) => entry)
}

function decode(personId: string, raw: string | null): IdentityPeerRecoverySource[] {
  if (raw === null) return []
  const value = JSON.parse(raw) as { personId?: unknown; sources?: unknown }
  if (value.personId !== personId) throw new Error("Identity peer recovery catalog mismatch")
  return normalize(personId, value.sources)
}

export async function readIdentityPeerRecovery(personId: string): Promise<IdentityPeerRecoverySource[]> {
  return decode(personId, await readLocal(key(personId)))
}

function sourcesFromManifest(manifest: Manifest): IdentityPeerRecoverySource[] {
  const sources: IdentityPeerRecoverySource[] = []
  const read = (name: string, component: IdentityDeviceComponent) => {
    if (!isIdentityPeerRecoveryComponent(name, component)) return
    if (component.value.personId !== manifest.personId) throw new Error("Identity peer recovery catalog mismatch")
    sources.push(...normalize(manifest.personId, component.value.sources))
  }
  for (const [name, component] of Object.entries(manifest.components)) {
    if (name === "preservedExtensions" && component.schema === "preserved-identity-components@1") {
      const entries = component.value.extensions as Array<{ name: string; component: IdentityDeviceComponent }>
      for (const entry of entries) read(entry.name, entry.component)
    } else read(name, component)
  }
  return normalize(manifest.personId, sources)
}

/** Addresses are private discovery hints; fresh same-person authorization remains mandatory at transfer time. */
export async function planIdentityPeerRecoveryImport(manifest: Manifest): Promise<LocalStatePlan> {
  const personId = manifest.personId
  const raw = await readLocal(key(personId))
  const sources = normalize(personId, [...decode(personId, raw), ...sourcesFromManifest(manifest)])
  return { conditions: [{ key: key(personId), value: raw }], writes: sources.length || raw !== null
    ? [{ key: key(personId), value: JSON.stringify({ personId, sources }) }] : [] }
}

export async function saveIdentityPeerRecovery(personId: string, sources: IdentityPeerRecoverySource[]): Promise<void> {
  const component = { schema, required: false, value: { personId, sources } }
  for (let attempt = 0; attempt < 8; attempt++) {
    const plan = await planIdentityPeerRecoveryImport({ personId, components: { [componentName]: component } })
    if (await compareAndSwapLocal(plan)) { identityDevicePreferencesChanged(personId); return }
  }
  throw new Error("Identity peer recovery catalog changed; retry discovery")
}

export async function exportIdentityPeerRecovery(personId: string): Promise<Record<string, IdentityDeviceComponent>> {
  const sources = await readIdentityPeerRecovery(personId)
  return sources.length ? { [componentName]: { schema, required: false, value: { personId, sources } } } : {}
}
