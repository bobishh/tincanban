import { shallowRef, ref } from "vue"
import { expect, test } from "vitest"
import type { BlindReplicaConfig } from "./blindReplication"
import { createBoardFreshness } from "./replicaHealthRun"
import { replicaConfirmationLifetime } from "./replicationHealth"

const first: BlindReplicaConfig = {
  origin: "https://first.example", scopeId: "scope-1", workspaceId: "board",
  policyRevision: 1, keyEpoch: 1, servicePublicKey: "service", readToken: "read", writeToken: "write",
  contentKey: "content", cursor: 0, lastUploaded: "",
}

test("Given two configured copies, when one is unverified or its confirmation expires, then the board cannot show a current Rusty check", async () => {
  const second = { ...first, origin: "https://second.example" }
  const configs = shallowRef([first, second])
  const now = ref(10_000)
  const freshness = createBoardFreshness(configs, now, () => "owner", () => "board")
  await freshness.check(first, () => true, async observe => observe({ phase: "checked", checkedAt: 9_000 }))
  expect(freshness.status.value).toEqual({ phase: "checking" })
  await freshness.check(second, () => true, async observe => observe({ phase: "catching-up" }))
  expect(freshness.status.value).toEqual({ phase: "catching-up" })
  await freshness.check(second, () => true, async observe => observe({ phase: "checked", checkedAt: 10_000 }))
  expect(freshness.status.value).toEqual({ phase: "checked", checkedAt: 9_000 })
  now.value = 9_001 + replicaConfirmationLifetime
  expect(freshness.status.value).toEqual({ phase: "overdue" })
})

test("Given an old poll is still running, when the device resumes or replaces access, then require a check in the current session and binding", async () => {
  const configs = shallowRef([first])
  const freshness = createBoardFreshness(configs, ref(10_000), () => "owner", () => "board")
  const pending = Promise.withResolvers<void>()
  const previous = freshness.check(first, () => true, async observe => {
    await pending.promise
    observe({ phase: "checked", checkedAt: 9_000 })
  })
  freshness.reset()
  pending.resolve()
  await previous
  expect(freshness.status.value).toEqual({ phase: "checking" })
  await freshness.check(first, () => true, async observe => observe({ phase: "checked", checkedAt: 10_000 }))
  expect(freshness.status.value).toEqual({ phase: "checked", checkedAt: 10_000 })
  configs.value = [{ ...first, policyRevision: 2 }]
  expect(freshness.status.value).toEqual({ phase: "checking" })
})
