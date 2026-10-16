import type * as StartupDiagnostics from "./startupDiagnosticsTransport"
type Diagnostics = typeof StartupDiagnostics

async function diagnostics(): Promise<Diagnostics | undefined> {
  if (import.meta.env.VITE_STARTUP_DIAGNOSTICS !== "1") return undefined
  try { return await import("./startupDiagnosticsTransport") }
  catch { return undefined }
}

export async function diagnoseStartupStep<T>(stage: string, step: () => T | Promise<T>, detail: Record<string, unknown> = {}): Promise<T> {
  const value = await diagnostics()
  return value ? value.diagnoseStartupStep(stage, step, detail) : step()
}

export async function beginStartupDiagnostics(): Promise<void> {
  await (await diagnostics())?.beginStartupDiagnostics()
}
