import { expect, test, vi } from "vitest";
import { bootstrapFreshExecutor, callActiveExecutor, submitExecutorItemCommand } from "../src/executorClient";
import { freshBindingHash } from "../src/executorFresh";

test("Given an acknowledged integration route, when management RPC runs, then it uses scoped authentication and arguments", async () => {
  const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    // Validate against workerd's actual Request API rather than accepting any mock options.
    expect(new Request(input, init).redirect).toBe("manual");
    calls.push([input, init]);
    return Response.json({ status: "ok" });
  });
  try {
    const env = workerEnv({ origin: "https://executor.example", epoch: 7 });
    const args = [{ workspaceId: "workspace" }, "nonce", "https://automation.example"];
    const result = await callActiveExecutor(env, "integration-1", "observeOwner", args, async () => {
      throw new Error("local writer must stay fenced after executor acknowledgement");
    });
    expect(result).toEqual({ status: "ok" });
    expect(calls).toHaveLength(1);
    const [url, init] = calls[0]!;
    expect(url).toBe("https://executor.example/internal/integrations/integration-1/rpc");
    expect(init?.headers).toEqual({
      authorization: "Bearer 0123456789abcdef0123456789abcdef",
      "content-type": "application/json",
      "x-tincanban-executor-epoch": "7",
    });
    expect(JSON.parse(String(init?.body))).toEqual({ method: "observeOwner", args });
  } finally { vi.unstubAllGlobals(); }
});

test("Given no acknowledged migration route, when an RPC runs, then it stays local", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  try {
    const env = workerEnv(null, "");
    await expect(callActiveExecutor(env, "integration-1", "getEvent", ["event"], async () => "local-event")).resolves.toBe("local-event");
    expect(fetchMock).not.toHaveBeenCalled();
  } finally { vi.unstubAllGlobals(); }
});

test("Given a durable fresh reservation, when owner enrollment retries, then it replays bootstrap and verifies the binding", async () => {
  const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
  const binding = { integrationId: "integration-1", ownerPersonId: "owner-1", workspaceId: "workspace-1", origin: "https://executor.example", epoch: 1 };
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(new Request(input, init).redirect).toBe("manual");
    calls.push([input, init]);
    return Response.json({ identity: { personId: "automation-person-1", publicKey: "public-key" },
      device: { deviceId: "device-1", publicKey: "device-key" }, deviceCertificate: {
        payload: { kind: "device-certificate", version: 1, personId: "automation-person-1", deviceId: "device-1", devicePublicKey: "device-key" },
        signerKeyId: "automation-person-1", signature: "signed-certificate",
      }, epoch: binding.epoch, bindingHash: await freshBindingHash(binding) });
  });
  try {
    const env = workerEnv({ origin: binding.origin, epoch: binding.epoch });
    const coordinator = env.AUTOMATION.getByName("integration-1") as unknown as { freshExecutionBinding: () => Promise<typeof binding | null> };
    coordinator.freshExecutionBinding = async () => binding;
    const localCalls: unknown[] = [];
    const result = await callActiveExecutor(env, "integration-1", "enrollOwner", [{ integrationId: binding.integrationId,
      ownerPersonId: binding.ownerPersonId, workspaceId: binding.workspaceId }, "never-forward-this-secret"], async () => {
      localCalls.push(true);
      return bootstrapFreshExecutor(env, binding);
    });
    expect("bindingHash" in (result as object)).toBe(true);
    expect(localCalls).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe("https://executor.example/internal/integrations/integration-1/bootstrap");
    expect(JSON.parse(String(calls[0]![1]?.body))).toEqual(binding);
    expect(JSON.stringify(calls[0]![1]?.body)).not.toContain("never-forward-this-secret");
  } finally { vi.unstubAllGlobals(); }
});

test("Given a redirected executor endpoint, when management or items call it, then credentials never follow the redirect", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(new Request(input, init).redirect).toBe("manual");
    return new Response("redirect", { status: 307, headers: { location: "https://another-service.example/private" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  try {
    const env = workerEnv({ origin: "https://executor.example", epoch: 7 });
    await expect(callActiveExecutor(env, "integration-1", "getEvent", ["event"], async () => null))
      .rejects.toThrow("Executor redirects are not allowed");
    await expect(submitExecutorItemCommand(env, "integration-1", {} as never))
      .rejects.toThrow("Executor redirects are not allowed");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([url]) => String(url).startsWith("https://executor.example/"))).toBe(true);
  } finally { vi.unstubAllGlobals(); }
});

test("Given an absent route in configured production, when legacy authoring is requested, then it fails closed", async () => {
  await expect(callActiveExecutor(workerEnv(null), "integration-1", "activateOwner", [], async () => "legacy-writer"))
    .rejects.toMatchObject({ status: 503 });
});

test("Given an empty unreserved integration, when signed discovery asks for it, then discovery remains local", async () => {
  await expect(callActiveExecutor(workerEnv(null), "integration-1", "manageInstance", [{}, "discover", {}, "https://automation.example"],
    async () => null)).resolves.toBeNull();
});

test("Given a route for another origin, when used, then transport fails closed", async () => {
  await expect(callActiveExecutor(workerEnv({ origin: "https://unexpected.example", epoch: 1 }), "integration-1", "getEvent", ["event"],
    async () => "local-event")).rejects.toThrow(/does not match configured executor origin/);
});

function workerEnv(route: { origin: string; epoch: number } | null, origin = "https://executor.example"): Parameters<typeof callActiveExecutor>[0] {
  const coordinator = { executionRoute: async () => route, freshExecutionBinding: async () => null };
  return {
    AUTOMATION: { getByName: () => coordinator } as never,
    EXECUTOR_ORIGIN: origin,
    EXECUTOR_SERVICE_TOKEN: "0123456789abcdef0123456789abcdef",
  };
}
