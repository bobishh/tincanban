import { readFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../", import.meta.url))
const metadata = JSON.parse(readFileSync(new URL("../node_modules/@opentelemetry/otlp-exporter-base/package.json", import.meta.url), "utf8"))
if (metadata.version !== "0.223.0") throw new Error("Review the OTel response-drain backport before changing the exporter version")
const patch = fileURLToPath(new URL("../patches/opentelemetry-0.223.0-response-drain.patch", import.meta.url))
const apply = (...args) => spawnSync("git", ["apply", ...args, patch], { cwd: root, encoding: "utf8" })

if (apply("--check").status === 0) {
  const result = apply()
  if (result.status !== 0) throw new Error(`OTel response-drain backport failed: ${result.stderr || result.error}`)
  console.log("Applied OTel response-drain backport")
} else if (apply("--reverse", "--check").status === 0) {
  console.log("OTel response-drain backport already applied")
} else {
  throw new Error("Installed OTel transport differs from the reviewed response-drain patch")
}
