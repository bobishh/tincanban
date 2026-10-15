import { defineConfig } from "@playwright/test"

const port = Number(process.env.TINCANBAN_AUTOMATION_E2E_PORT ?? 4267)

export default defineConfig({
  testDir: "./e2e",
  outputDir: process.env.TINCANBAN_AUTOMATION_TEST_RESULTS ?? "test-results-automation-worker",
  testMatch: ["automation-worker.spec.ts", "application-source-binding.spec.ts"],
  workers: 1,
  retries: 0,
  timeout: 180_000,
  projects: [{ name: "automation-worker" }],
  use: { baseURL: `http://127.0.0.1:${port}`, actionTimeout: 15_000, trace: "retain-on-failure" },
  webServer: {
    command: `npm run dev -- --host 127.0.0.1 --port ${port}`,
    port,
    reuseExistingServer: false,
    env: { TINCANBAN_E2E_NO_HMR: "1", VITE_SYNC_TELEMETRY_URL: "", VITE_SYNC_TELEMETRY_PROJECT: "tincanban", VITE_SYNC_TELEMETRY_BROWSER_KEY: "" },
  },
})
