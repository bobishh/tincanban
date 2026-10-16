import "./copyableCode.css"

export async function copyCodeBlock(event: MouseEvent) {
  const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-copy-code]") : null
  const block = button?.closest("[data-code-block]")
  const code = block?.querySelector("code")
  const status = block?.querySelector<HTMLElement>('[role="status"]')
  if (!button || !code || !status) return
  event.stopPropagation()
  try {
    await navigator.clipboard.writeText(code.textContent ?? "")
    status.textContent = "Copied"
  } catch {
    status.textContent = "Could not copy. Select the code and copy it manually."
  }
}

// Values here are parser tokens or application data, never trusted HTML.
export function copyableCodeHtml(value: string, label: string) {
  const escape = (text: string) => text.replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!)
  return `<span class="copyable-code" data-code-block role="group" aria-label="${escape(label)}"><code>${escape(value)}</code><button class="button button-small button-quiet" type="button" data-copy-code aria-label="Copy ${escape(label)}">Copy</button><span class="reading-explanation" role="status" aria-live="polite"></span></span>`
}
