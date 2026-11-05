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
  assert.equal(planBoundApplicationMove({ ...mail, date: "2026-10-12T00:00:00Z" }, candidate, columns, "rejection").kind, "note");
  assert.equal(planBoundApplicationMove(mail, { ...candidate, columnId: "rejected", workflow: { ...candidate.workflow, columnId: "rejected" } }, columns, "interview").kind, "review");
});

test("Given an Upvest rejection naming a different saved role, when matching, then report the missing source without moving another application", async () => {
  assert.deepEqual(await planApplicationMove(mail, [candidate], columns, "rejection"), { kind: "review", reason: "Original posting evidence is missing or unavailable; choose an application" });
});
test("Given explicit current company and role on a legacy card When planning Then match those facts and keep bare references in review", async () => {
  const threaded = { ...candidate, sources: [], messageIds: ["upvest-original"] };
  const matched = { ...mail, inReplyTo: "upvest-original", text: "Upvest Senior Software Engineer (f/m/d) declined" };
  assert.deepEqual(await planApplicationMove(matched, [threaded], columns, "rejection"), { kind: "move", candidate: threaded, columnId: "rejected" });
  assert.equal((await planApplicationMove({...matched,text:"We decided to proceed with other candidates."},[threaded],columns,"rejection")).kind,"review");
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

test("Given an explicit role matching a second legacy card When planning Then select that role without consulting live page titles", async () => {
  const linked = { ...candidate, jobUrl: "https://jobs.example.test/upvest/product" };
  const other = { ...candidate, sources: [], cardId: "upvest-designer", jobUrl: "https://jobs.example.test/upvest/designer", role: "Senior Product Engineer (f/m/d)" };
  const fetcher = async (input: RequestInfo | URL) => new Response(JSON.stringify(input).includes("designer")
    ? '<script type="application/ld+json">{"@type":"JobPosting","title":"Product Designer","hiringOrganization":{"name":"Upvest"}}</script>'
    : '<script type="application/ld+json">{"@type":"JobPosting","title":"Senior Product Engineer (f/m/d)","hiringOrganization":{"name":"Upvest"}}</script>', { headers: { "content-type": "text/html" } });
  assert.deepEqual(await planApplicationMove(mail, [linked, other], columns, "rejection", fetcher), {kind:"move",candidate:other,columnId:"rejected"});
  const exact = { ...mail, urls: [linked.jobUrl] };
  assert.deepEqual(await planApplicationMove(exact, [linked], columns, "rejection", async () => { throw new Error("Page must not replace original evidence"); }), {
    kind: "review", reason: "Original posting evidence is missing or unavailable; choose an application",
  });
});

test("Given an unambiguous interview naming company and role without a saved posting When planning Then move the actual application to Interview", async () => {
  const application = { cardId: "caspar", company: "Caspar Health", role: "Senior Backend & AI Engineer", sources: [],
    columnId: "applied", workflow: { columnId: "applied", changedAt: "2026-10-22T14:07:53Z" } };
  const invitation = { ...mail, inReplyTo: null, references: [], date: "2026-11-05T07:55:18Z",
    subject: "Caspar Health - Invitation Cultural Add Interview", text: 'Thank you for your interest in our position as a "Senior Backend\n& AI Engineer (all identities)". We invite you to a first video interview.' };
  assert.deepEqual(await planApplicationMove(invitation, [application], columns, "interview"), { kind: "move", candidate: application, columnId: "interview" });
  assert.equal((await planApplicationMove(invitation, [application, {...application,cardId:"duplicate"}], columns, "interview")).kind, "review");
  const quoted = { ...invitation, text: "We have an update.\n\nOn Friday a recruiter wrote:\n> Senior Backend & AI Engineer" };
  assert.equal((await planApplicationMove(quoted, [application], columns, "interview")).kind, "review");
});

test("Given an already Interview application and an older invitation When planning Then retain the email without changing its stage", async () => {
  const application = { ...candidate, columnId: "interview" };
  assert.deepEqual(planBoundApplicationMove({ ...mail, date: "2026-10-01T00:00:00Z" }, application, columns, "interview"), { kind: "note", candidate: application });
});
