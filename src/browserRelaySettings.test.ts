import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { browserRelayUrls, readBrowserRelaySettings, saveBrowserRelaySettings } from "./browserRelaySettings"

const discover = vi.hoisted(() => vi.fn())
vi.mock("@meta-uber/mesh-replication/rusty-management", () => ({ discoverRustyService: discover }))
beforeEach(() => {
  const values = new Map<string, string>()
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  })
})
afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks() })

it("Given an unconfigured device, when saving an explicit relay list, then start subsequent connections with only that list", async () => {
  expect(browserRelayUrls()).toBeUndefined()
  await saveBrowserRelaySettings("custom", "https://one.example\nhttps://two.example/\nhttps://one.example/")
  expect(browserRelayUrls()).toEqual(["https://one.example", "https://two.example"])
  expect(readBrowserRelaySettings()).toEqual({ mode: "custom", urls: ["https://one.example", "https://two.example"] })
})

it("Given a private relay preference, when a Rusty server advertises no relay, then keep the previous preference", async () => {
  await saveBrowserRelaySettings("custom", "https://private.example")
  discover.mockResolvedValue({ origin: "https://rusty.example", capabilities: {} })
  await expect(saveBrowserRelaySettings("rusty", "https://rusty.example")).rejects.toThrow(/advertise/)
  expect(browserRelayUrls()).toEqual(["https://private.example"])
})

it("Given a Rusty advertises an Iroh relay, when switching to Rusty-only mode, then use the advertised address after reload", async () => {
  discover.mockResolvedValue({ origin: "https://rusty.example", capabilities: { irohRelay: { version: 1, url: "https://relay.example" } } })
  await saveBrowserRelaySettings("rusty", "https://rusty.example")
  expect(browserRelayUrls()).toEqual(["https://relay.example"])
  expect(readBrowserRelaySettings()).toEqual({ mode: "rusty", origin: "https://rusty.example", url: "https://relay.example" })
})
