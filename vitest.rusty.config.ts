import { defineConfig } from "vitest/config"
import vue from "@vitejs/plugin-vue"
import { resolve } from "node:path"

const rusty = process.env.TINCANBAN_RUSTY_BINARY ?? resolve("../mesh-lighthouse/target/debug/mesh-lighthouse")
const loginVerifier = process.env.META_MESH_VERIFY_SERVICE_LOGIN_BIN ?? resolve("vendor/meta-mesh/target/debug/examples/verify_service_login")

export default defineConfig({
  plugins: [vue()],
  test: {
    include: ["src/**/*.native.test.ts", "vendor/meta-mesh/packages/**/*.native.test.ts",
      "vendor/meta-mesh/packages/mesh-identity/src/serviceLoginCli.integration.test.ts"],
    exclude: ["e2e/**", "tmp/**", "workers/**", "scripts/**/*.test.mjs", "**/node_modules/**"],
    setupFiles: ["./src/nativeTestSetup.ts", "./src/testSetup.ts"],
    env: { TINCANBAN_RUSTY_BINARY: rusty, META_MESH_VERIFY_SERVICE_LOGIN_BIN: loginVerifier },
  },
})
