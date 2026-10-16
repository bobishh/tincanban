import { defineConfig } from "@playwright/test"
import base from "./playwright.config"

export default defineConfig({
  ...base,
  projects: [
    { name: "startup-chromium", testMatch: "**/startup-diagnostics.spec.ts" },
    { name: "startup-webkit", testMatch: "**/startup-diagnostics.spec.ts", use: { browserName: "webkit" } },
  ],
  webServer: { ...base.webServer, env: { ...base.webServer?.env,
    VITE_STARTUP_DIAGNOSTICS: "1", VITE_OTEL_EXPORTER_OTLP_ENDPOINT: "https://telemetry.invalid",
    VITE_SYNC_TELEMETRY_BROWSER_KEY: "public-browser-fixture-key-0123456789", VITE_SYNC_TELEMETRY_LEVEL: "all",
  } },
})
