import { expect, it } from "vitest"
import { messageAuthor } from "./messageAuthor"
import type { StoredChatMessage, StoredChatProfile } from "./store"

it("Given an admitted owner grant When showing its automated message Then attribute it to the grant owner with Automation marker", () => {
  const profiles = [{ personId: "bo", name: "Bo", record: { publicKey: "owner-key" } },
    { personId: "other", name: "Other", record: { publicKey: "other-key" } }] as StoredChatProfile[]
  const message = { personId: "executor", record: { authority: { publicKey: "owner-key",
    grant: { payload: { role: "automation", personId: "executor" } } } } } as StoredChatMessage
  expect(messageAuthor(message, profiles, "Unknown")).toBe("Bo (Automation)")
  expect(messageAuthor(message, profiles.slice(1), "Unknown")).toBe("Automation")
  const human = { personId: "bo", record: { authority: { publicKey: "owner-key" } } } as StoredChatMessage
  expect(messageAuthor(human, profiles, "Bo")).toBe("Bo")
});
