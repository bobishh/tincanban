import { describe, expect, it } from "vitest";
import { correlateApplicationSources } from "../src/applicationSourceMatching.ts";
import type { ApplicationCandidate, ForwardedMail } from "../src/email.ts";
import type { ApplicationSourceData } from "../../../src/domain/applicationSourceData.ts";

const time = "2026-10-14T08:00:00.000Z";

function mail(overrides: Partial<ForwardedMail> = {}): ForwardedMail {
  return {
    messageId: "<rejection@example.test>", inReplyTo: null, references: [], from: "Hiring Team",
    to: "owner@example.test", subject: "Application update", text: "Thank you for applying.",
    date: "2026-10-14T09:00:00.000Z", urls: [], confirmation: false, attachments: [], ...overrides,
  };
}

function source(cardId: string, company: string, title: string, options: {
  recordId?: string; status?: "available" | "pending" | "not-found" | "unavailable"; jobUrl?: string; observedAt?: string;
  phase?: "original" | "refresh" | "legacy"; originalRecordId?: string;
} = {}): ApplicationSourceData {
  const recordId = options.recordId ?? `${cardId}-source`;
  const status = options.status ?? "available";
  return {
    kind: "application-source-observation", version: 1, recordId, workspaceId: "workspace-1", cardId,
    applicationId: `workspace-1:${cardId}`,
    observation: options.phase === "legacy"
      ? { phase: "legacy", origin: "legacy", status: "missing-evidence", observedAt: options.observedAt ?? time }
      : options.phase === "refresh"
        ? status === "available"
          ? { phase: "refresh", origin: "website", status, observedAt: options.observedAt ?? time,
            ...(options.jobUrl ? { jobUrl: options.jobUrl } : {}), originalRecordId: options.originalRecordId ?? "original",
            company, title, text: `${title} at ${company}`, extractorVersion: "job-page-v1", contentDigest: "a".repeat(43) }
          : { phase: "refresh", origin: "website", status,
            observedAt: options.observedAt ?? time, ...(options.jobUrl ? { jobUrl: options.jobUrl } : {}),
            originalRecordId: options.originalRecordId ?? "original" }
        : status === "available"
          ? { phase: "original", origin: "website", status, observedAt: options.observedAt ?? time,
            ...(options.jobUrl ? { jobUrl: options.jobUrl } : {}), company, title, text: `${title} at ${company}`,
            extractorVersion: "job-page-v1", contentDigest: "a".repeat(43) }
          : { phase: "original", origin: "website", status, observedAt: options.observedAt ?? time,
            ...(options.jobUrl ? { jobUrl: options.jobUrl } : {}) },
  } as ApplicationSourceData;
}

function candidate(cardId: string, sources: ApplicationSourceData[], overrides: Partial<ApplicationCandidate> = {}) {
  return { cardId, company: "Editable display company", role: "Editable display title",
    jobUrl: "https://display.example.test/wrong-role", messageIds: ["<wrong-thread@example.test>"], sources, ...overrides };
}

