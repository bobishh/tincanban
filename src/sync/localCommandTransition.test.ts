import { readFile } from "node:fs/promises"
import { beforeAll, expect, it, vi } from "vitest"
import * as Automerge from "@automerge/automerge/slim"
import { initializeAutomerge } from "../crdt"
import { bootstrapIdentity } from "../domain/identity"
import { createWorkspaceDoc } from "../domain/seeds"
import { executeCommand, type Command } from "../domain/commands"
import { prepareLocalChangeAuthorizations } from "./changeAuthorization"
import { assertLocalCommandTransition } from "./localCommandTransition"

beforeAll(async () => {
  const wasm = await readFile("node_modules/@automerge/automerge/dist/automerge.wasm")
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(wasm, { headers: { "content-type": "application/wasm" } })))
  await initializeAutomerge()
})

async function fixture(command: (columnId: string) => Command) {
  const profile = await bootstrapIdentity("Local command test")
  const base = Automerge.from(createWorkspaceDoc(crypto.randomUUID(), "Board", profile.identity.personId, "blank"))
  const column = Object.values(base.entities).find(entity => entity.kind === "column")!
  const result = await executeCommand(base, command(column.id), profile)
  if (!result.ok) throw new Error(result.error.message)
  const { newDoc, receipt } = result.value
  const bytes = Automerge.getLastLocalChange(newDoc)!
  const authorizations = await prepareLocalChangeAuthorizations(newDoc, profile, [receipt.changeHash])
  return { base, newDoc, receipt, bytes, authorizations, profile }
}

it("Given a signed local card creation, When checking an editor command, Then only its transition is admitted", async () => {
  const f = await fixture(parentId => ({ kind: "createItem", parentId, title: "Allowed" }))
  await expect(assertLocalCommandTransition(f.base, f.newDoc, f.receipt, f.bytes, f.authorizations, "editor", f.profile)).resolves.toBeUndefined()
})

it.each([true, false])("Given an editor column rename with reported targets=%s, When checking the local transition, Then board structure remains protected", async reported => {
  const f = await fixture(entityId => ({ kind: "renameEntity", entityId, title: "Forbidden" }))
  if (!reported) f.receipt.changedEntityIds = []
  await expect(assertLocalCommandTransition(f.base, f.newDoc, f.receipt, f.bytes, f.authorizations, "editor", f.profile)).rejects.toThrow(/Only the owner/)
})

it.each(["signature", "hash", "person", "frontier"])("Given a local command with wrong %s, When extending admission, Then it is rejected", async wrong => {
  const f = await fixture(parentId => ({ kind: "createItem", parentId, title: "Untrusted" }))
  if (wrong === "signature") f.authorizations[0]!.signed.signature = "invalid"
  if (wrong === "hash") f.receipt.changeHash = "different-change"
  if (wrong === "person") f.authorizations[0]!.signed.payload.personId = "different-person"
  if (wrong === "frontier") f.base = Automerge.change(Automerge.clone(f.base), draft => { draft.title = "Concurrent base" })
  await expect(assertLocalCommandTransition(f.base, f.newDoc, f.receipt, f.bytes, f.authorizations, "owner", f.profile)).rejects.toThrow()
})

it("Given a visitor local command, When creating a card, Then it is rejected before durable admission", async () => {
  const f = await fixture(parentId => ({ kind: "createItem", parentId, title: "Forbidden" }))
  await expect(assertLocalCommandTransition(f.base, f.newDoc, f.receipt, f.bytes, f.authorizations, "visitor", f.profile)).rejects.toThrow(/Visitors/)
})
