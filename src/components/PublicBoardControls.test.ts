import { createSSRApp, ref } from "vue"
import { renderToString } from "@vue/server-renderer"
import { describe, expect, it } from "vitest"
import PublicBoardControls from "./PublicBoardControls.vue"

function access(overrides = {}) {
  return { owner: ref(true), origin: ref("https://rusty.example"), origins: ref(["https://rusty.example"]),
    connected: ref(true), checked: ref(true), published: ref(true), busy: ref(true), error: ref(""),
    revision: ref(1), syncPending: ref(false), privateConfirmed: ref(false),
    link: ref("https://board.example/?rusty=https%3A%2F%2Frusty.example"),
    lastConfirmedAt: ref(0), lastDelivery: ref(null), progress: ref({ phase: "checking", startedAt: Date.now() - 12000 }), ...overrides }
}
const render = (value: ReturnType<typeof access>) => renderToString(createSSRApp(PublicBoardControls, { access: value as never }))

describe("public board publication status", () => {
  it("Given a published board, when a background status check waits, then retain confirmed public status and link", async () => {
    const html = await render(access())
    expect(html).toContain("Public · Changes sync automatically.")
    expect(html).toContain("Checking access on Rusty")
    expect(html).toContain("12s elapsed")
    expect(html).toContain("Open public board")
  })

  it("Given first publication with attachments, when uploading, then show completed file count without claiming the board is public", async () => {
    const html = await render(access({ published: ref(false), progress: ref({ phase: "uploading", completedFiles: 2, totalFiles: 5, startedAt: Date.now() }) }))
    expect(html).toContain("Uploading files: 2 of 5")
    expect(html).not.toContain("Checking public access")
    expect(html).not.toContain("Public · Changes sync automatically.")
    expect(html).not.toContain("Open public board")
  })
})
