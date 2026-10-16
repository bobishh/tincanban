import assert from "node:assert/strict";
import test from "node:test";
import { callActiveExecutor } from "../src/executorClient.ts";

const originalFetch = globalThis.fetch;
function setFetch(fetcher: typeof fetch): void { globalThis.fetch = fetcher; }
function restoreFetch(): void { globalThis.fetch = originalFetch; }

test("Given an acknowledged integration route, when management RPC runs, then it uses scoped authentication and arguments", async () => {
  const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
  setFetch(async (input, init) => { calls.push([input, init]); return Response.json({ status: "ok" }); });
  try {
    const env = workerEnv({ origin: "https://executor.example", epoch: 7 });
    const args = [{ workspaceId: "workspace" }, "nonce", "https://automation.example"];

    const result = await callActiveExecutor(env, "integration-1", "observeOwner", args, async () => {
      throw new Error("local writer must stay fenced after executor acknowledgement");
    });

    assert.deepEqual(result, { status: "ok" });
    assert.equal(calls.length, 1);
    const [url, init] = calls[0]!;
    assert.equal(url, "https://executor.example/internal/integrations/integration-1/rpc");
    assert.deepEqual(init?.headers, {
      authorization: "Bearer 0123456789abcdef0123456789abcdef",
      "content-type": "application/json",
      "x-tincanban-executor-epoch": "7",
    });
    assert.deepEqual(JSON.parse(String(init?.body)), { method: "observeOwner", args });
  } finally { restoreFetch(); }
});

test("Given no acknowledged migration route, when an RPC runs, then it stays local", async () => {
  const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
  setFetch(async (input, init) => { calls.push([input, init]); return Response.json({ status: "unexpected" }); });
  try {
    const env = workerEnv(null);

    assert.equal(await callActiveExecutor(env, "integration-1", "getEvent", ["event"], async () => "local-event"), "local-event");

    assert.equal(calls.length, 0);
  } finally { restoreFetch(); }
});

test("Given a route for another origin, when used, then transport fails closed", async () => {
  const env = workerEnv({ origin: "https://unexpected.example", epoch: 1 });

  await assert.rejects(callActiveExecutor(env, "integration-1", "getEvent", ["event"], async () => "local-event"),
    /does not match configured executor origin/);
});

function workerEnv(route: { origin: string; epoch: number } | null) {
  const coordinator = { executionRoute: async () => route };
  return {
    AUTOMATION: { getByName: () => coordinator },
    EXECUTOR_ORIGIN: "https://executor.example",
    EXECUTOR_SERVICE_TOKEN: "0123456789abcdef0123456789abcdef",
  } as never;
}
