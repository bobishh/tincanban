import { test } from "node:test";
import assert from "node:assert/strict";
import { vacancyUrl } from "../src/vacancyIdentity.ts";

test("Given official ATS posting and application URLs When comparing identity Then retain one vacancy and distinct opening IDs", () => {
  const ashby = "https://jobs.ashbyhq.com/qonto/455320d9-9f51-412b-a761-f71f27321401";
  assert.equal(vacancyUrl(ashby), vacancyUrl(`${ashby}/application?utm_source=search#apply`));
  assert.equal(vacancyUrl("https://acture-germany.jobs.personio.com/job/2591445"),
    vacancyUrl("https://acture-germany.jobs.personio.com/job/2591445/apply?language=en"));
  assert.notEqual(vacancyUrl(ashby), vacancyUrl("https://jobs.ashbyhq.com/qonto/455320d9-9f51-412b-a761-f71f27321402"));
  assert.notEqual(vacancyUrl("https://careers.example.test/job?id=1"), vacancyUrl("https://careers.example.test/job?id=2"));
});
