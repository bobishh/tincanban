import { expect, test, vi } from "vitest";
import { forwardRefluxRequest } from "../src/refluxClient";

const env = { REFLUX_ORIGIN: "https://reflux.example", REFLUX_SERVICE_TOKEN: "service-credential-with-at-least-32-bytes", PUBLIC_ORIGIN: "https://automation.example" };

test("Given a signed management POST, when Reflux owns execution, then forward the exact body and public signing origin over HTTP", async () => {
  const body = JSON.stringify({ instanceRequest: { signature: "original-signature" }, body: { integrationId: "integration-1" } });
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    expect(request.url).toBe("https://reflux.example/internal/tincanban/v2/automation-instances/identity");
    expect(request.headers.get("authorization")).toBe(`Bearer ${env.REFLUX_SERVICE_TOKEN}`);
    expect(request.headers.get("x-tincanban-public-origin")).toBe(env.PUBLIC_ORIGIN);
    expect(await request.text()).toBe(body);
    expect(request.redirect).toBe("manual");
    return Response.json({ proof: "signed-result" });
  });
  vi.stubGlobal("fetch", fetchMock);
  try {
    const response = await forwardRefluxRequest(new Request(`${env.PUBLIC_ORIGIN}/v2/automation-instances/identity`, {
      method: "POST", headers: { "content-type": "application/json", "x-tincanban-public-origin": "https://attacker.example" }, body,
    }), env, new Headers({ "access-control-allow-origin": "https://board.example" }));
    expect(await response.json()).toEqual({ proof: "signed-result" });
    expect(response.headers.get("access-control-allow-origin")).toBe("https://board.example");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  } finally { vi.unstubAllGlobals(); }
});

test("Given Reflux returns a plain gateway error, when management runs, then preserve HTTP status and never fall back to another writer", async () => {
  const fetchMock = vi.fn(async () => new Response("error code: 502", { status: 502 }));
  vi.stubGlobal("fetch", fetchMock);
  try {
    const response = await forwardRefluxRequest(new Request(`${env.PUBLIC_ORIGIN}/v2/automation-instances/identity`, {
      method: "POST", body: "{}", headers: { "content-type": "application/json" },
    }), env, new Headers());
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Reflux is unavailable (HTTP 502). Retry the same operation." });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  } finally { vi.unstubAllGlobals(); }
});

test("Given an unavailable or unconfigured Reflux, when forwarding runs, then report pending service availability without local execution", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network unavailable"); }));
  try {
    const request = () => new Request(`${env.PUBLIC_ORIGIN}/v2/automation-instances/identity`, { method: "POST", body: "{}" });
    expect((await forwardRefluxRequest(request(), env, new Headers())).status).toBe(503);
    expect((await forwardRefluxRequest(request(), { ...env, REFLUX_SERVICE_TOKEN: undefined }, new Headers())).status).toBe(503);
  } finally { vi.unstubAllGlobals(); }
});


test("Given a cached website form, when it POSTs a challenge, then use the existing public Reflux intake route", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    expect(request.url).toBe("https://reflux.example/v1/challenge");
    expect(request.headers.get("origin")).toBe("https://match.example");
    expect(request.headers.get("authorization")).toBeNull();
    expect(await request.json()).toEqual({ integrationId: "same-integration" });
    return Response.json({ challenge: "original-challenge" });
  }));
  try {
    const response = await forwardRefluxRequest(new Request(`${env.PUBLIC_ORIGIN}/v1/challenge`, {
      method: "POST", headers: { origin: "https://match.example", "content-type": "application/json" },
      body: JSON.stringify({ integrationId: "same-integration" }),
    }), env, new Headers());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ challenge: "original-challenge" });
  } finally { vi.unstubAllGlobals(); }
});

test("Given the private email-ingress path, when the generic Reflux proxy receives path variants, then never expose the private endpoint", async () => {
  const fetchMock = vi.fn(async () => Response.json({ ok: true }));
  vi.stubGlobal("fetch", fetchMock);
  try {
    for (const path of [
      "/v2/integrations/integration-1/email-ingress",
      "/v2/integrations/integration-1/email-ingress/",
      "/v2/integrations/integration-1%2Femail-ingress",
      "/v2/integrations/integration-1/email-ingress%2Fretry",
    ]) {
      const response = await forwardRefluxRequest(new Request(`https://automation.example${path}`, { method: "POST", body: "{}" }), env, new Headers());
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "Not found" });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  } finally { vi.unstubAllGlobals(); }
});
