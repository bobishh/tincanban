import type { useTincanban } from "../state"

type FixtureInput = { id?: string; company: string; role: string; status: string; description?: string; notes?: string; [key: string]: unknown }
export function createLeadFixture(app: ReturnType<typeof useTincanban>, input: FixtureInput) {
  const bindings = app.activeBoard.value?.preset?.bindings ?? {}
  const parentId = bindings[`status.${input.status}`] ?? app.genericColumns.value[0]!.id
  const values = Object.fromEntries(Object.entries(input).flatMap(([key, value]) => bindings[`field.${key}`] && (typeof value === "string" || typeof value === "number" || typeof value === "boolean") ? [[bindings[`field.${key}`], value]] : []))
  for (const [key, id] of Object.entries(bindings)) {
    if (key.startsWith("option.")) for (const fieldId of Object.keys(values)) if (values[fieldId] === key.split(".").at(-1)) values[fieldId] = id
  }
  return app.createItemAsync({ id: input.id, title: `${input.company} — ${input.role}`, parentId, body: input.description ?? input.notes ?? "", values })
}
