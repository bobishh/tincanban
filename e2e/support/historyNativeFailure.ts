import type { Page, TestInfo } from "@playwright/test"

/** Retain synthetic acceptance-fixture input only when the Native capture traps. */
export async function captureHistoryNativeFailures(page: Page, info: TestInfo) {
  await page.exposeFunction("__captureHistoryNativeFailure", async (raw: string) => {
    await info.attach("native-history-capture-failure", {
      body: Buffer.from(raw), contentType: "application/json",
    })
  })
  await page.route("**/src/sync/historyBaselineCapture.ts*", async route => {
    const response = await route.fetch(), source = await response.text()
    const expression = /const preparation = (receivedBasis \? [^\n]+);/
    if (!expression.test(source)) throw new Error("Native history diagnostic capture point is unavailable")
    const body = source.replace(expression, (_, call: string) => `const preparation = (() => {
      try { return ${call}; }
      catch (cause) {
        if (cause instanceof WebAssembly.RuntimeError) {
          const raw = JSON.stringify({ source, error: { message: cause.message, stack: cause.stack } },
            (_, value) => value instanceof Uint8Array ? Array.from(value) : value);
          void globalThis.__captureHistoryNativeFailure(raw.length <= 2 * 1024 * 1024 ? raw :
            JSON.stringify({ error: { message: cause.message, stack: cause.stack }, inputExceededLimit: true }))
            .catch(error => console.error("Native history diagnostic attachment failed", error));
        }
        throw cause;
      }
    })();`)
    await route.fulfill({ response, body })
  })
}
