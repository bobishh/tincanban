import { expect, it, vi } from "vitest"
import { writeLocal } from "../localDb"
import { recoverPendingIdentityDeviceActivation } from "./identityDeviceActivationLoader"

const activation = vi.hoisted(() => ({ moduleLoaded: vi.fn(), resume: vi.fn(async (_personId: string, guard: () => void, _certificatesOnly?: boolean) => { void _certificatesOnly; guard() }) }))
const projection = vi.hoisted(() => ({ moduleLoaded: vi.fn(), resume: vi.fn(async (_personId: string, guard: () => void) => {
  guard()
  return { projected: 0, pending: [] as Array<{ workspaceId: string; reason: string }> }
}) }))
vi.mock("./identityDeviceActivation", () => {
  activation.moduleLoaded()
  return { resumeIdentityDeviceActivation: activation.resume }
})
vi.mock("./identityProfileProjection", () => {
  projection.moduleLoaded()
  return { resumeIdentityProfileProjections: projection.resume }
})

it("Given startup has no pending identity bundle, when checking recovery, then skip loading transfer validators and run no activation", async () => {
  await recoverPendingIdentityDeviceActivation(crypto.randomUUID(), () => {})
  expect(activation.moduleLoaded).not.toHaveBeenCalled()
  expect(activation.resume).not.toHaveBeenCalled()
  expect(projection.moduleLoaded).not.toHaveBeenCalled()
})

it("Given only deferred profiles remain after restart, when startup checks recovery, then retry profiles without requiring an activation job", async () => {
  const personId = crypto.randomUUID(), guard = vi.fn()
  await writeLocal(`tincanban.identity-profile-projections.v1.${personId}`, JSON.stringify({
    version: 1, personId, observations: [{ workspaceId: "pending" }],
  }))
  await recoverPendingIdentityDeviceActivation(personId, guard)
  expect(projection.resume).toHaveBeenCalledWith(personId, guard)
})

it("Given a confirmed empty profile queue, when starting, then skip heavy recovery validation", async () => {
  const personId = crypto.randomUUID()
  projection.resume.mockClear()
  activation.resume.mockClear()
  await writeLocal(`tincanban.identity-profile-projections.v1.${personId}`, JSON.stringify({ version: 1, personId, observations: [] }))
  await recoverPendingIdentityDeviceActivation(personId, () => {})
  expect(projection.resume).not.toHaveBeenCalled()
  expect(activation.resume).not.toHaveBeenCalled()
})

it("Given newer or malformed profile queue bytes, when startup checks recovery, then invoke validation rather than silently ignoring recovery data", async () => {
  for (const raw of ["malformed", JSON.stringify({ version: 2, observations: [] })]) {
    const personId = crypto.randomUUID(), guard = vi.fn()
    await writeLocal(`tincanban.identity-profile-projections.v1.${personId}`, raw)
    await recoverPendingIdentityDeviceActivation(personId, guard)
    expect(projection.resume).toHaveBeenCalledWith(personId, guard)
  }
})

it("Given a pending identity bundle, when startup checks recovery, then await the actual activation with the current session guard", async () => {
  const personId = crypto.randomUUID(), guard = vi.fn()
  await writeLocal(`tincanban.identity-device-activation.v1.${personId}`, "pending bytes")
  await recoverPendingIdentityDeviceActivation(personId, guard)
  expect(activation.moduleLoaded).toHaveBeenCalledOnce()
  expect(activation.resume).toHaveBeenCalledWith(personId, guard, true)
  expect(guard).toHaveBeenCalled()
})

it("Given pending activation and profile projections, when startup recovers, then finish certificate activation before retrying projections", async () => {
  const personId = crypto.randomUUID(), guard = vi.fn()
  await writeLocal(`tincanban.identity-device-activation.v1.${personId}`, "pending bytes")
  await writeLocal(`tincanban.identity-profile-projections.v1.${personId}`, JSON.stringify({
    version: 1, personId, observations: [{ workspaceId: "pending" }],
  }))
  projection.resume.mockResolvedValueOnce({ projected: 1, pending: [{ workspaceId: "later", reason: "Workspace not installed" }] })
  const result = await recoverPendingIdentityDeviceActivation(personId, guard)
  expect(activation.resume).toHaveBeenCalledWith(personId, guard, true)
  expect(projection.resume).toHaveBeenCalledWith(personId, guard)
  expect(result).toEqual({ projected: 1, pending: [{ workspaceId: "later", reason: "Workspace not installed" }] })
})

it("Given identity changes during the recovery read, when pending work is found, then reject before invoking activation", async () => {
  const personId = crypto.randomUUID()
  await writeLocal(`tincanban.identity-device-activation.v1.${personId}`, "pending bytes")
  activation.resume.mockClear()
  await expect(recoverPendingIdentityDeviceActivation(personId, () => { throw new Error("Identity changed") }))
    .rejects.toThrow("Identity changed")
  expect(activation.resume).not.toHaveBeenCalled()
})

it("Given pending recovery fails validation or projection, when startup checks it, then propagate failure and retain pending bytes", async () => {
  const personId = crypto.randomUUID(), raw = "unavailable or invalid bundle"
  await writeLocal(`tincanban.identity-device-activation.v1.${personId}`, raw)
  activation.resume.mockRejectedValueOnce(new Error("Projection unavailable"))
  await expect(recoverPendingIdentityDeviceActivation(personId, () => {})).rejects.toThrow("Projection unavailable")
  const { readLocal } = await import("../localDb")
  expect(await readLocal(`tincanban.identity-device-activation.v1.${personId}`)).toBe(raw)
})
