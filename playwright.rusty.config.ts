import { defineConfig } from "@playwright/test"
import { resolve } from "node:path"
const port = Number(process.env.TINCANBAN_RUSTY_E2E_PORT ?? 4259)
const identityOrigin = process.env.IDENTITY_E2E_ORIGIN
const identityProviderDirectory = process.env.IDENTITY_E2E_PROVIDER_DIR
const servers = [
  ...(identityProviderDirectory ? [{
    command: "npm run dev",
    cwd: resolve(identityProviderDirectory),
    url: identityOrigin,
    reuseExistingServer: false,
    timeout: 30_000,
  }] : []),
  {
    command: `npm run dev -- --host 127.0.0.1 --port ${port}`,
    port,
    reuseExistingServer: false,
    env: { VITE_IDENTITY_ORIGIN: identityOrigin ?? "", VITE_SYNC_TELEMETRY_URL: "",
      VITE_SYNC_TELEMETRY_PROJECT: "tincanban", VITE_SYNC_TELEMETRY_BROWSER_KEY: "" },
  },
]
export default defineConfig({
  testDir: "./e2e", testMatch: ["rusty-connection.spec.ts", "rusty-mobile.spec.ts", "rusty-credential-conflict.spec.ts", "shared-board-rusty-access.spec.ts", "identity-rusty-owner-restore.spec.ts"], workers: 1, retries: 0,
  use: { baseURL: `http://127.0.0.1:${port}`, trace: "retain-on-failure" },
  webServer: servers,
})
