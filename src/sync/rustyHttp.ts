/* global __TINCANBAN_BUILD_COMMIT__ */
import type { Context } from "@opentelemetry/api"
import { beginDiagnosticHttpRequest } from "./httpDiagnostics"

export type RustyRequestInit = RequestInit & { diagnosticContext?: Context }

export async function fetchBlind(url: string, init: RustyRequestInit): Promise<Response> {
  const { diagnosticContext, ...requestInit } = init
  const headers = new Headers(init.headers)
  if (!headers.has("X-Rusty-Client")) headers.set("X-Rusty-Client", "tincanban")
  const build = typeof __TINCANBAN_BUILD_COMMIT__ === "undefined" ? "" : __TINCANBAN_BUILD_COMMIT__
  if (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(build) && !headers.has("X-Rusty-Build")) headers.set("X-Rusty-Build", build)
  const method = (init.method ?? "GET").toUpperCase()
  const diagnostic = beginDiagnosticHttpRequest(`HTTP ${method}`, { "http.request.method": method, "server.address": new URL(url).host }, diagnosticContext)
  for (const [key, value] of Object.entries(diagnostic.headers)) headers.set(key, value)
  let status: number | undefined
  let failure: unknown
  try {
    const response = await fetch(url, { ...requestInit, headers, redirect: "manual" })
    status = response.status
    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      throw new Error("Rusty redirects are not allowed")
    }
    return response
  } catch (error) {
    failure = error
    throw error
  } finally {
    try { diagnostic.end(failure, status) } catch { /* Diagnostics must preserve the transport result. */ }
  }
}

export async function readBlindJson<T>(response: Response, maximumBytes = 32 * 1024 * 1024): Promise<T> {
  if (!response.body) throw new Error("Empty Rusty response")
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      length += chunk.value.length
      if (length > maximumBytes) { await reader.cancel(); throw new Error("Rusty response too large") }
      chunks.push(chunk.value)
    }
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as T
  if (!response.ok) {
    const error = value as { message?: string; code?: string }
    throw Object.assign(new Error(error.message || `Rusty returned HTTP ${response.status}`), { code: error.code, status: response.status })
  }
  return value
}

