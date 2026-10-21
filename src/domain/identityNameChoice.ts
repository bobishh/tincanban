import { readLocal, type LocalStatePlan } from "../localDb"
import { unprovidedDisplayName } from "../chat/names"

type NamedIdentity = { personId: string; displayName: string }
export const identityNameChoiceKey = (personId: string) => `tincanban.identity-name-unprovided.v1.${personId}`

/** Only fresh, explicitly unprovided names receive a marker; existing names remain chosen. */
export async function identityNameIsProvided(identity: NamedIdentity): Promise<boolean> {
  return identity.displayName !== unprovidedDisplayName || await readLocal(identityNameChoiceKey(identity.personId)) !== unprovidedDisplayName
}

/** Bundle explicit choice with the profile/root commit, including choosing the neutral name itself. */
export async function planIdentityNameChoice(personId: string): Promise<LocalStatePlan> {
  const key = identityNameChoiceKey(personId), value = await readLocal(key)
  return value === null ? { conditions: [], writes: [] } : { conditions: [{ key, value }], writes: [{ key, value: null }] }
}
