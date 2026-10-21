export type CapturedException = {
  "exception.type": string
  "exception.message"?: string
  "exception.stacktrace"?: string
}

const maxCauseDepth = 8
const maxMessageLength = 2_048
const maxStackLength = 16_384
const safeType = /^[A-Za-z_$][A-Za-z0-9_$.:]{0,127}$/
const encoder = new TextEncoder()

function boundedUtf8(value: string, limit: number): string {
  if (encoder.encode(value).byteLength <= limit) return value
  const budget = limit - encoder.encode("…").byteLength
  if (budget < 0) return ""
  let bytes = 0
  let end = 0
  for (const character of value) {
    const size = encoder.encode(character).byteLength
    if (bytes + size > budget) break
    bytes += size
    end += character.length
  }
  return `${value.slice(0, end)}…`
}

function property(value: object, key: string): unknown {
  try { return Reflect.get(value, key) } catch { return undefined }
}

function exceptionType(value: unknown): string {
  if (typeof value === "string") return "String"
  if (value === null) return "Null"
  if (value instanceof AggregateError) return "AggregateError"
  if (typeof DOMException !== "undefined" && value instanceof DOMException) {
    const name = value.name
    return safeType.test(name) ? name : "DOMException"
  }
  if (value instanceof Error) {
    const name = value.constructor?.name
    return typeof name === "string" && safeType.test(name) ? name : "Error"
  }
  if (typeof value === "number") return "Number"
  if (typeof value === "boolean") return "Boolean"
  if (typeof value === "bigint") return "BigInt"
  if (typeof value === "symbol") return "Symbol"
  return "Object"
}

function exceptionMessage(value: unknown): string | undefined {
  if (typeof value === "string") return value
  if (value === null || ["number", "boolean", "bigint", "symbol"].includes(typeof value)) return String(value)
  if (!value || typeof value !== "object") return undefined
  const message = property(value, "message")
  return typeof message === "string" ? message : undefined
}

function redactSecrets(input: string): string {
  let value = input
  value = value.replace(/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z]+ )?PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]")
  value = value.replace(/\b(Bearer|Basic)\s+[^\s,;"']+/gi, "$1 [REDACTED]")
  // Private-key collections can be JSON-like objects; mask the full shallow value.
  value = value.replace(/(["']?private[_-]?keys["']?\s*[:=]\s*)\{[^{}]*\}/gi, "$1[REDACTED]")
  // Preserve surrounding failure text and field names, but never credential values.
  value = value.replace(/(["']?(?:(?:identity[_-]?|device[_-]?)?private[_-]?key(?:[_-]?pkcs8)?|content[_-]?key|read[_-]?token|write[_-]?token|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|password|passwd|secret|authorization|client[_-]?secret|token|credential)["']?\s*[:=]\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|(?:Bearer|Basic) \[REDACTED\]|[^"'&,}#\s]+)/gi,
    (_match, prefix: string, secret: string) => {
      if (/^(?:Bearer|Basic) \[REDACTED\]$/i.test(secret)) return `${prefix}${secret}`
      const quote = secret.startsWith('"') || secret.startsWith("'") ? secret[0] : ""
      return `${prefix}${quote}[REDACTED]${quote}`
    })
  value = value.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@")
  return value
}

function boundedText(value: string | undefined, limit: number): string | undefined {
  if (value === undefined) return undefined
  const sanitized = Array.from(redactSecrets(value)).filter(character => {
    const code = character.charCodeAt(0)
    return code === 9 || code === 10 || code === 13 || code >= 32 && code !== 127
  }).join("")
  return boundedUtf8(sanitized, limit)
}

function causeValues(value: unknown): unknown[] {
  if (!value || typeof value !== "object") return []
  const causes: unknown[] = []
  const cause = property(value, "cause")
  if (cause !== undefined) causes.push(cause)
  if (value instanceof AggregateError) {
    try { for (const item of value.errors) causes.push(item) } catch { /* Malformed aggregate; preserve root exception. */ }
  }
  return causes
}

/** Return bounded OpenTelemetry exception attributes, retaining readable context while redacting credentials. */
export function capturedException(error: unknown): CapturedException {
  const rootType = exceptionType(error)
  const rootMessage = boundedText(exceptionMessage(error), maxMessageLength)
  const lines: string[] = []
  const seen = new Set<object>()
  let size = 0

  const append = (text: string) => {
    const separatorBytes = lines.length ? 1 : 0
    const remaining = maxStackLength - size - separatorBytes
    if (remaining <= 0) return
    const chunk = boundedUtf8(text, remaining)
    if (!chunk) return
    lines.push(chunk)
    size += encoder.encode(chunk).byteLength + separatorBytes
  }
  const visit = (value: unknown, depth: number, root: boolean): void => {
    if (depth >= maxCauseDepth || size >= maxStackLength) return
    if (value !== null && typeof value === "object") {
      if (seen.has(value)) { append("Caused by [circular exception omitted]"); return }
      seen.add(value)
    }
    const type = exceptionType(value)
    const message = boundedText(exceptionMessage(value), maxMessageLength)
    const stack = value && typeof value === "object" ? property(value, "stack") : undefined
    if (root) {
      if (typeof stack === "string") append(boundedText(stack, maxStackLength)!)
      else append(`${type}${message ? `: ${message}` : ""}`)
    } else {
      append(`Caused by ${type}${message ? `: ${message}` : ""}`)
      if (typeof stack === "string") append(boundedText(stack, maxStackLength)!)
    }
    for (const cause of causeValues(value)) visit(cause, depth + 1, false)
  }
  visit(error, 0, true)

  return {
    "exception.type": rootType,
    ...(rootMessage === undefined ? {} : { "exception.message": rootMessage }),
    ...(lines.length ? { "exception.stacktrace": boundedUtf8(lines.join("\n"), maxStackLength) } : {}),
  }
}
