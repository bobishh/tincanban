import { describe, expect, it } from "vitest";
import { captureApplicationSource } from "../src/applicationSourceCapture.ts";
import type { JobPageResult } from "../src/extraction.ts";

const fetchedAt = "2026-10-14T08:00:00.000Z";

function page(overrides: Partial<JobPageResult> = {}): JobPageResult {
  return {
    url: "https://jobs.example.test/opening/42",
    finalUrl: "https://jobs.example.test/opening/42",
    status: 200,
    contentType: "text/html",
    fetchedAt,
    company: "Nacre Light",
    role: "Principal Systems Engineer",
    title: "Generic document title, not the posting title",
    description: "Design reliable systems.",
    body: "The employer's original posting text.",
    source: "jobposting",
    ...overrides,
  };
}

describe("capture original application source", () => {
  it("Given a fetched posting, When capturing it, Then source uses only extracted evidence and deterministic scoped identity", async () => {
    const captured = await captureApplicationSource("workspace-1", "card-1", "event-1", "website", page());
    const repeated = await captureApplicationSource("workspace-1", "card-1", "event-1", "website", page());
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(["workspace-1", "event-1", "original"])));
    const expectedId = btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

    expect(captured.recordId).toBe(expectedId);
    expect(captured).toEqual(repeated);
    expect(captured).toMatchObject({ kind: "application-source-observation", version: 1, workspaceId: "workspace-1",
      cardId: "card-1", applicationId: "workspace-1:card-1", observation: {
        phase: "original", origin: "website", status: "available", jobUrl: "https://jobs.example.test/opening/42",
        company: "Nacre Light", title: "Principal Systems Engineer", text: "The employer's original posting text.",
        observedAt: fetchedAt, extractorVersion: "job-page-v1",
      } });
  });

  it("Given a caller mutates page data while capture hashes its identity, When the promise completes, Then retain the entry snapshot", async () => {
    const input = page();
    const pending = captureApplicationSource("workspace-1", "card-1", "event-mutation", "website", input);
    input.company = "Changed after capture started";
    input.role = "Changed display role";
    input.body = "Caller replaced the posting text";
    input.url = "https://jobs.example.test/changed";

    const result = await pending;
    expect(result.observation).toMatchObject({ status: "available", jobUrl: "https://jobs.example.test/opening/42",
      company: "Nacre Light", title: "Principal Systems Engineer", text: "The employer's original posting text." });
  });

  it("Given absent or incomplete fetch evidence, When capturing, Then return unavailable without invented historical fields", async () => {
    const absent = await captureApplicationSource("workspace-1", "card-1", "event-2", "email", undefined,
      "https://jobs.example.test/opening/42");
    const noUrlOrPage = await captureApplicationSource("workspace-1", "card-1", "event-8", "email", undefined);
    const incomplete = await captureApplicationSource("workspace-1", "card-1", "event-3", "website", page({
      company: "", role: "Principal Systems Engineer", body: "Some content",
    }));

    for (const result of [absent, noUrlOrPage, incomplete]) {
      expect(result.observation).toMatchObject({ phase: "original", status: "unavailable", reason: expect.any(String) });
      expect(result.observation).not.toHaveProperty("company");
      expect(result.observation).not.toHaveProperty("title");
      expect(result.observation).not.toHaveProperty("text");
      expect(result.observation).not.toHaveProperty("extractorVersion");
      expect(result.observation).not.toHaveProperty("contentDigest");
    }
    expect(absent.observation).not.toHaveProperty("observedAt", fetchedAt);
    expect(absent.observation.jobUrl).toBe("https://jobs.example.test/opening/42");
    expect(noUrlOrPage.observation).not.toHaveProperty("jobUrl");
  });

  it("Given retained page text outside canonical source bounds, When capturing, Then downgrade to unavailable without storing partial text", async () => {
    const oversized = await captureApplicationSource("workspace-1", "card-1", "event-4", "website",
      page({ body: "界".repeat(30_000), description: "small fallback" }));

    expect(oversized.observation).toMatchObject({ phase: "original", status: "unavailable", reason: expect.any(String) });
    expect(oversized.observation).not.toHaveProperty("text");
    expect(oversized.observation).not.toHaveProperty("company");
  });

  it("Given invalid page fields or an unsafe URL, When capturing, Then keep a bounded unavailable record", async () => {
    const noTitle = await captureApplicationSource("workspace-1", "card-1", "event-5", "email", page({ role: "  " }));
    const noText = await captureApplicationSource("workspace-1", "card-1", "event-6", "website", page({ body: "", description: "" }));
    const notFound = await captureApplicationSource("workspace-1", "card-1", "event-9", "website", page({ status: 404 }));
    const unsafe = await captureApplicationSource("workspace-1", "card-1", "event-7", "website",
      page({ url: "http://localhost/private", role: "Some title" }));

    for (const result of [noTitle, noText, notFound, unsafe]) {
      expect(result.observation.status).toBe("unavailable");
      expect(result.observation.reason).toEqual(expect.any(String));
      expect(result.observation).not.toHaveProperty("title");
      expect(result.observation).not.toHaveProperty("text");
    }
  });
});
