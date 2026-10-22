import { unzipSync } from "fflate"
import { expect, test } from "./support/coverage"

test("Given local boards, when exporting all from settings, then download a ZIP of individual board bundles", async ({ page }) => {
  await page.goto("/")
  await expect(page.getByRole("button", { name: "Open workspaces", exact: true })).toBeEnabled({ timeout: 30000 })
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  const settings = page.getByRole("dialog", { name: "Settings", exact: true })
  await settings.getByRole("tab", { name: "Workspace", exact: true }).click()
  const files = settings.getByRole("region", { name: "Workspace files", exact: true })
  const downloadPromise = page.waitForEvent("download")
  await files.getByRole("button", { name: "Export all boards", exact: true }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toMatch(/^tincanban-boards-\d{4}-\d{2}-\d{2}\.zip$/u)

  const stream = await download.createReadStream()
  if (!stream) throw new Error("The all-board ZIP download could not be read")
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  const archive = unzipSync(new Uint8Array(Buffer.concat(chunks)))
  const bundles = Object.entries(archive).filter(([filename]) => filename.endsWith(".tincanban"))
  expect(bundles.length).toBeGreaterThan(0)
  expect(Object.keys(archive)).toEqual(bundles.map(([filename]) => filename))
  expect(bundles.every(([filename]) => !filename.includes("/") && !filename.includes("\\"))).toBe(true)
  for (const [, bundle] of bundles) {
    const entries = Object.keys(unzipSync(bundle))
    expect(entries).toContain("manifest.json")
    expect(entries).toContain("workspace.automerge")
    expect(entries).toContain("workspace.json")
  }
})
