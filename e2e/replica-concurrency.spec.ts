import { expect, test } from "./support/coverage"

test("Given two tabs share an uncertain Rusty upload, when both retry the same board, then serialize complete passes and acknowledge the exact saved upload once", async ({ page, context }) => {
  await page.goto("/")
  const fixture = await page.evaluate(async () => (await import("/e2e/support/replicaConcurrency.ts")).prepare())
  const other = await context.newPage()
  await other.goto("/")
  const lost = await page.evaluate(async value => (await import("/e2e/support/replicaConcurrency.ts")).push(value, true), fixture)
  expect(lost).toBe("Response lost after remote save")
  const results = await Promise.all([page, other].map(tab => tab.evaluate(async value =>
    (await import("/e2e/support/replicaConcurrency.ts")).push(value), fixture)))
  expect(results).toEqual(["acknowledged", "acknowledged"])
  const saved = await page.evaluate(async value => (await import("/e2e/support/replicaConcurrency.ts")).inspect(value), fixture)
  expect(saved.uploads).toHaveLength(2)
  expect(saved.uploads[1]).toEqual(saved.uploads[0])
  expect(saved.progress.pending).toBeUndefined()
  expect(saved.progress.uploadedRevision).toBe("unchanged-board")
  await other.close()
})
