import { describe, expect, it } from "vitest";
import { handleClassificationRequest } from "../src/classificationEndpoint";

const token = "abcdef0123456789abcdef0123456789";

describe("private classification endpoint", () => {
  it("returns an existing confirmation review without exposing a general AI prompt", async () => {
    const request = new Request("https://automation.example/internal/classify", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        event: { source: "email", receivedAt: "2026-10-16T10:00:00.000Z", rawMime: "", message: {
          messageId: null, inReplyTo: null, references: [], from: "jobs@example.com", to: "owner@example.com",
          subject: "Confirm forwarding", text: "Confirm your forwarding address", date: null, urls: [], confirmation: true, attachments: [],
        } },
        context: {},
      }),
    });
    const response = await handleClassificationRequest(request, workerEnv());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "review", reason: "Forwarding-address confirmation requires owner attention" });
  });

  it("authenticates before parsing untrusted request bodies", async () => {
    const request = new Request("https://automation.example/internal/classify", {
      method: "POST", headers: { "content-type": "application/json" }, body: "not-json",
    });

    const response = await handleClassificationRequest(request, workerEnv());

    expect(response.status).toBe(401);
  });

  it("rejects a private website URL before classification can fetch it", async () => {
    const request = new Request("https://automation.example/internal/classify", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        event: { source: "website", receivedAt: "2026-10-16T10:00:00.000Z", submission: {
          message: "Role", contact: "", company: "Example", role: "Engineer", jobUrl: "https://127.0.0.1/admin",
        } },
        context: {},
      }),
    });

    await expect(handleClassificationRequest(request, workerEnv())).rejects.toThrow(/public HTTPS URL/);
  });
});

function workerEnv() {
  return {
    CLASSIFICATION_SERVICE_TOKEN: token,
    AI: { run: async () => { throw new Error("unexpected AI invocation"); } },
  } as never;
}
