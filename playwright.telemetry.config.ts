import { defineConfig } from "@playwright/test"
const port = Number(process.env.TINCANBAN_E2E_PORT ?? 4247)
export default defineConfig({
  testDir: "./e2e", testMatch: ["telemetry.spec.ts", "chat.spec.ts"], workers: 1,
  use: { baseURL: `http://127.0.0.1:${port}`, trace: "retain-on-failure" },
  webServer: {
    command: `npm run dev -- --host 127.0.0.1 --port ${port}`, port, reuseExistingServer: false,
    env: {
      VITE_PUBLIC_BOARD_ORIGIN: "",
      VITE_SYNC_TELEMETRY_URL: "https://telemetry.invalid/events", VITE_SYNC_TELEMETRY_PROJECT: "tincanban",
      VITE_SYNC_TELEMETRY_BROWSER_KEY: "public-browser-fixture-key-0123456789", VITE_SYNC_TELEMETRY_LEVEL: "all",
      VITE_SYNC_TELEMETRY_SAMPLE_RATE: "1", VITE_SYNC_TELEMETRY_BATCH_SIZE: "50",
    },
  },
})
