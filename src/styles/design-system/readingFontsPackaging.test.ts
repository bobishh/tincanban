import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { expect, it } from "vitest"

const root = resolve(import.meta.dirname, "../../..")
const read = (path: string) => readFileSync(resolve(root, path), "utf8")

it("Given reading typography surfaces, when styles are packaged, then Fira Sans loads only with lazy detail and chat surfaces", () => {
  const typography = read("src/styles/design-system/typography.css")
  const foundation = read("public/assets/site-foundation.css")
  const readingFonts = read("src/styles/design-system/reading-fonts.css")
  const detail = read("src/components/ItemDetailDialog.vue")
  const chat = read("src/components/WorkspaceChat.vue")
  const jsonSettings = read("src/components/schema-editor/SchemaWorkspaceJsonSection.vue")

  expect(typography).not.toMatch(/@font-face\s*\{[^}]*font-family:\s*["']Fira Sans["']/su)
  expect(foundation).not.toMatch(/@font-face\s*\{[^}]*font-family:\s*["']Fira Sans["']/su)
  expect(readingFonts.match(/font-family:\s*["']Fira Sans["']/gu)).toHaveLength(12)
  expect(readingFonts.match(/src:\s*url\(["']\/assets\/fira-sans-[^)]*\.woff2["']\)/gu)).toHaveLength(12)
  expect(detail).toContain("reading-fonts.css")
  expect(chat).toContain("reading-fonts.css")
  expect(typography).not.toContain(".detail-layout .detail-copy")
  expect(typography).not.toContain(".chat-dialog .chat-message-body")
  expect(typography).not.toContain(".chat-dialog textarea.chat-textarea")
  expect(typography).not.toContain("--site-font-body-size:")
  expect(typography).not.toContain("--site-font-meta-size:")
  expect(typography).not.toContain("--site-font-line:")
  expect(readingFonts).toContain(".detail-layout .detail-copy, .detail-layout .detail-copy.reading-prose, .detail-layout .source-snapshot")
  expect(readingFonts).toContain(".chat-dialog .chat-message-body, .chat-dialog textarea.chat-textarea")
  expect(readingFonts).toContain("font-family: var(--site-font-reading)")
  expect(readingFonts).toContain("font-size: var(--site-font-body-size, 16px)")
  expect(readingFonts).toContain("line-height: var(--site-font-line, 1.5)")
  // Given detail and chat Markdown roots inherit `.markdown-content` sizing,
  // when lazy reading styles load, then prose must keep the 16px reading scale.
  expect(readingFonts).toContain(".detail-layout .detail-copy.markdown-content")
  expect(readingFonts).toContain(".chat-dialog .chat-message-body.markdown-content")
  expect(readingFonts).toContain("font-size: var(--site-font-body-size, 16px)")
  expect(readingFonts).toContain("line-height: var(--site-font-line, 1.5)")
  expect(typography).not.toContain("schema-json-textarea")
  expect(jsonSettings).toContain("textarea.schema-json-textarea")
  expect(jsonSettings).toContain("font: 400 max(.7rem, 14px)/1.5 var(--site-font-mono)")
})
