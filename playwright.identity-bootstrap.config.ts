import { defineConfig } from "@playwright/test"
import { resolve } from "node:path"

const port = Number(process.env.TINCANBAN_IDENTITY_BOOTSTRAP_PORT ?? 4264)
const identityOrigin = process.env.IDENTITY_E2E_ORIGIN
const identityProviderDirectory = process.env.IDENTITY_E2E_PROVIDER_DIR

export default defineConfig({
  testDir: "./e2e",
  testMatch: ["identity-phone-board-discovery.spec.ts", "identity-browser-signin.spec.ts"],
  outputDir: process.env.IDENTITY_BOOTSTRAP_ARTIFACT_DIR ?? "test-results-identity-bootstrap",
  workers: 1,
  retries: 0,
  use: { baseURL: `http://127.0.0.1:${port}`, trace: "retain-on-failure" },
  webServer: [
    ...(identityProviderDirectory ? [{
      command: `npm run dev -- --port ${Number(new URL(identityOrigin ?? "http://127.0.0.1:4175").port)}`,
      cwd: resolve(identityProviderDirectory),
      url: identityOrigin,
      reuseExistingServer: false,
      timeout: 30_000,
    }] : []),
    {
      command: `npm run dev -- --host 127.0.0.1 --port ${port}`,
      port,
      reuseExistingServer: false,
      env: {
        VITE_IDENTITY_ORIGIN: identityOrigin ?? "",
        VITE_SYNC_TELEMETRY_URL: "https://telemetry.invalid",
        VITE_SYNC_TELEMETRY_PROJECT: "tincanban",
        VITE_SYNC_TELEMETRY_BROWSER_KEY: "public-browser-fixture-key-0123456789",
        VITE_SYNC_TELEMETRY_LEVEL: "all",
        VITE_SYNC_TELEMETRY_SAMPLE_RATE: "1",
        VITE_SYNC_TELEMETRY_BATCH_SIZE: "50",
      },
    },
  ],
})
