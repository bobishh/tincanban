const { options } = require("./.dependency-cruiser.cjs")

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "automation-does-not-import-browser-sync",
      severity: "error",
      comment: "Automation consumes SDK protocol exports and explicit product contracts.",
      from: { path: "^workers/automation/src/", pathNot: "[.](?:test|spec)[.]ts$" },
      to: { reachable: true, path: "^src/(?:sync/|state[^/]*[.]ts$|storage[^/]*[.]ts$|app/|components/|ui/)" },
    },
    {
      name: "product-replica-has-no-browser-composition",
      severity: "error",
      comment: "The product entry point owns implementations, not reverse-dependency wrappers.",
      from: { path: "^src/product-replica/", pathNot: "[.](?:test|spec)[.]ts$" },
      to: { reachable: true, path: "^src/(?:sync/|state[^/]*[.]ts$|storage[^/]*[.]ts$|app/|components/|ui/)" },
    },
  ],
  options,
}
