import { expect, it, vi } from "vitest"
import { awaitConnectionUnlessAborted } from "./identityPortalEnrollment"

it("closes a connection that resolves after sign-in was cancelled", async () => {
  const controller = new AbortController()
  let resolveConnection!: (connection: { close(): Promise<void> }) => void
  const close = vi.fn(async () => undefined)
  const pendingConnection = new Promise<{ close(): Promise<void> }>(resolve => { resolveConnection = resolve })

  const result = awaitConnectionUnlessAborted(pendingConnection, controller.signal)
  controller.abort()
  await expect(result).rejects.toMatchObject({ name: "AbortError" })

  resolveConnection({ close })
  await Promise.resolve()
  await Promise.resolve()
  expect(close).toHaveBeenCalledOnce()
})
