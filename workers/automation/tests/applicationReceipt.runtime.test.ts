import { expect, it } from "vitest";
import { runPipeline } from "../src/pipeline";
import { receiptAi } from "./receiptFixture";

const role = "Software Development Engineer II, PartyRock";
const jobUrl = "https://amazon.jobs/jobs/10471492";
const tracking = (url: string) => `https://tracking.r.us-west-2.awstrack.me/L0/${encodeURIComponent(url).replace(/^https%3A/, "https:")}/1/message/signature`;
const page = (title: string) => `<meta property="og:site_name" content="Amazon.jobs"><meta property="og:title" content="${title}"><h1>${title}</h1>`;

it("Given incorrect website labels, When extracting a posting for intake, Then retain page company and role independently", async () => {
  const result = await runPipeline({ source: "website", receivedAt: new Date().toISOString(), submission: {
    company: "Incorrect employer", role: "Incorrect role", jobUrl, message: "Apply to this vacancy", contact: "",
  } }, receiptAi, async () => new Response('<script type="application/ld+json">{"@type":"JobPosting","title":"Senior Product Engineer","hiringOrganization":{"name":"Upvest"},"description":"Build investing APIs"}</script>',
    { headers: { "content-type": "text/html" } }));
  expect(result.extraction).toMatchObject({ company: "Upvest", role: "Senior Product Engineer", body: "Build investing APIs" });
});


it("Given a receipt with Amazon homepage and tracked vacancy links, When processed, Then use the specific vacancy title and canonical URL", async () => {
  const fetched: string[] = [];
  const result = await runPipeline({ source: "email", receivedAt: new Date().toISOString(), rawMime: "",
    message: { messageId: "<partyrock@example.test>", inReplyTo: null, references: [], from: "noreply@mail.amazon.jobs",
      to: "owner@example.test", subject: "Vielen Dank für Ihre Bewerbung bei Amazon.",
      text: `We've received your application for the ${role} (ID: 10471492) position.`, date: new Date().toUTCString(),
      urls: [tracking("https://www.amazon.jobs/"), tracking(jobUrl), tracking("https://account.amazon.jobs/candidate/dashboard/applications")],
      confirmation: false, attachments: [] } }, receiptAi, async input => {
    const url = String(input); fetched.push(url);
    if (url === jobUrl) return new Response(page(role), { headers: { "content-type": "text/html" } });
    return new Response(page("Find jobs at Amazon"), { headers: { "content-type": "text/html" } });
  });
  expect(result.extraction).toMatchObject({ role, finalUrl: jobUrl });
  expect(fetched).toEqual([jobUrl]);
});

it("Given a receipt whose only link is a careers homepage, When processed, Then generic metadata cannot become a vacancy", async () => {
  const result = await runPipeline({ source: "email", receivedAt: new Date().toISOString(), rawMime: "",
    message: { messageId: "<receipt@example.test>", inReplyTo: null, references: [], from: "recruiter@example.test",
      to: "owner@example.test", subject: "Application received", text: `We received your application for ${role}.`,
      date: new Date().toUTCString(), urls: ["https://www.amazon.jobs/"], confirmation: false, attachments: [] } }, receiptAi,
    async () => new Response(page("Find jobs at Amazon"), { headers: { "content-type": "text/html" } }));
  expect(result.extraction).toBeUndefined();
  expect(result.status).toBe("review");
});

it("Given an Amazon reminder saying the application may still be unfinished, When AI would classify it as Applied, Then it cannot confirm submission", async () => {
  const result = await runPipeline({ source: "email", receivedAt: new Date().toISOString(), rawMime: "",
    message: { messageId: "<reminder@example.test>", inReplyTo: null, references: [], from: "noreply@mail.amazon.jobs",
      to: "owner@example.test", subject: "Zum Status Ihrer Bewerbung",
      text: `Thank you for your interest in ${role}. If you have completed the application: Great! You can now check the application status here. If you are still working on the application: Don't worry! You can complete it here when you're ready.`,
      date: new Date().toUTCString(), urls: [jobUrl], confirmation: false, attachments: [] } }, receiptAi,
    async () => new Response(page(role), { headers: { "content-type": "text/html" } }));
  expect(result.decision && "event" in result.decision ? result.decision.event : undefined).not.toBe("applied");
  expect(result.opportunity).toBeUndefined();
  expect(result.reason).toContain("does not confirm submission");
});
