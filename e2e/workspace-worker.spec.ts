import { expect, test } from "./support/coverage"

async function traceAdmissionWorkers(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    const trace = { created: [] as string[], requests: [] as Array<{ url: string; id: number }>, instances: [] as Worker[] }
    Object.defineProperty(window, "__admissionWorkerTrace", { value: trace })
    const NativeWorker = window.Worker
    window.Worker = new Proxy(NativeWorker, {
      construct(target, args, newTarget) {
        const instance = Reflect.construct(target, args, newTarget) as Worker
        const url = String(args[0])
        trace.created.push(url)
        if (url.includes("workspaceAdmissionWorker")) {
          trace.instances.push(instance)
          const post = instance.postMessage.bind(instance)
          Object.defineProperty(instance, "postMessage", {
            value: (message: { id?: number }, ...rest: unknown[]) => {
              if (typeof message.id === "number") trace.requests.push({ url, id: message.id })
              return Reflect.apply(post, instance, [message, ...rest])
            },
          })
        }
        return instance
      },
    })
  })
}

type AdmissionWorkerTrace = { created: string[]; requests: Array<{ url: string; id: number }>; instances: Worker[] }

test("Given an already admitted board, when its exact signed evidence repeats, then it needs no new Worker", async ({ page }) => {
  await traceAdmissionWorkers(page)
  await page.goto("/")
  await expect(page.getByRole("button", { name: "Open workspaces" })).toBeEnabled()
  const result = await page.evaluate(async () => {
    const tincanban = (await import("/src/test/stateFixture.ts")).useTincanban()
    await tincanban.whenReady()
    const bytes = await tincanban.readWorkspaceBytes(tincanban.activeWorkspace.id)
    const { exportAuthorizationBundle } = await import("/src/sync/changeAuthorization.ts")
    const proof = await exportAuthorizationBundle(bytes, tincanban.getCurrentProfile()!)
    const trace = (window as unknown as { __admissionWorkerTrace: AdmissionWorkerTrace }).__admissionWorkerTrace
    const createdBefore = trace.created.length
    const original = window.Worker
    window.Worker = class { constructor() { throw new Error("Unexpected repeated admission") } } as unknown as typeof Worker
    try {
      const start = performance.now()
      await tincanban.mergeAuthorizedWorkspace(tincanban.activeWorkspace.id, bytes, proof)
      return { duration: performance.now() - start, createdBefore, createdAfter: trace.created.length }
    } finally { window.Worker = original }
  })
  expect(result.duration).toBeLessThan(1000)
  expect(result.createdAfter).toBe(result.createdBefore)
  console.info(`Exact evidence replay: ${Math.round(result.duration)}ms; no new Worker constructed`)
})

test("Given a large signed peer history, when admission runs, then board controls stay responsive until durable commit", async ({ page }) => {
  test.setTimeout(120_000)
  await traceAdmissionWorkers(page)
  await page.goto("/")
  await expect(page.getByRole("button", { name: "Open workspaces" })).toBeEnabled()
  await page.evaluate(async () => {
    const { useTincanban } = await import("/src/test/stateFixture.ts")
    const { prepareLocalChangeAuthorizations, exportAuthorizationBundle } = await import("/src/sync/changeAuthorization.ts")
    const A = await import("/@id/@automerge/automerge/slim")
    const tincanban = useTincanban()
    await tincanban.whenReady()
    const base = tincanban.getActiveDoc()!
    const profile = tincanban.getCurrentProfile()!
    let remote = A.clone(base)
    for (let index = 0; index < 20_001; index++) {
      remote = A.change(remote, draft => { draft.title = `Remote history ${index}` })
    }
    const hashes = A.getChangesMetaSince(remote, A.getHeads(base)).map(change => change.hash)
    const bundle = await exportAuthorizationBundle(A.save(base), profile)
    const proofs = [...bundle.records]
    for (let offset = 0; offset < hashes.length; offset += 256) {
      proofs.push(...await prepareLocalChangeAuthorizations(remote, profile, hashes.slice(offset, offset + 256)))
    }
    const fixture = { id: base.id, bytes: A.save(remote), authorization: { ...bundle, records: proofs }, before: A.getHeads(base) }
    Object.assign(window, { admissionFixture: fixture, admissionState: "ready" })
  })
  const requestsBefore = await page.evaluate(() =>
    (window as unknown as { __admissionWorkerTrace: AdmissionWorkerTrace }).__admissionWorkerTrace.requests.length,
  )
  await page.evaluate(() => {
    const state = window as unknown as { admissionFixture: { id: string; bytes: Uint8Array; authorization: unknown }; admissionState: string; admissionPromise: Promise<void> }
    state.admissionState = "pending"
    state.admissionPromise = import("/src/test/stateFixture.ts").then(({ useTincanban }) => useTincanban().mergeAuthorizedWorkspace(
      state.admissionFixture.id, state.admissionFixture.bytes, state.admissionFixture.authorization,
    )).then(() => { state.admissionState = "committed" }, error => { state.admissionState = `failed: ${String(error)}` })
  })
  await expect.poll(() => page.evaluate(() => {
    const trace = (window as unknown as { __admissionWorkerTrace: AdmissionWorkerTrace }).__admissionWorkerTrace
    return trace.requests.length
  })).toBeGreaterThan(requestsBefore)
  const clickStarted = Date.now()
  await page.getByRole("button", { name: "Open workspaces" }).click({ timeout: 1500 })
  await expect(page.getByRole("dialog", { name: "Workspaces", exact: true })).toBeVisible({ timeout: 1500 })
  const menuLatencyMs = Date.now() - clickStarted
  expect(await page.evaluate(() => (window as unknown as { admissionState: string }).admissionState)).toBe("pending")
  console.info(`Admission Worker: 20,001 changes; menu visible in ${menuLatencyMs}ms while validation pending`)
  await page.evaluate(async () => {
    const { WorkspaceStorage } = await import("/src/storage.ts")
    const A = await import("/@id/@automerge/automerge/slim")
    const state = window as unknown as { admissionFixture: { id: string; before: string[] }; admissionState: string }
    const durable = (await new WorkspaceStorage().loadWorkspaceDoc(state.admissionFixture.id))!.doc
    if (state.admissionState === "pending" && JSON.stringify(A.getHeads(durable)) !== JSON.stringify(state.admissionFixture.before)) {
      throw new Error("Unverified candidate reached durable storage")
    }
  })
  await expect.poll(() => page.evaluate(() => (window as unknown as { admissionState: string }).admissionState), { timeout: 60_000 }).toBe("committed")
  await page.reload()
  // Cold startup restores the accepted history before enabling board controls.
  // Its duration is separate from the menu responsiveness assertion above.
  expect(await page.evaluate(async () => {
    const { useTincanban } = await import("/src/test/stateFixture.ts")
    await useTincanban().whenReady()
    return useTincanban().getActiveDoc()!.title
  })).toBe("Remote history 20000")
  await expect(page.getByRole("button", { name: "Open workspaces" })).toBeEnabled()
})

