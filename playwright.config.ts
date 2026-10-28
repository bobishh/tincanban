import { defineConfig } from "@playwright/test"

const port = Number(process.env.TINCANBAN_E2E_PORT ?? 4244)

const networkSpecs = [
  "**/owner-reconnect.spec.ts",
  "**/shared-board-rusty-access.spec.ts",
  "**/attachment-session-recovery.spec.ts",
  "**/attachments-rusty.spec.ts",
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
  "**/complete-device-state.spec.ts",
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
    { name: "core", testIgnore: [...networkSpecs, "**/identity-browser-signin-trace.spec.ts", "**/identity-phone-board-discovery.spec.ts", "**/reflux-automation-connection.spec.ts", "**/telemetry.spec.ts", "**/startup-diagnostics.spec.ts", "**/automation-production.spec.ts", "**/automation-worker.spec.ts", "**/application-source-binding.spec.ts", "**/identity-rusty-owner-restore.spec.ts", "**/rusty-connection.spec.ts", "**/rusty-mobile.spec.ts", "**/rusty-credential-conflict.spec.ts", "**/public-board-keeper.spec.ts"] },
    { name: "mobile-webkit", testMatch: ["**/workspace-create-layout.spec.ts", "**/item-history-window.spec.ts", "**/shared-layout.spec.ts", "**/rusty-device-access.spec.ts", "**/identity-recovery-package.spec.ts", "**/settings-scope.spec.ts", "**/settings-layout.spec.ts", "**/automatic-priority.spec.ts", "**/ui-screen-audit.spec.ts", "**/sync-tabs.spec.ts", "**/mobile-overlay-safe-area.spec.ts", "**/mobile-large-history.spec.ts", "**/card-discuss-layout.spec.ts", "**/modal-background-state.spec.ts", "**/startup-preview.spec.ts", "**/mobile-chat-composer.spec.ts", "**/chat-mentions.spec.ts", "**/public-board.spec.ts", "**/root-message-links.spec.ts", "**/reading-typography.spec.ts", "**/release-upgrade.spec.ts"], use: { browserName: "webkit" } },
    { name: "attachments-rusty-webkit", testMatch: "**/attachments-rusty.spec.ts", use: { browserName: "webkit" } },
    { name: "attachment-session-recovery-webkit", testMatch: "**/attachment-session-recovery.spec.ts", use: { browserName: "webkit" } },
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
    env: { VITE_IDENTITY_ORIGIN: process.env.IDENTITY_E2E_ORIGIN ?? "", VITE_SYNC_TELEMETRY_URL: "", VITE_SYNC_TELEMETRY_PROJECT: "tincanban", VITE_SYNC_TELEMETRY_BROWSER_KEY: "", VITE_SYNC_TELEMETRY_LEVEL: "all", VITE_SYNC_TELEMETRY_SAMPLE_RATE: "1", VITE_SYNC_TELEMETRY_BATCH_SIZE: "50", VITE_PUBLIC_BOARD_ORIGIN: "http://127.0.0.1:47839" },
  },
})
