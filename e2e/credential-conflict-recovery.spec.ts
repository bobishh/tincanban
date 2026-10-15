import { expect, test } from './support/coverage'

test('Given a paused conflict, when the Owner explicitly recovers, then send the exact scope and show completion', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(async () => (await import('/e2e/support/credentialConflict.ts')).mountCredentialConflict('success'))
  await page.getByRole('button', { name: 'Recover connection', exact: true }).click()
  await expect(page.getByRole('status', { name: 'Recovery result' })).toHaveText('https://rusty.example / scope / board')
})
test('Given an uncertain recovery response, when policy verification fails, then retain the conflict explanation and retry action', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(async () => (await import('/e2e/support/credentialConflict.ts')).mountCredentialConflict('error'))
  await page.getByRole('button', { name: 'Recover connection', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Policy changed; original upload retained')
  await expect(page.getByRole('button', { name: 'Recover connection', exact: true })).toBeEnabled()
  await expect(page.getByText('Every previous key and saved upload stays available.', { exact: false })).toBeVisible()
})
test('Given recovery is pending, when the Owner opens the action, then prevent duplicate requests', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(async () => (await import('/e2e/support/credentialConflict.ts')).mountCredentialConflict('pending'))
  await page.getByRole('button', { name: 'Recover connection', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Recovering connection…', exact: true })).toBeDisabled()
})
