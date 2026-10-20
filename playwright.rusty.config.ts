import { defineConfig } from "@playwright/test"
const port = Number(process.env.TINCANBAN_RUSTY_E2E_PORT ?? 4259)
export default defineConfig({
  testDir: "./e2e", testMatch: ["rusty-connection.spec.ts", "rusty-mobile.spec.ts", "rusty-credential-conflict.spec.ts", "shared-board-rusty-access.spec.ts"], workers: 1, retries: 0,
  use: { baseURL: `http://127.0.0.1:${port}`, trace: "retain-on-failure" },
  webServer: { command: `npm run dev -- --host 127.0.0.1 --port ${port}`, port, reuseExistingServer: false,
    env: { VITE_SYNC_TELEMETRY_URL: "", VITE_SYNC_TELEMETRY_PROJECT: "tincanban", VITE_SYNC_TELEMETRY_BROWSER_KEY: "" } },
})
