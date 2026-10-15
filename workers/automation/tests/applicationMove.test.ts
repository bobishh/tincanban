import assert from "node:assert/strict";
import test from "node:test";
import { planApplicationMove, planBoundApplicationMove } from "../src/applicationMove.ts";
import type { ForwardedMail } from "../src/email.ts";

const columns = { lead: "lead", applied: "applied", interview: "interview", rejected: "rejected" };
const candidate = { cardId: "upvest", company: "Upvest", role: "Senior Software Engineer (f/m/d)",
  columnId: "applied", workflow: { columnId: "applied", changedAt: "2026-10-13T12:00:00Z" }, messageIds: [] };
const mail: ForwardedMail = { messageId: "upvest-rejection", inReplyTo: null, references: [], from: "Upvest Hiring Team", to: "owner@example.test",
  subject: "Sorry, it’s not a match this time", text: "Thank you for applying to Upvest for Senior Product Engineer (f/m/d). We decided to proceed with other candidates.",
  date: "2026-10-14T07:00:26Z", urls: [], attachments: [], confirmation: false };

test("Given an explicitly bound application, when the original rejection names a different role, then plan only that selected card without lookup", () => {
  assert.deepEqual(planBoundApplicationMove(mail, candidate, columns, "rejection"), { kind: "move", candidate, columnId: "rejected" });
});

test("Given explicit application binding, when mail is stale or status would reverse, then preserve the ordinary workflow guards", () => {
  assert.equal(planBoundApplicationMove({ ...mail, date: null }, candidate, columns, "rejection").kind, "review");
  assert.equal(planBoundApplicationMove({ ...mail, date: "2026-10-12T00:00:00Z" }, candidate, columns, "rejection").kind, "review");
  assert.equal(planBoundApplicationMove(mail, { ...candidate, columnId: "rejected", workflow: { ...candidate.workflow, columnId: "rejected" } }, columns, "interview").kind, "review");
});

test("Given an Upvest rejection naming a different saved role, when matching, then report the missing source without moving another application", async () => {
  assert.deepEqual(await planApplicationMove(mail, [candidate], columns, "rejection"), { kind: "review", reason: "Original posting evidence is missing or unavailable; choose an application" });
});
test("Given a legacy message reference without immutable source evidence, when planning, then require explicit review", async () => {
  const threaded = { ...candidate, messageIds: ["upvest-original"] };
  const matched = { ...mail, inReplyTo: "upvest-original", text: "Upvest Senior Software Engineer (f/m/d) declined" };
  assert.deepEqual(await planApplicationMove(matched, [threaded], columns, "rejection"), { kind: "review", reason: "Original posting evidence is missing or unavailable; choose an application" });
});

test("Given a mutable card URL and a live page matching the email, when original evidence is absent, then review without fetching", async () => {
  const linked = { ...candidate, jobUrl: "https://jobs.example.test/upvest/product" };
  let fetched = false;
  const fetcher = async () => { fetched = true; return new Response('<script type="application/ld+json">{"@type":"JobPosting","title":"Senior Product Engineer (f/m/d)","hiringOrganization":{"name":"Upvest"}}</script>', { headers: { "content-type": "text/html" } }); };
  assert.deepEqual(await planApplicationMove(mail, [linked], columns, "rejection", fetcher), { kind: "review", reason: "Original posting evidence is missing or unavailable; choose an application" });
  assert.equal(fetched, false);
});

test("Given mutable vacancy URLs or a changed page, when resolving a rejection without original evidence, then require review without lookup", async () => {
  const linked = { ...candidate, jobUrl: "https://jobs.example.test/upvest/product" };
  const duplicate = { ...linked, cardId: "upvest-other", jobUrl: "https://jobs.example.test/upvest/other" };
  let fetched = false;
  const fetcher = async () => { fetched = true; return new Response(null, { status: 404 }); };
  assert.deepEqual(await planApplicationMove(mail, [linked, duplicate], columns, "rejection", fetcher), {
    kind: "review", reason: "Original posting evidence is missing or unavailable; choose an application",
  });
  assert.equal(fetched, false);
});

test("Given distinct live page titles but no retained originals, when rejection is processed, then require explicit review", async () => {
  const linked = { ...candidate, jobUrl: "https://jobs.example.test/upvest/product" };
  const other = { ...candidate, cardId: "upvest-designer", jobUrl: "https://jobs.example.test/upvest/designer", role: "Senior Product Engineer (f/m/d)" };
  const fetcher = async (input: RequestInfo | URL) => new Response(JSON.stringify(input).includes("designer")
    ? '<script type="application/ld+json">{"@type":"JobPosting","title":"Product Designer","hiringOrganization":{"name":"Upvest"}}</script>'
    : '<script type="application/ld+json">{"@type":"JobPosting","title":"Senior Product Engineer (f/m/d)","hiringOrganization":{"name":"Upvest"}}</script>', { headers: { "content-type": "text/html" } });
  assert.deepEqual(await planApplicationMove(mail, [linked, other], columns, "rejection", fetcher), {
    kind: "review", reason: "Original posting evidence is missing or unavailable; choose an application",
  });
  const exact = { ...mail, urls: [linked.jobUrl] };
  assert.deepEqual(await planApplicationMove(exact, [linked], columns, "rejection", async () => { throw new Error("Page must not replace original evidence"); }), {
    kind: "review", reason: "Original posting evidence is missing or unavailable; choose an application",
  });
});
