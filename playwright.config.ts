import { defineConfig } from "@playwright/test"

const port = Number(process.env.TINCANBAN_E2E_PORT ?? 4244)

const networkSpecs = [
  "**/mobile-profile-sync.spec.ts",
  "**/member-access.spec.ts",
  "**/browser-native.spec.ts",
  "**/keeper-join.spec.ts",
  "**/chat.spec.ts",
  "**/durable-mesh.spec.ts",
  "**/scoped-sync.spec.ts",
  "**/succession.spec.ts",
  "**/sync.spec.ts",
  "**/workspace-roles.spec.ts",
  "**/workspace-sync-data.spec.ts",
  "**/workspace-schema-migration.spec.ts",
]

const groupedNetworkSpecs = networkSpecs.filter(spec =>
  !spec.endsWith("scoped-sync.spec.ts") && !spec.endsWith("succession.spec.ts"))
const scopedIsolated = [
  { name: "scoped-enrollment", grep: /requires mutual approval/ },
  { name: "scoped-existing-board", grep: /visitor already has the owner's board/ },
  { name: "scoped-existing-identity", grep: /existing data under another identity/ },
  { name: "scoped-delegated-owner", grep: /delegated owner device/ },
]
const scopedIsolatedPattern = new RegExp(scopedIsolated.map(item => item.grep.source).join("|"))

export default defineConfig({
  testDir: "./e2e",
  // Iroh relay sessions can outlive a closed browser context briefly. Network specs
  // get distinct projects so each group owns a fresh browser/network process.
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  projects: [
    { name: "core", testIgnore: [...networkSpecs, "**/telemetry.spec.ts", "**/startup-diagnostics.spec.ts", "**/automation-production.spec.ts", "**/automation-worker.spec.ts", "**/rusty-connection.spec.ts", "**/public-board-keeper.spec.ts"] },
    { name: "mobile-webkit", testMatch: ["**/sync-tabs.spec.ts", "**/avatar-crop-responsive.spec.ts", "**/mobile-overlay-safe-area.spec.ts", "**/brand-layout.spec.ts", "**/mobile-large-history.spec.ts", "**/card-discuss-layout.spec.ts", "**/modal-background-state.spec.ts", "**/startup-preview.spec.ts", "**/window-presentation.spec.ts", "**/mobile-chat-composer.spec.ts", "**/public-board.spec.ts", "**/focus-frames.spec.ts", "**/root-message-links.spec.ts"], use: { browserName: "webkit" } },
    ...groupedNetworkSpecs.map(spec => ({
      name: spec.match(/([^/]+)\.spec\.ts$/)?.[1] ?? spec,
      testMatch: spec,
    })),
    { name: "scoped-sync", testMatch: "**/scoped-sync.spec.ts", grepInvert: scopedIsolatedPattern },
    ...scopedIsolated.map(project => ({ ...project, testMatch: "**/scoped-sync.spec.ts" })),
    { name: "succession-named", testMatch: "**/succession.spec.ts", grep: /owner names an editor successor/ },
    { name: "succession-quorum", testMatch: "**/succession.spec.ts", grep: /editor quorum recovery/ },
  ],
  use: { baseURL: `http://127.0.0.1:${port}`, trace: "retain-on-failure" },
  webServer: {
    command: `npm run dev -- --host 127.0.0.1 --port ${port}`,
    port,
    reuseExistingServer: false,
    // Tests intercept diagnostic intake; never depend on a developer's .env
    // or send fixture events to a production service.
    env: { VITE_SYNC_TELEMETRY_URL: "", VITE_SYNC_TELEMETRY_PROJECT: "tincanban", VITE_SYNC_TELEMETRY_BROWSER_KEY: "", VITE_SYNC_TELEMETRY_LEVEL: "all", VITE_SYNC_TELEMETRY_SAMPLE_RATE: "1", VITE_SYNC_TELEMETRY_BATCH_SIZE: "50", VITE_PUBLIC_BOARD_ORIGIN: "http://127.0.0.1:47839" },
  },
})
