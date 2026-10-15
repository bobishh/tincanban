import assert from "node:assert/strict";
import test from "node:test";
import { appendPostingObservation, correlateApplicationSource, createApplicationSource } from "../src/applicationSource.ts";
import type { ForwardedMail } from "../src/email.ts";

const fetchedAt = "2026-10-14T08:00:00.000Z";
const extractionVersion = "job-page@1";

function mail(overrides: Partial<ForwardedMail> = {}): ForwardedMail {
  return {
    messageId: "rejection-1",
    inReplyTo: null,
    references: [],
    from: "Hiring Team",
    to: "owner@example.test",
    subject: "Application update",
    text: "Thank you for applying to Acme for Staff Platform Engineer. We will not proceed.",
    date: "2026-10-14T09:00:00.000Z",
    urls: [],
    confirmation: false,
    attachments: [],
    ...overrides,
  };
}

function source(applicationId: string, role: string, jobUrl = `https://jobs.example.test/${applicationId}`) {
  return createApplicationSource({
    applicationId,
    cardId: `${applicationId}-card`,
    jobUrl,
    company: "Acme",
    role,
    description: `${role} role at Acme`,
    fetchedAt,
    extractionVersion,
  });
}

test("Given an edited display label, when rejection names the retained original title, then match the application", () => {
  const original = source("app-1", "Staff Platform Engineer");
  const result = correlateApplicationSource(mail(), [original]);

  assert.deepEqual(result, { kind: "matched", cardId: "app-1-card", method: "company-role" });
});

test("Given a posting later changes or returns 404, when observations are appended, then original evidence still matches", () => {
  const original = source("app-1", "Staff Platform Engineer");
  const changedPage = appendPostingObservation(original, {
    company: "Acme",
    role: "Join Our Talent Network",
    description: "Generic careers page",
    fetchedAt: "2026-10-15T08:00:00.000Z",
    extractionVersion,
  });
  const unavailablePage = appendPostingObservation(changedPage, {
    status: "not-found",
    fetchedAt: "2026-10-16T08:00:00.000Z",
    extractionVersion,
  });

  assert.equal(original.observations.length, 1);
  assert.equal(original.original.role, "Staff Platform Engineer");
  assert.equal(unavailablePage.original.role, "Staff Platform Engineer");
  assert.equal(changedPage.observations.length, 2);
  assert.equal(unavailablePage.observations.length, 3);
  assert.deepEqual(correlateApplicationSource(mail(), [unavailablePage]), {
    kind: "matched", cardId: "app-1-card", method: "company-role",
  });
});

test("Given two same-company applications without role evidence, when generic rejection arrives, then leave it for review", () => {
  const first = source("app-engineer", "Staff Platform Engineer");
  const second = source("app-designer", "Product Designer");
  const result = correlateApplicationSource(mail({ text: "Acme has decided not to move forward with your application." }), [first, second]);

  assert.equal(result.kind, "review");
  assert.deepEqual(result.kind === "review" ? result.candidates : [], ["app-engineer-card", "app-designer-card"]);
});

test("Given distinct exact references, when mail matches a URL or known thread, then exact source wins over role evidence", () => {
  const first = source("app-engineer", "Staff Platform Engineer", "https://jobs.example.test/engineer");
  const second = source("app-designer", "Product Designer", "https://jobs.example.test/designer");
  const threaded = { ...second, messageIds: ["application-thread-2"] };

  assert.deepEqual(correlateApplicationSource(mail({ urls: [second.jobUrl] }), [first, second]), {
    kind: "matched", cardId: "app-designer-card", method: "job-url",
  });
  assert.deepEqual(correlateApplicationSource(mail({ inReplyTo: "application-thread-2" }), [first, threaded]), {
    kind: "matched", cardId: "app-designer-card", method: "thread",
  });
});

test("Given a record and refresh observation, when refresh is applied twice, then output is deterministic and inputs stay immutable", () => {
  const original = source("app-1", "Staff Platform Engineer");
  const observation = {
    company: "Acme",
    role: "Staff Platform Engineer",
    description: "Updated description",
    fetchedAt: "2026-10-15T08:00:00.000Z",
    extractionVersion,
  };
  const before = structuredClone(original);
  const first = appendPostingObservation(original, observation);
  const second = appendPostingObservation(original, observation);

  assert.deepEqual(original, before);
  assert.deepEqual(first, second);
  assert.notEqual(first, original);
  assert.notEqual(first.observations, original.observations);
});
