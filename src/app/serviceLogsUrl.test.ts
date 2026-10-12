import { describe, expect, it } from "vitest"
import { serviceLogsUrl } from "./serviceLogsUrl"

describe("Board log shortcut", () => {
  it("Given the configured producer, when opening board logs, then open all related producer logs within the board scope", () => {
    expect(serviceLogsUrl({ endpoint: "https://sink.example/events", project: "tincanban" }, "board one"))
      .toBe("https://sink.example/admin/logs/?workspace=board+one")
  })
  it("Given missing or unsafe configuration, when rendering shortcut, then no unsafe link exists", () => {
    for (const endpoint of ["", "javascript:alert(1)", "https://user:pass@sink.example/events", "http://remote.example/events"])
      expect(serviceLogsUrl({ endpoint, project: "tincanban" }, "board")).toBeUndefined()
    expect(serviceLogsUrl({ endpoint: "https://sink.example/events", project: "../admin" }, "board")).toBeUndefined()
  })
})
