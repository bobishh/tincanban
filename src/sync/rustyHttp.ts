/* global __TINCANBAN_BUILD_COMMIT__ */
import { rustyRequestFailure } from "./replicationErrors"
import type { Context } from "@opentelemetry/api"
import { diagnosticHttpRequest } from "../domain/httpDiagnostics"
import { fetchRusty, readRustyJson } from "@meta-uber/mesh-replication/rusty-replica"

export type RustyRequestInit = RequestInit & { diagnosticContext?: Context }

export async function fetchBlind(url: string, init: RustyRequestInit): Promise<Response> {
  const { diagnosticContext, ...requestInit } = init
  const headers = new Headers(init.headers)
  if (!headers.has("X-Rusty-Client")) headers.set("X-Rusty-Client", "tincanban")
  const build = typeof __TINCANBAN_BUILD_COMMIT__ === "undefined" ? "" : __TINCANBAN_BUILD_COMMIT__
  if (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(build) && !headers.has("X-Rusty-Build")) headers.set("X-Rusty-Build", build)
  try {
    return await diagnosticHttpRequest(url, { ...requestInit, headers }, fetchRusty, diagnosticContext)
  } catch (error) {
    throw rustyRequestFailure(error)
  }
}

export async function readBlindJson<T>(response: Response, maximumBytes = 32 * 1024 * 1024): Promise<T> {
  try { return await readRustyJson(response, maximumBytes) as T }
  catch (cause) { throw rustyRequestFailure(cause, response.status) }
}

