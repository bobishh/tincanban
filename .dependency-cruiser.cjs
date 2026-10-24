/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "public-reader-stays-anonymous",
      severity: "error",
      comment: "Public viewing must not transitively initialize private identity, storage, policy, or mesh.",
      from: {
        path: "^src/public/(?:PublicBoardApp[.]vue|publicSchema[.]ts|publicReader[^/]*[.]ts|publicAnalytics[^/]*[.]ts)$",
        pathNot: "[.](?:test|spec)[.]ts$",
      },
      to: {
        reachable: true,
        path: "^src/(?:App[.]vue|app/|chat/(?!context[.]ts$|referenceChoices[.]ts$|messageReference[.]ts$|avatar[.]ts$)|attachments[.]ts|storage[^/]*[.]ts|domain/(?:identity|permissions|proofs|model)[.]ts|public/(?:publicProjection|publicClient|publicationClient|PublicationDialog)[.]|sync/(?!telemetryConfig[.]ts|telemetryEvent[.]ts))|^(?:vendor/meta-mesh/|(?:node_modules/)?(?:@automerge/|@meta-uber/mesh-))",
      },
    },
    {
      name: "domain-does-not-initialize-vue",
      severity: "error",
      comment: "Domain behavior must run without a UI runtime, including through helpers.",
      from: { path: "^src/domain/", pathNot: "[.](?:test|spec)[.]ts$" },
      to: { reachable: true, path: "^(?:node_modules/)?(?:vue(?:/|$)|@vue/)" },
    },
    {
      name: "ui-does-not-call-protocol-sdk",
      severity: "error",
      comment: "Views call application operations; protocol clients belong behind that interface.",
      from: { path: "^src/(?:components|ui)/", pathNot: "[.](?:test|spec)[.]ts$" },
      to: {
        dependencyTypesNot: ["type-only"],
        path: "^(?:(?:node_modules/)?@meta-uber/mesh-|vendor/meta-mesh/packages/mesh-)(?:replication|runtime|transport)(?:/|$)",
      },
    },
    {
      name: "no-circular",
      severity: "error",
      comment: "Cycles hide initialization order and couple unrelated changes.",
      from: {},
      to: { circular: true },
    },
    {
      name: "no-unresolvable",
      severity: "error",
      comment: "Every import must resolve from a clean checkout.",
      from: {},
      to: {
        couldNotResolve: true,
        pathNot: "^@automerge/automerge/automerge[.]wasm[?]url$",
      },
    },
    {
      name: "production-does-not-import-tests",
      severity: "error",
      from: { pathNot: "[.](?:test|spec|testSupport)[.]ts$" },
      to: { path: "[.](?:test|spec|testSupport)[.]ts$" },
    },
    {
      name: "domain-does-not-depend-on-infrastructure",
      severity: "error",
      comment: "Domain stays usable without Vue, storage, or sync runtimes.",
      from: { path: "^src/domain/" },
      to: {
        dependencyTypesNot: ["type-only"],
        path: "^src/(?:components|ui|sync)(?:/|$)|^src/storage[.]ts$",
      },
    },
    {
      name: "ui-does-not-own-infrastructure",
      severity: "error",
      comment: "UI should call an application boundary, not storage or sync directly.",
      from: { path: "^src/(?:components|ui)/" },
      to: { path: "^src/(?:storage[.]ts|sync/)" },
    },
  ],
  options: {
    tsPreCompilationDeps: false,
    doNotFollow: { path: "node_modules" },
    exclude: { path: "^(?:dist|iroh-wasm|vendor)/" },
    tsConfig: { fileName: "tsconfig.app.json" },
    enhancedResolveOptions: {
      extensions: [".js", ".mjs", ".cjs", ".ts", ".d.ts", ".vue", ".json"],
      conditionNames: ["import", "browser", "default", "types"],
      exportsFields: ["exports"],
    },
    skipAnalysisNotInRules: true,
  },
};
