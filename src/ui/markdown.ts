import MarkdownIt from "markdown-it"
import type { Env } from "markdown-it"
import { tasklist } from "@mdit/plugin-tasklist"
import { copyableCodeHtml } from "./copyableCode"

const markdown = new MarkdownIt({ html: false, breaks: true, linkify: true })
  .use(tasklist, { disabled: false, label: false })

const hashPattern = /\b[a-f0-9]{64}\b/gi
markdown.core.ruler.after("linkify", "copyable_hashes", state => {
  for (const block of state.tokens) {
    let linkDepth = 0
    block.children = block.children?.flatMap(token => {
      if (token.type === "link_open") linkDepth++
      if (token.type === "link_close") linkDepth--
      if (linkDepth) return [token]
      if (token.type === "code_inline" && /^[a-f0-9]{64}$/i.test(token.content)) {
        token.type = "copyable_hash"
        return [token]
      }
      if (token.type !== "text") return [token]
      const result = []
      let offset = 0
      for (const match of token.content.matchAll(hashPattern)) {
        const before = new state.Token("text", "", 0)
        before.content = token.content.slice(offset, match.index)
        const hash = new state.Token("copyable_hash", "code", 0)
        hash.content = match[0]
        result.push(before, hash)
        offset = match.index + match[0].length
      }
      if (!result.length) return [token]
      const after = new state.Token("text", "", 0)
      after.content = token.content.slice(offset)
      return [...result, after]
    }) ?? null
  }
})
markdown.renderer.rules.copyable_hash = (tokens, index) => copyableCodeHtml(tokens[index].content, "Hash")
for (const rule of ["fence", "code_block"]) {
  const original = markdown.renderer.rules[rule]!
  markdown.renderer.rules[rule] = (tokens, index, options, env, renderer) =>
    /^[a-f0-9]{64}$/i.test(tokens[index].content.trim())
      ? copyableCodeHtml(tokens[index].content.trim(), "Hash")
      : original(tokens, index, options, env, renderer)
}

markdown.renderer.rules.link_open = (tokens, index, options, _env, renderer) => {
  const token = tokens[index]!
  const href = String(token.attrGet("href") ?? "")
  if (/^(?:https?:)?\/\//i.test(href)) {
    const origin = globalThis.location?.origin
    let external = true
    try { external = !origin || new URL(href, origin).origin !== origin }
    catch { /* An imperfect resource URL must not break the entire document. */ }
    if (external) {
      token.attrSet("target", "_blank")
      token.attrSet("rel", "noopener noreferrer")
    }
  }
  return renderer.renderToken(tokens, index, options)
}

// Card previews sit inside a button: do not nest links or input controls.
const compact = new MarkdownIt({ html: false, breaks: true, linkify: true })
  .use(tasklist, { disabled: false, label: false })
compact.renderer.rules.link_open = () => '<span class="markdown-link">'
compact.renderer.rules.link_close = () => "</span>"
compact.renderer.rules.image = (tokens, index) => compact.utils.escapeHtml(tokens[index].content)

type MarkdownEnvironment = { interactiveTasks?: boolean; taskIndex?: number }

// Search/filter rerenders can revisit the same long card bodies. Keep rendered
// HTML bounded while avoiding another markdown-it parse for unchanged content.
const renderCache = new Map<string, { variants: Map<number, string>; size: number }>()
const RENDER_CACHE_LIMIT = 64
const RENDER_CACHE_CHAR_LIMIT = 1_000_000
let renderCacheSize = 0

function renderCheckbox(tokens: Parameters<NonNullable<typeof markdown.renderer.rules.checkbox_input>>[0], index: number, options: Parameters<NonNullable<typeof markdown.renderer.rules.checkbox_input>>[2], env: Env | undefined, renderer: Parameters<NonNullable<typeof markdown.renderer.rules.checkbox_input>>[4]) {
  const token = tokens[index]
  const taskEnv = (env ?? {}) as MarkdownEnvironment
  const taskIndex = taskEnv.taskIndex ?? 0
  taskEnv.taskIndex = taskIndex + 1
  token.attrs = token.attrs?.filter(([name]) => name !== "id" && name !== "disabled" && name !== "data-task-index") ?? []
  token.attrPush(["data-task-index", String(taskIndex)])
  if (!taskEnv.interactiveTasks) token.attrPush(["disabled", "disabled"])
  return renderer.renderToken(tokens, index, options)
}

markdown.renderer.rules.checkbox_input = renderCheckbox
compact.renderer.rules.checkbox_input = (tokens, index, options, env, renderer) =>
  (env as MarkdownEnvironment | undefined)?.interactiveTasks
    ? renderCheckbox(tokens, index, options, env, renderer)
    : tokens[index].attrGet("checked") ? "☑ " : "☐ "

export function renderMarkdown(source: string, preview = false, interactiveTasks = false): string {
  let entry = renderCache.get(source)
  if (!entry) {
    entry = { variants: new Map<number, string>(), size: 0 }
    renderCache.set(source, entry)
  } else {
    renderCache.delete(source)
    renderCache.set(source, entry)
  }

  const mode = Number(preview) | (Number(interactiveTasks) << 1)
  const cached = entry.variants.get(mode)
  if (cached !== undefined) return cached

  const html = (preview ? compact : markdown).render(source, { interactiveTasks, taskIndex: 0 })
  const size = source.length + html.length
  if (size <= RENDER_CACHE_CHAR_LIMIT) {
    entry.variants.set(mode, html)
    entry.size += size
    renderCacheSize += size
  } else if (entry.size === 0) {
    renderCache.delete(source)
  }
  while (renderCache.size > RENDER_CACHE_LIMIT || renderCacheSize > RENDER_CACHE_CHAR_LIMIT) {
    const oldest = renderCache.keys().next().value
    if (oldest === undefined) break
    const removed = renderCache.get(oldest)
    if (removed) renderCacheSize -= removed.size
    renderCache.delete(oldest)
  }
  return html
}

export function toggleMarkdownTask(source: string, taskIndex: number, checked: boolean): string {
  let current = 0
  return source.replace(/^(\s*(?:[-+*]|\d+[.)])\s+\[)([ xX])(\])/gm, (match, prefix: string, _marker: string, suffix: string) => {
    if (current++ !== taskIndex) return match
    return `${prefix}${checked ? "x" : " "}${suffix}`
  })
}