describe("source-backed application matching", () => {
  it("Given incorrect editable labels and no page fetch, When mail names the original role, Then match from retained posting evidence", () => {
    const result = correlateApplicationSources(mail({ text: "Nacre Light will not proceed with Principal Systems Engineer.",
      references: ["<wrong-thread@example.test>"], urls: ["https://display.example.test/wrong-role"] }), [
      candidate("card-1", [source("card-1", "Nacre Light", "Principal Systems Engineer")]),
    ]);
    expect(result).toEqual({ kind: "matched", cardId: "card-1", method: "company-role" });
  });

  it("Given a refresh reports a generic page or 404, When original posting text still matches, Then use only the original", () => {
    const original = source("card-1", "Nacre Light", "Principal Systems Engineer", { jobUrl: "https://jobs.example.test/original" });
    const genericRefresh = source("card-1", "Generic careers", "Join our talent network", {
      recordId: "refresh-generic", phase: "refresh", originalRecordId: original.recordId,
      jobUrl: "https://jobs.example.test/current", observedAt: "2026-10-16T08:00:00.000Z",
    });
    const notFoundRefresh = source("card-1", "", "", {
      recordId: "refresh-404", phase: "refresh", status: "not-found", originalRecordId: original.recordId,
      jobUrl: "https://jobs.example.test/current", observedAt: "2026-10-17T08:00:00.000Z",
    });
    const result = correlateApplicationSources(mail({ text: "Nacre Light rejected my Principal Systems Engineer application." }), [
      candidate("card-1", [original, genericRefresh, notFoundRefresh]),
    ]);
    expect(result).toEqual({ kind: "matched", cardId: "card-1", method: "company-role" });
    const refreshOnlyTitle = correlateApplicationSources(mail({ text: "Nacre Light rejected my Join our talent network application." }), [
      candidate("card-1", [original, genericRefresh, notFoundRefresh]),
    ]);
    expect(refreshOnlyTitle).toMatchObject({ kind: "review", candidates: ["card-1"] });
  });

  it("Given an unavailable original with an exact retained URL, When that URL appears in the mail, Then it can identify its card", () => {
    const unavailable = source("card-1", "", "", { status: "unavailable", jobUrl: "https://jobs.example.test/opening/42?utm_source=mail" });
    const result = correlateApplicationSources(mail({ urls: ["https://jobs.example.test/opening/42"] }), [
      candidate("card-1", [unavailable]),
      candidate("card-2", [source("card-2", "Nacre Light", "Product Designer")]),
    ]);
    expect(result).toEqual({ kind: "matched", cardId: "card-1", method: "job-url" });
  });

  it("Given two same-company originals, When mail has no role evidence, Then keep both candidates for review", () => {
    const result = correlateApplicationSources(mail({ text: "Nacre Light decided not to proceed with your application." }), [
      candidate("card-1", [source("card-1", "Nacre Light", "Principal Systems Engineer")]),
      candidate("card-2", [source("card-2", "Nacre Light", "Product Designer")]),
    ]);
    expect(result).toMatchObject({ kind: "review", candidates: ["card-1", "card-2"] });
  });

  it("Given a known role match and another application missing original evidence, When mail arrives, Then do not exclude the unknown candidate", () => {
    const result = correlateApplicationSources(mail({ text: "Nacre Light rejected my Principal Systems Engineer application." }), [
      candidate("card-1", [source("card-1", "Nacre Light", "Principal Systems Engineer")]),
      candidate("card-2", [source("card-2", "", "", { phase: "legacy" })]),
    ]);
    expect(result).toMatchObject({ kind: "review", candidates: ["card-1", "card-2"] });
  });

  it("Given duplicate concurrent copies of the same original, When role context matches, Then deduplicate them semantically", () => {
    const first = source("card-1", "Nacre Light", "Principal Systems Engineer", { recordId: "copy-a", observedAt: time });
    const second = source("card-1", "Nacre Light", "Principal Systems Engineer", {
      recordId: "copy-b", observedAt: "2026-10-15T08:00:00.000Z",
    });
    const result = correlateApplicationSources(mail({ text: "Nacre Light rejected my Principal Systems Engineer application." }), [
      candidate("card-1", [first, second]),
    ]);
    expect(result).toEqual({ kind: "matched", cardId: "card-1", method: "company-role" });
  });

  it("Given conflicting originals for one card, When mail matches only one snapshot, Then require review instead of choosing by time", () => {
    const older = source("card-1", "Nacre Light", "Principal Systems Engineer", { recordId: "copy-old", observedAt: time });
    const newer = source("card-1", "Nacre Light", "Product Designer", {
      recordId: "copy-new", observedAt: "2026-10-16T08:00:00.000Z",
    });
    const result = correlateApplicationSources(mail({ text: "Nacre Light rejected my Principal Systems Engineer application." }), [
      candidate("card-1", [older, newer]),
    ]);
    expect(result).toMatchObject({ kind: "review", candidates: ["card-1"] });
  });

  it("Given an unrelated card has conflicting originals, When another card has a unique role match, Then only the selected card's conflict blocks matching", () => {
    const result = correlateApplicationSources(mail({ text: "North Star rejected my Senior Data Engineer application." }), [
      candidate("card-conflict", [
        source("card-conflict", "Nacre Light", "Principal Systems Engineer", { recordId: "conflict-a" }),
        source("card-conflict", "Nacre Light", "Product Designer", { recordId: "conflict-b", observedAt: "2026-10-15T08:00:00.000Z" }),
      ]),
      candidate("card-match", [source("card-match", "North Star", "Senior Data Engineer")]),
    ]);
    expect(result).toEqual({ kind: "matched", cardId: "card-match", method: "company-role" });
  });
});
