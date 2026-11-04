import { existsSync } from "node:fs"

for (const [name, binary] of [["Rusty", process.env.TINCANBAN_RUSTY_BINARY],
  ["service-login verifier", process.env.META_MESH_VERIFY_SERVICE_LOGIN_BIN]]) {
  if (!binary || !existsSync(binary)) throw new Error(`Build the ${name} binary before running native interoperability tests: ${binary}`)
}
