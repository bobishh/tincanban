import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"

async function filesIn(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const groups = await Promise.all(entries.filter(entry => entry.name !== "vendor").map(entry =>
    entry.isDirectory() ? filesIn(join(directory, entry.name)) : [join(directory, entry.name)]))
  return groups.flat()
}

const files = [...(await filesIn("src")).filter(path => /\.(css|vue)$/.test(path)), "public/agent/index.html"]
const failures = []
for (const path of files) {
  const source = await readFile(path, "utf8")
  const styles = path.endsWith(".css") ? [source] : [...source.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)].map(match => match[1])
  for (const css of styles) {
    const declarations = css.matchAll(/(?<![\w-])((?:(?:margin|padding)(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?|(?:row-|column-)?gap)\s*:\s*)([^;{}]+)/g)
    for (const declaration of declarations) {
      // The screen-reader-only utility intentionally collapses a one-pixel box.
      const value = declaration[2].replace(/-1px\b/g, "")
      if (/-?(?:\d+(?:\.\d+)?|\.\d+)(?:px|rem)\b/.test(value)) failures.push(`${path}: ${declaration[0].trim()}`)
    }
    if (/min-height:\s*(?:36|40|42|44|46|48)px\b/.test(css)) failures.push(`${path}: control minimum must use a size token`)
  }
}
if (failures.length) {
  console.error("Use shared spacing and control tokens:\n" + failures.join("\n"))
  process.exitCode = 1
} else console.info(`Layout contract passed: ${files.length} authored stylesheets/components and standalone guide.`)
