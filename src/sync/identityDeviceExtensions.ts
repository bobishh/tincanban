import { isIdentityPeerRecoveryComponent } from "./identityPeerRecoveryCatalog"
import { z } from "zod"
import { canonicalizeJson } from "../domain/identity"
import { readLocal, type LocalStatePlan } from "../localDb"
import { IdentityDeviceStateUpgradeRequiredError, validateOptionalIdentityComponent,
  type IdentityDeviceComponent, type IdentityDeviceState } from "./identityDeviceStateCodec"

const componentName = "preservedExtensions"
const componentSchema = "preserved-identity-components@1"
const key = (personId: string) => `tincanban.identity-device-extensions.v1.${personId}`
const extensionSchema = z.object({ name: z.string().min(1).max(512), component: z.object({
  schema: z.string().min(1).max(512), required: z.literal(false), value: z.custom<Record<string, unknown>>(),
}).strict() }).strict()
const valueSchema = z.object({ personId: z.string().min(1), extensions: z.array(extensionSchema).max(512) }).strict()
const registrySchema = valueSchema.extend({ version: z.literal(1) }).strict()
type Extension = z.infer<typeof extensionSchema>

function normalize(personId: string, input: unknown): Extension[] {
  const checked = valueSchema.safeParse(input)
  if (!checked.success || checked.data.personId !== personId) throw new Error("Invalid retained identity extensions")
  const unique = new Map<string, Extension>()
  for (const entry of checked.data.extensions) {
    if (entry.name === componentName && entry.component.schema === componentSchema) throw new Error("Nested identity extension container")
    const component = validateOptionalIdentityComponent(entry.name, entry.component)
    const extension = { name: entry.name, component }
    unique.set(canonicalizeJson(extension), extension)
  }
  if (unique.size > 256) throw new Error("Retained identity extensions exceed variant limit")
  return [...unique.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([, extension]) => extension)
}

/** The transfer envelope is authenticated by the caller; unknown optional values are never interpreted. */
export function readIdentityDeviceExtensions(manifest: IdentityDeviceState): Extension[] {
  const entries: Extension[] = []
  for (const [name, component] of Object.entries(manifest.components)) {
    if (component.required) continue
    if (name === componentName && component.schema === componentSchema) {
      entries.push(...normalize(manifest.personId, component.value))
    } else entries.push({ name, component: validateOptionalIdentityComponent(name, component) })
  }
  return normalize(manifest.personId, { personId: manifest.personId, extensions: entries })
    .filter(entry => !isIdentityPeerRecoveryComponent(entry.name, entry.component))
}

function storedExtensions(personId: string, raw: string | null): Extension[] {
  if (raw === null) return []
  if (new TextEncoder().encode(raw).byteLength > 1024 * 1024) throw new Error("Retained identity extensions exceed size limit")
  let input: unknown
  try { input = JSON.parse(raw) }
  catch { throw new Error("Invalid retained identity extensions") }
  if (input && typeof input === "object" && "version" in input && input.version !== 1) {
    throw new IdentityDeviceStateUpgradeRequiredError("Retained identity extensions require an upgrade")
  }
  const parsed = registrySchema.safeParse(input)
  if (!parsed.success) throw new Error("Invalid retained identity extensions")
  return normalize(personId, { personId: parsed.data.personId, extensions: parsed.data.extensions })
}

/** Merge all opaque variants rather than using a wall clock or overwriting an unknown schema. */
export async function planIdentityDeviceExtensionsImport(manifest: IdentityDeviceState): Promise<LocalStatePlan> {
  const personId = manifest.personId
  const incoming = readIdentityDeviceExtensions(manifest)
  const raw = await readLocal(key(personId))
  const existing = storedExtensions(personId, raw)
  const extensions = normalize(personId, { personId, extensions: [...existing, ...incoming] })
  const value = JSON.stringify({ version: 1, personId, extensions })
  if (new TextEncoder().encode(value).byteLength > 1024 * 1024) throw new Error("Retained identity extensions exceed size limit")
  return { conditions: [{ key: key(personId), value: raw }],
    writes: extensions.length || raw !== null ? [{ key: key(personId), value }] : [] }
}

export async function exportIdentityDeviceExtensions(personId: string): Promise<Record<string, IdentityDeviceComponent>> {
  const extensions = storedExtensions(personId, await readLocal(key(personId)))
  return extensions.length ? { [componentName]: { schema: componentSchema, required: false, value: { personId, extensions } } } : {}
}
