import { readdir, readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { ESLint } from "eslint"
import postcss from "postcss"

const eslint = new ESLint({ overrideConfigFile: new URL("../eslint.css.config.mjs", import.meta.url).pathname })

export async function lintStyles(file, source) {
  const blocks = file.endsWith(".css") ? [{ css: source, offset: 0 }] :
    [...source.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)].map(match => ({
      css: match[1], offset: source.slice(0, match.index + match[0].indexOf(">") + 1).split("\n").length - 1,
    }))
  const messages = []
  for (const { css, offset } of blocks) {
    const [result] = await eslint.lintText(css, { filePath: `${file}.css` })
    messages.push(...result.messages.map(message => ({ ...message, line: message.line + offset })))
    let root
    try { root = postcss.parse(css) } catch { continue } // ESLint reports syntax errors.
    const report = (node, ruleId, message) => messages.push({ ruleId, severity: 2, line: node.source.start.line + offset, column: node.source.start.column, message })
    root.walk(container => {
      if (!container.nodes || container.type === "decl") return
      const declarations = new Set()
      for (const node of container.nodes) {
        if (node.type !== "decl") continue
        const key = `${node.prop}:${node.value}:${Boolean(node.important)}`
        if (declarations.has(key)) report(node, "css/no-duplicate-declarations", `Duplicate declaration ${node.prop}: ${node.value}`)
        declarations.add(key)
      }
    })
    const containers = [root]
    root.walkAtRules(node => containers.push(node))
    root.walkRules(node => containers.push(node))
    for (const container of containers) {
      const selectors = new Set()
      for (const node of container.nodes ?? []) {
        if (node.type !== "rule") continue
        if (selectors.has(node.selector)) report(node, "css/no-duplicate-selectors", `Duplicate selector ${node.selector}`)
        selectors.add(node.selector)
      }
    }
  }
  return messages
}

async function filesIn(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  return (await Promise.all(entries.filter(entry => entry.name !== "vendor").map(entry =>
    entry.isDirectory() ? filesIn(join(directory, entry.name)) : [join(directory, entry.name)]))).flat()
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const files = [...(await filesIn("src")).filter(file => /\.(css|vue)$/.test(file)),
    ...(await filesIn("public/assets")).filter(file => file.endsWith(".css")), "public/agent/index.html"]
  let errors = 0
  for (const file of files) {
    for (const message of await lintStyles(file, await readFile(file, "utf8"))) {
      console.error(`${file}:${message.line}:${message.column ?? 1} ${message.ruleId ?? "parse"}: ${message.message}`)
      errors += 1
    }
  }
  if (errors) process.exitCode = 1
  else console.info(`CSS lint passed: ${files.length} stylesheets/components and standalone guide.`)
}
