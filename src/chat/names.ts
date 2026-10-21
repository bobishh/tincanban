/**
 * Pure display name utilities for tincanban chat.
 * No Vue, persistence, or networking dependencies.
 */

const CONTROL_CHARS_REGEX = /\p{Cc}/u
const BIDI_CONTROL_REGEX = /\p{Bidi_Control}/u

const ADJECTIVES = [
  "Restless",
  "Thoughtful",
  "Bold",
  "Sunny",
  "Sparkling",
  "Radiant",
  "Brave",
  "Gentle",
  "Cozy",
  "Fluffy",
  "Attentive",
  "Swift",
  "Wise",
  "Cheerful",
  "Lively",
  "Tender",
  "Playful",
  "Spry",
  "Curious",
  "Kind",
  "Dreamy",
  "Mischievous",
  "Calm",
  "Joyful",
  "Nimble",
  "Valiant",
  "Inspired",
  "Mysterious",
] as const

const NOUNS = [
  "Mimosa",
  "Capybara",
  "Petunia",
  "Otter",
  "Panda",
  "Llama",
  "Comet",
  "Daisy",
  "Cinnamon",
  "Caramel",
  "Blueberry",
  "Raspberry",
  "Fox",
  "Owl",
  "Squirrel",
  "Swallow",
  "Spark",
  "Violet",
  "Vanilla",
  "Mint",
  "Papaya",
  "Magnolia",
  "Snail",
  "Turtle",
  "Heron",
  "Acacia",
  "Koala",
  "Marten",
] as const

/**
 * NFKC normalize, collapse Unicode whitespace runs to a single space, and trim.
 */
export function normalizeDisplayName(name: string): string {
  return name
    .normalize("NFKC")
    .replace(/\p{White_Space}+/gu, " ")
    .trim()
}

/**
 * Validates a display name:
 * - 1..48 Unicode codepoints
 * - No control characters (Unicode category Cc)
 * - No bidirectional control characters (Bidi_Control)
 * Returns null if valid, or an English human-readable error string if invalid.
 */
export function validateDisplayName(name: string): string | null {
  if (typeof name !== "string" || name.length === 0) {
    return "Display name cannot be empty."
  }
  if (CONTROL_CHARS_REGEX.test(name)) {
    return "Display name cannot contain control characters."
  }
  if (BIDI_CONTROL_REGEX.test(name)) {
    return "Display name cannot contain bidirectional control characters."
  }
  const normalized = normalizeDisplayName(name)
  const codepoints = [...normalized].length
  if (codepoints === 0) {
    return "Display name cannot be empty."
  }
  if (codepoints > 48) {
    return "Display name cannot exceed 48 characters."
  }
  return null
}

/**
 * Normalized lowercase deterministic name key (not locale-specific).
 */
export function nameKey(name: string): string {
  return normalizeDisplayName(name).toLowerCase()
}

/** Neutral protocol metadata until the user explicitly chooses a name. */
export const unprovidedDisplayName = "Participant"

/** Match only labels emitted by the retired adjective/noun generator and SDK. */
export function isGeneratedDeviceName(value: string): boolean {
  const match = /^([A-Za-z]+) ([A-Za-z]+)'s device$/.exec(value)
  return Boolean(match && ADJECTIVES.some(word => word === match[1]) && NOUNS.some(word => word === match[2]))
}

/**
 * Injective encoding of arbitrary string (including base64url cryptographic ID)
 * into safe alphanumeric ASCII ([0-9A-Za-z]).
 * Case-sensitive mapping ensures distinct IDs never collapse.
 */
function encodeIdToAlphanumeric(id: string): string {
  let result = ""
  for (let i = 0; i < id.length; i++) {
    const ch = id[i]
    if (
      (ch >= "a" && ch <= "z") ||
      (ch >= "A" && ch <= "Z") ||
      (ch >= "1" && ch <= "9")
    ) {
      result += ch
    } else if (ch === "0") {
      result += "00"
    } else if (ch === "-") {
      result += "01"
    } else if (ch === "_") {
      result += "02"
    } else {
      const code = ch.codePointAt(0) ?? ch.charCodeAt(0)
      result += "03" + code.toString(16) + "z"
    }
  }
  return result || "00"
}

interface DistinctPerson {
  personId: string
  chosenName: string
  key: string
  encodedId: string
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function collectDistinctPeople(people: readonly { personId: string; name: string }[]): DistinctPerson[] {
  const byPersonId = new Map<string, string[]>()
  for (const person of people) {
    const names = byPersonId.get(person.personId) ?? []
    names.push(person.name)
    byPersonId.set(person.personId, names)
  }
  return [...byPersonId]
    .sort(([left], [right]) => compareText(left, right))
    .map(([personId, names]) => {
      const chosenName = names.map(normalizeDisplayName).sort(compareText)[0]
      return { personId, chosenName, key: nameKey(chosenName), encodedId: encodeIdToAlphanumeric(personId) }
    })
}

function groupByName(people: DistinctPerson[]): DistinctPerson[][] {
  const groups = new Map<string, DistinctPerson[]>()
  for (const person of people) {
    const group = groups.get(person.key) ?? []
    group.push(person)
    groups.set(person.key, group)
  }
  return [...groups.values()]
}

function uniqueSuffixLengths(group: DistinctPerson[]): number[] {
  const lengths = group.map(() => 1)
  let extended = true
  while (extended) {
    const suffixes = group.map((person, index) => person.encodedId.slice(0, lengths[index]))
    const counts = new Map<string, number>()
    for (const suffix of suffixes) counts.set(suffix, (counts.get(suffix) ?? 0) + 1)
    extended = false
    suffixes.forEach((suffix, index) => {
      if ((counts.get(suffix) ?? 0) <= 1 || lengths[index] >= group[index].encodedId.length) return
      lengths[index] += 1
      extended = true
    })
  }
  return lengths
}

function assignGroupNames(group: DistinctPerson[], result: Record<string, string>): void {
  if (group.length === 1) {
    result[group[0].personId] = group[0].chosenName
    return
  }
  group.sort((left, right) => compareText(left.personId, right.personId))
  const lengths = uniqueSuffixLengths(group)
  group.forEach((person, index) => {
    result[person.personId] = `${person.chosenName} · ${person.encodedId.slice(0, lengths[index])}`
  })
}

/**
 * Resolves display names for a list of people:
 * - Group equal normalized keys.
 * - Unique names displayed as normalized name without suffix.
 * - For collisions, all distinct persons receive `name · X`.
 * - Suffix is derived deterministically from personId and extended until unique.
 * - Stable regardless of input order.
 * - Same person duplicates do not collide with self.
 */
export function resolveDisplayNames(
  people: readonly { personId: string; name: string }[]
): Record<string, string> {
  const result: Record<string, string> = {}
  for (const group of groupByName(collectDistinctPeople(people))) assignGroupNames(group, result)
  return result
}

/** Local identity name wins over any older per-workspace name announcement. */
export function resolveDisplayNamesWithIdentity(
  people: readonly { personId: string; name: string }[],
  identity: { personId: string; name: string },
): Record<string, string> {
  if (!identity.personId) return resolveDisplayNames(people)
  return resolveDisplayNames([
    ...people.filter(person => person.personId !== identity.personId),
    identity,
  ])
}
