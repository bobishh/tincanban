import { describe, expect, it } from "vitest"
import { describeUserAgent, deviceDisplayName, isKeeper } from "./deviceInfo"

describe("device user-agent description", () => {
  it("Given a reported Chrome UA, when described, then browser and OS are explicitly best-effort", () => {
    expect(describeUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36")).toBe("Likely Chrome · macOS")
  })

  it("Given no usable UA, when described, then the UI reports unknown rather than guessing", () => {
    expect(describeUserAgent()).toBe("Browser / OS unknown")
    expect(describeUserAgent("TincanbanDevice/1.0")).toBe("Browser / OS unknown")
  })
})

 it("recognizes the explicit keeper client marker, not a display name", () => {
   expect(isKeeper("mesh-lighthouse/0.1.0")).toBe(true)
   expect(describeUserAgent("mesh-lighthouse/0.1.0")).toBe("Rusty")
   expect(isKeeper("Lighthouse")).toBe(false)
   expect(isKeeper(undefined)).toBe(false)
 })

it("Given historical generated labels, when rendering devices or saved removal records, then use reported browser/OS and short ID", () => {
  const device = { deviceId: "old-device-123", name: "Valiant Squirrel's device" }
  expect(deviceDisplayName(device)).toBe("Device old-devi")
  expect(deviceDisplayName({ ...device, userAgent: "Mozilla/5.0 Macintosh Chrome/140.0 Safari/537.36" })).toBe("Likely Chrome · macOS · old-devi")
  expect(deviceDisplayName({ ...device, name: "Participant's device" })).toBe("Device old-devi")
  expect(deviceDisplayName({ ...device, name: "Joyful Papaya's device" })).toBe("Device old-devi")
})

it.each(["Squirrel workstation", "Valiant Squirrel", "Alice's device", "Valiant Robot's device"])("Given deliberate device name %s, when displayed, then keep it", name => {
  expect(deviceDisplayName({ deviceId: "old-device-123", name })).toBe(name)
})
