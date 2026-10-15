import { defineConfig } from "vitest/config"
import vue from "@vitejs/plugin-vue"

export default defineConfig({
  plugins: [vue()],
  test: {
    include: ["src/**/*.native.test.ts"],
    exclude: ["e2e/**", "tmp/**", "workers/**", "scripts/**/*.test.mjs", "**/node_modules/**"],
    setupFiles: ["./src/testSetup.ts"],
  },
})
