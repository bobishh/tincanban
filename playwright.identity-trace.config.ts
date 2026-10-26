import { defineConfig } from "@playwright/test"

const appPort = Number(process.env.TINCANBAN_E2E_PORT ?? 48937)
const identityPort = Number(process.env.IDENTITY_E2E_PORT ?? new URL(process.env.IDENTITY_E2E_ORIGIN ?? "http://127.0.0.1:4190").port)
const identityProviderDirectory = process.env.IDENTITY_E2E_PROVIDER_DIR
const identityOrigin = process.env.IDENTITY_E2E_ORIGIN ?? `http://127.0.0.1:${identityPort}`

export default defineConfig({
  testDir: "./e2e",
  testMatch: "identity-browser-signin-trace.spec.ts",
  workers: 1,
  retries: 0,
  reporter: "line",
  use: { baseURL: `http://127.0.0.1:${appPort}`, trace: "off", browserName: "chromium" },
  webServer: [
    ...(identityProviderDirectory ? [{
      command: `./node_modules/.bin/vite --host 127.0.0.1 --port ${identityPort} --strictPort`,
      cwd: identityProviderDirectory,
      url: identityOrigin,
      reuseExistingServer: false,
      timeout: 30_000,
    }] : []),
    {
      command: `npm run dev -- --host 127.0.0.1 --port ${appPort}`,
      port: appPort,
      reuseExistingServer: false,
      env: {
        VITE_IDENTITY_ORIGIN: identityOrigin,
        VITE_SYNC_TELEMETRY_URL: "",
        VITE_OTEL_EXPORTER_OTLP_ENDPOINT: "https://telemetry.invalid",
        VITE_SYNC_TELEMETRY_PROJECT: "tincanban",
        VITE_SYNC_TELEMETRY_BROWSER_KEY: "public-browser-fixture-key-0123456789",
        VITE_SYNC_TELEMETRY_LEVEL: "all",
        VITE_SYNC_TELEMETRY_SAMPLE_RATE: "1",
        VITE_SYNC_TELEMETRY_BATCH_SIZE: "50",
      },
    },
  ],
})
