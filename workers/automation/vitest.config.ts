import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({
    remoteBindings: false,
    wrangler: { configPath: process.env.TINCANBAN_AUTOMATION_RUNTIME_CONFIG ?? "./wrangler.jsonc" },
    miniflare: { bindings: { EXECUTOR_ORIGIN: "" } },
  })],
  test: { include: ["tests/**/*.runtime.test.ts"] },
});
