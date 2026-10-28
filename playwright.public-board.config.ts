import { defineConfig } from "@playwright/test"

const webPort = Number(process.env.TINCANBAN_PUBLIC_E2E_WEB_PORT)
const publicOrigin = process.env.TINCANBAN_PUBLIC_E2E_KEEPER_ORIGIN
const previewBuild = process.env.TINCANBAN_PUBLIC_E2E_PREVIEW === "1"
if (!Number.isInteger(webPort) || webPort < 1 || !publicOrigin?.startsWith("http://127.0.0.1:")) throw new Error("Public board integration requires isolated local ports")

export default defineConfig({
  testDir: "./e2e", testMatch: previewBuild ? ["public-board.spec.ts"] : ["public-board-keeper.spec.ts", "public-board.spec.ts"], workers: 1, retries: 0,
  outputDir: process.env.TINCANBAN_PUBLIC_E2E_OUTPUT_DIR ?? "test-results/public-board",
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "firefox", use: { browserName: "firefox" } },
    { name: "webkit", use: { browserName: "webkit" } },
  ],
  use: { baseURL: `http://127.0.0.1:${webPort}`, trace: "retain-on-failure", acceptDownloads: true, actionTimeout: 10_000 },
  webServer: {
    command: previewBuild
      ? `npm run preview -- --host 127.0.0.1 --port ${webPort} --strictPort`
      : `npm run dev -- --host 127.0.0.1 --port ${webPort}`,
    port: webPort, reuseExistingServer: false,
    env: {
      VITE_PUBLIC_BOARD_ORIGIN: publicOrigin,
      VITE_SYNC_TELEMETRY_URL: "", VITE_SYNC_TELEMETRY_PROJECT: "tincanban", VITE_SYNC_TELEMETRY_BROWSER_KEY: "",
    },
  },
})
