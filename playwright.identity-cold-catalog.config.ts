import { defineConfig } from "@playwright/test"
import bootstrap from "./playwright.identity-bootstrap.config"

const catalogOrigin = process.env.IDENTITY_CATALOG_E2E_ORIGIN ?? "http://127.0.0.1:42784"
process.env.IDENTITY_CATALOG_E2E_ORIGIN = catalogOrigin

export default defineConfig({
  ...bootstrap,
  testMatch: "identity-board-restore.spec.ts",
  grep: /cold enrolled Identity profile/u,
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "webkit", use: { browserName: "webkit" } },
  ],
  outputDir: process.env.IDENTITY_BOOTSTRAP_ARTIFACT_DIR ?? "test-results-identity-cold-catalog",
  webServer: (Array.isArray(bootstrap.webServer) ? bootstrap.webServer : []).map(server => ({
    ...server,
    env: { ...server.env, VITE_PUBLIC_BOARD_ORIGIN: catalogOrigin },
  })),
})
