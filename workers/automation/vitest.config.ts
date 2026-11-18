import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  define: { __TINCANBAN_BUILD_COMMIT__: JSON.stringify("runtime-test") },
  plugins: [cloudflareTest({
    remoteBindings: false,
    miniflare: { bindings: { REFLUX_ORIGIN: "" } },
    wrangler: { configPath: process.env.TINCANBAN_AUTOMATION_RUNTIME_CONFIG ?? "./wrangler.jsonc" },
  })],
  test: { include: ["tests/**/*.runtime.test.ts"] },
});
