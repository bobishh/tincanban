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
  assert.deepEqual(await planApplicationMove(mail, [candidate], columns, "rejection"), { kind: "review", reason: "Application has no vacancy URL to read its original role" });
});
test("Given a matching current rejection, when planning, then move to Rejected and explain stale or undated mail", async () => {
  const threaded = { ...candidate, messageIds: ["upvest-original"] };
  const matched = { ...mail, inReplyTo: "upvest-original", text: "Upvest Senior Software Engineer (f/m/d) declined" };
  assert.deepEqual(await planApplicationMove(matched, [threaded], columns, "rejection"), { kind: "move", candidate: threaded, columnId: "rejected" });
  assert.deepEqual(await planApplicationMove({ ...matched, date: "2026-10-12T12:00:00Z" }, [threaded], columns, "rejection"), { kind: "review", reason: "Email is older than the latest application status" });
  assert.deepEqual(await planApplicationMove({ ...matched, date: null }, [threaded], columns, "rejection"), { kind: "review", reason: "Email has no valid original date" });
});

test("Given an incorrect card role and an authoritative vacancy URL, when its page names the role in the rejection, then move without editing the card", async () => {
  const linked = { ...candidate, jobUrl: "https://jobs.example.test/upvest/product" };
  const fetcher = async () => new Response('<script type="application/ld+json">{"@type":"JobPosting","title":"Senior Product Engineer (f/m/d)","hiringOrganization":{"name":"Upvest"}}</script>', { headers: { "content-type": "text/html" } });
  assert.deepEqual(await planApplicationMove(mail, [linked], columns, "rejection", fetcher), { kind: "move", candidate: linked, columnId: "rejected" });
});

test("Given two same-company vacancy pages or an unavailable page, when resolving a rejection, then preserve ambiguity and never fall back to card text", async () => {
  const linked = { ...candidate, jobUrl: "https://jobs.example.test/upvest/product" };
  const duplicate = { ...linked, cardId: "upvest-other", jobUrl: "https://jobs.example.test/upvest/other" };
  const fetcher = async () => new Response('<script type="application/ld+json">{"@type":"JobPosting","title":"Senior Product Engineer (f/m/d)","hiringOrganization":{"name":"Upvest"}}</script>', { headers: { "content-type": "text/html" } });
  assert.equal((await planApplicationMove(mail, [linked, duplicate], columns, "rejection", fetcher)).kind, "review");
  const failed = await planApplicationMove({ ...mail, text: "Upvest Senior Software Engineer (f/m/d) declined" }, [linked], columns, "rejection", async () => new Response(null, { status: 404 }));
  assert.equal(failed.kind, "review");
  assert.match(failed.kind === "review" ? failed.reason : "", /404/);
});

test("Given two Upvest roles with incorrect card labels, when original pages identify distinct roles, then only the page matching the email can move", async () => {
  const linked = { ...candidate, jobUrl: "https://jobs.example.test/upvest/product" };
  const other = { ...candidate, cardId: "upvest-designer", jobUrl: "https://jobs.example.test/upvest/designer", role: "Senior Product Engineer (f/m/d)" };
  const fetcher = async (input: RequestInfo | URL) => new Response(JSON.stringify(input).includes("designer")
    ? '<script type="application/ld+json">{"@type":"JobPosting","title":"Product Designer","hiringOrganization":{"name":"Upvest"}}</script>'
    : '<script type="application/ld+json">{"@type":"JobPosting","title":"Senior Product Engineer (f/m/d)","hiringOrganization":{"name":"Upvest"}}</script>', { headers: { "content-type": "text/html" } });
  assert.deepEqual(await planApplicationMove(mail, [linked, other], columns, "rejection", fetcher), { kind: "move", candidate: linked, columnId: "rejected" });
  const exact = { ...mail, urls: [linked.jobUrl] };
  assert.equal((await planApplicationMove(exact, [linked], columns, "rejection", async () => { throw new Error("Exact URL needs no page fetch"); })).kind, "move");
});
