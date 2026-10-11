const roots = {
  private: ["src/App.vue", "src/sync/startupDiagnostics.ts", "src/vendor/berlin-tower.js"],
  public: ["src/public/PublicBoardApp.vue"],
}

function assetPath(value) {
  if (typeof value !== "string" || !/^assets\/[^/]+\.(?:js|css)$/.test(value)) {
    throw new Error(`Unsafe startup asset path: ${value}`)
  }
  return `dist/${value}`
}

// Vite's static import graph counts shared chunks once. Dynamic imports are
// added only for modules main.ts explicitly loads before the app can start.
export function startupBudgetFiles(manifest, mode) {
  if (!manifest["index.html"]?.isEntry) throw new Error("Missing frontend entry in build manifest")
  if (!roots[mode]) throw new Error(`Unknown startup budget: ${mode}`)
  const visited = new Set()
  const js = new Set()
  const css = new Set()
  function visit(key) {
    if (visited.has(key)) return
    const chunk = manifest[key]
    if (!chunk) throw new Error(`Missing startup chunk in build manifest: ${key}`)
    visited.add(key)
    js.add(assetPath(chunk.file))
    for (const file of chunk.css ?? []) css.add(assetPath(file))
    for (const imported of chunk.imports ?? []) visit(imported)
  }
  function startupKey(key) {
    if (manifest[key]) return key
    const name = key.split("/").at(-1).replace(/\.(?:vue|ts|js)$/, "")
    const candidates = (manifest["index.html"].dynamicImports ?? []).filter(imported => {
      const chunk = manifest[imported]
      return chunk?.isDynamicEntry && chunk.name === name
    })
    if (candidates.length > 1) throw new Error(`Ambiguous startup chunk in build manifest: ${key}`)
    if (!candidates.length) throw new Error(`Missing startup chunk in build manifest: ${key}`)
    return candidates[0]
  }
  for (const key of ["index.html", ...roots[mode].map(startupKey)]) visit(key)
  return { js: [...js].sort(), css: [...css].sort() }
}