for (const failure of ["worker startup", "forged signature"] as const) {
  test(`Given ${failure} fails admission, when a candidate arrives, then document and notifications remain unchanged`, async ({ page }) => {
    await traceAdmissionWorkers(page)
    await page.goto("/")
    await expect(page.getByRole("button", { name: "Open workspaces" })).toBeEnabled()
    const result = await page.evaluate(async failure => {
      const { useTincanban } = await import("/src/test/stateFixture.ts")
      const { prepareLocalChangeAuthorizations, exportAuthorizationBundle, exportAuthorizations } = await import("/src/sync/changeAuthorization.ts")
      const { WorkspaceStorage } = await import("/src/storage.ts")
      const A = await import("/@id/@automerge/automerge/slim")
      const tincanban = useTincanban()
      await tincanban.whenReady()
      const base = tincanban.getActiveDoc()!
      const remote = A.change(A.clone(base), draft => { draft.title = "Must not commit" })
      const proofs = await prepareLocalChangeAuthorizations(remote, tincanban.getCurrentProfile()!, A.getChangesMetaSince(remote, A.getHeads(base)).map(change => change.hash))
      const bundle = await exportAuthorizationBundle(A.save(base), tincanban.getCurrentProfile()!)
      const beforeProofs = JSON.stringify(await exportAuthorizations(A.save(base)))
      let notifications = 0
      const stop = tincanban.subscribeLocalChanges(() => { notifications++ })
      const originalWorker = window.Worker
      if (failure === "worker startup") {
        const trace = (window as unknown as { __admissionWorkerTrace: AdmissionWorkerTrace }).__admissionWorkerTrace
        const existing = trace.instances.at(-1)
        if (!existing?.onerror) throw new Error("Admission worker error handler missing after hydrate")
        // Invoke handler installed by workspaceAdmissionClient, which terminates the singleton.
        existing.onerror(new ErrorEvent("error", { message: "simulated worker failure" }))
        window.Worker = class { constructor() { throw new Error("Worker blocked") } } as unknown as typeof Worker
      }
      else proofs[0]!.signed.signature += "forged"
      let error = ""
      try { await tincanban.mergeAuthorizedWorkspace(base.id, A.save(remote), { ...bundle, records: [...bundle.records, ...proofs] }) }
      catch (cause) { error = String(cause) }
      finally { window.Worker = originalWorker; stop() }
      const durable = (await new WorkspaceStorage().loadWorkspaceDoc(base.id))!.doc
      return { error, notifications, before: A.getHeads(base), after: A.getHeads(durable), ui: A.getHeads(tincanban.getActiveDoc()!), beforeProofs, afterProofs: JSON.stringify(await exportAuthorizations(A.save(durable))) }
    }, failure)
    expect(result.error).toMatch(failure === "worker startup" ? /Worker blocked/ : /signature/i)
    expect(result.notifications).toBe(0)
    expect(result.after).toEqual(result.before)
    expect(result.ui).toEqual(result.before)
    expect(result.afterProofs).toBe(result.beforeProofs)
  })
}
