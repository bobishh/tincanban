import { describe, expect, it, vi } from "vitest"
import { renderMarkdown, toggleMarkdownTask } from "./markdown"

describe("shared Markdown rendering", () => {
  it("Given an external Markdown resource, when rendered, then it opens separately while relative navigation stays local", () => {
    const html = renderMarkdown("[Resource](https://example.org/resource) [Relative](/agent) [Section](#details)\n\nhttps://example.org/automatic")
    expect(html).toContain('href="https://example.org/resource" target="_blank" rel="noopener noreferrer"')
    expect(html).toContain('href="https://example.org/automatic" target="_blank" rel="noopener noreferrer"')
    expect(html).toContain('<a href="/agent">Relative</a>')
    expect(html).toContain('<a href="#details">Section</a>')
  })

  it("Given a browser origin and an imperfect resource URL, when rendered, then local links stay local and the document still renders", () => {
    vi.stubGlobal("location", { origin: "https://tincanban.test" })
    try {
      const html = renderMarkdown("[Same site](https://tincanban.test/agent) [Imperfect](https://example.org:invalid/resource)")
      expect(html).toContain('<a href="https://tincanban.test/agent">Same site</a>')
      expect(html).toContain('href="https://example.org:invalid/resource" target="_blank"')
    } finally { vi.unstubAllGlobals() }
  })

  it("renders structured content and preserves ordinary note line breaks", () => {
    const html = renderMarkdown("# Plan\n\n**Important**\nNext line\n\n- [ ] First\n- [x] Done\n\n`code`")
    expect(html).toContain("<h1>Plan</h1>")
    expect(html).toContain("<strong>Important</strong><br>")
    expect(html).toContain('type="checkbox"')
    expect(html).toContain('checked="checked"')
    expect(html).toContain('disabled="disabled"')
    expect(html).not.toContain('id="task-item')
    expect(html).toContain("<code>code</code>")
  })

  it("keeps untrusted HTML and executable links out of generated markup", () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)>\n<script>alert(1)</script>\n\n[run](javascript:alert(1))\n\n![run](data:text/html;base64,PHNjcmlwdD4=)')
    expect(html).not.toMatch(/<(?:img|script)\b/)
    expect(html).not.toContain('href="javascript:')
    expect(html).not.toContain('src="data:')
    expect(html).toContain("&lt;script&gt;")
  })

  it("renders card previews without nested interactive elements", () => {
    const html = renderMarkdown('- [ ] **First**\n- [x] Done\n\n[site](https://example.com)\n\n![photo](https://example.com/image.png)', true)
    expect(html).not.toMatch(/<(?:a|input|img)\b/)
    expect(html).toContain("☐ ")
    expect(html).toContain("☑ ")
    expect(html).toContain("<strong>First</strong>")
  })

  it("indexes editable tasks and updates only the selected source marker", () => {
    const source = "- [ ] First\n  - [x] Nested\n1. [ ] Numbered"
    const html = renderMarkdown(source, true, true)
    expect(html).toContain('data-task-index="0"')
    expect(html).toContain('data-task-index="2"')
    expect(html).not.toContain('disabled="disabled"')
    expect(toggleMarkdownTask(source, 1, false)).toBe("- [ ] First\n  - [ ] Nested\n1. [ ] Numbered")
  })

  it("keeps cached output separate for preview and interactive-task modes", () => {
    const source = "- [ ] First\n- [x] Done\n\n[site](https://example.com)"
    const full = renderMarkdown(source)
    const preview = renderMarkdown(source, true)
    const editablePreview = renderMarkdown(source, true, true)

    expect(full).toContain('type="checkbox"')
    expect(full).toContain('disabled="disabled"')
    expect(preview).toContain("☐ ")
    expect(preview).not.toContain('type="checkbox"')
    expect(editablePreview).toContain('data-task-index="0"')
    expect(editablePreview).not.toContain('disabled="disabled"')
    expect(renderMarkdown(source, true)).toBe(preview)
  })
})

it("Given hashes in prose, code and links, when rendered, then hashes have copy controls without breaking links or nesting controls in card previews", () => {
  const hash = "a".repeat(64)
  const html = renderMarkdown(`Intake: ${hash}\n\n\`${hash}\`\n\n[Source](https://example.org/${hash})`)
  expect(html.match(/data-copy-code/g)).toHaveLength(2)
  expect(html).toContain(`<code>${hash}</code>`)
  expect(html).toContain(`href="https://example.org/${hash}"`)
  expect(renderMarkdown(`Intake: ${hash}`, true)).not.toContain("data-copy-code")
  expect(renderMarkdown(`https://example.org/${hash}`)).not.toContain("data-copy-code")
})

it("Given hashes already inside fenced code or a link label, when rendered, then standalone code is copyable and links contain no buttons", () => {
  const hash = "b".repeat(64)
  const fenced = renderMarkdown(`\`\`\`\n${hash}\n\`\`\``)
  expect(fenced).toContain("data-copy-code")
  const linked = renderMarkdown(`[\`${hash}\`](https://example.org) [${hash}](https://example.org)`)
  expect(linked).not.toContain("data-copy-code")
})
