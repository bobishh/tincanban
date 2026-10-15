import type { PersonalRootDocumentV1 } from "./model"
import type { LocalProfile } from "./identity"
import { resolveLocalSigningContext } from "./localSigningContext"
import { identityProfileRevision } from "./identityProfileRevision"
import { createIdentityProfileOperation, emptyIdentityProfileState, identityProfileValue, mergeIdentityProfileState,
  observeLegacyIdentityProfile, readIdentityProfileState, type IdentityProfileState, type ProfileField, type ProfileValue } from "./identityProfileState"

/** Migration retains original observations without inventing an author, counter or timestamp order. */
export async function rootIdentityProfileState(root: PersonalRootDocumentV1): Promise<IdentityProfileState> {
  root = structuredClone(root)
  if (root.profileState !== undefined) return readIdentityProfileState(root.profileState, root.identity)
  let state = await observeLegacyIdentityProfile(emptyIdentityProfileState(root.identity.personId), root.identity, "name", root.identity.displayName)
  if (root.photo) state = await observeLegacyIdentityProfile(state, root.identity, "photo", root.photo)
  return state
}

/** Shadows serve existing UI/export readers; a conflict never selects a new value for them. */
export function projectIdentityProfileRoot(root: PersonalRootDocumentV1, state: IdentityProfileState): PersonalRootDocumentV1 {
  const next = { ...structuredClone(root), profileState: structuredClone(state) }
  const name = identityProfileValue(state, "name"), photo = identityProfileValue(state, "photo")
  if (name.status === "value" && typeof name.values[0] === "string") next.identity.displayName = name.values[0]
  if (photo.status === "value" && typeof photo.values[0] !== "string") next.photo = photo.values[0]
  return next
}

export async function editIdentityProfileRoot(root: PersonalRootDocumentV1, profile: LocalProfile,
  field: ProfileField, value: ProfileValue, ensureCurrent: () => void = () => {}): Promise<PersonalRootDocumentV1> {
  root = structuredClone(root)
  if (root.identity.personId !== profile.identity.personId || root.identity.publicKey !== profile.identity.publicKey) throw new Error("Identity catalog is unavailable")
  const state = await rootIdentityProfileState(root)
  const selected = identityProfileValue(state, field)
  const equal = selected.status === "value" && (typeof value === "string" ? selected.values[0] === value :
    typeof selected.values[0] !== "string" && selected.values[0]?.avatarData === value.avatarData)
  if (equal && state.operations.some(operation => operation.signed.payload.field === field)) {
    ensureCurrent()
    return projectIdentityProfileRoot(root, state)
  }
  const context = await resolveLocalSigningContext(profile, "identity-profile-update", { personId: profile.identity.personId }, { ensureCurrent })
  const operation = await createIdentityProfileOperation(context, state, root.identity, field, value)
  const next = await readIdentityProfileState({ ...state, operations: [...state.operations, operation] }, root.identity)
  ensureCurrent()
  return projectIdentityProfileRoot(root, next)
}

export async function assertIdentityProfileRevision(root: PersonalRootDocumentV1, expected: string): Promise<void> {
  if (await identityProfileRevision(await rootIdentityProfileState(root)) !== expected) {
    throw new Error("Profile changed on another device. Review the choices and save again.")
  }
}

export async function mergeIdentityProfileRoots(current: PersonalRootDocumentV1 | null, incoming: PersonalRootDocumentV1): Promise<PersonalRootDocumentV1> {
  const state = await rootIdentityProfileState(incoming)
  if (!current) return projectIdentityProfileRoot(incoming, state)
  if (current.identity.personId !== incoming.identity.personId || current.identity.publicKey !== incoming.identity.publicKey) throw new Error("Profile identity conflict")
  const merged = await mergeIdentityProfileState(await rootIdentityProfileState(current), state, current.identity)
  return projectIdentityProfileRoot({ ...incoming, ...current }, merged)
}
