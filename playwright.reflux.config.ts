import { defineConfig } from "@playwright/test"
const port = Number(process.env.TINCANBAN_REFLUX_E2E_PORT ?? 48926)
export default defineConfig({
  testDir: "./e2e", testMatch: "reflux-automation-connection.spec.ts", workers: 1, retries: 0,
  outputDir: process.env.TINCANBAN_REFLUX_E2E_OUTPUT ?? "test-results/reflux-connection",
  timeout: 180_000, use: { baseURL: `http://127.0.0.1:${port}`, actionTimeout: 15_000, navigationTimeout: 30_000, trace: "retain-on-failure" },
  webServer: { command: `npm run dev -- --host 127.0.0.1 --port ${port}`, port, reuseExistingServer: false,
    env: { VITE_IDENTITY_ORIGIN: process.env.IDENTITY_E2E_ORIGIN ?? "", VITE_SYNC_TELEMETRY_URL: "",
      VITE_OTEL_EXPORTER_OTLP_ENDPOINT: "", VITE_SYNC_TELEMETRY_PROJECT: "tincanban",
      VITE_SYNC_TELEMETRY_BROWSER_KEY: "", VITE_PUBLIC_BOARD_ORIGIN: "http://127.0.0.1:47839" } },
})
