// Older DOM declarations erase the callback result in LockManager.request.
// Capture it separately and wait for the request to settle before returning.
export async function requestWebLock<T>(name: string, operation: () => Promise<T>): Promise<T> {
  const completion: { result?: { value: T } } = {}
  await navigator.locks.request(name, async () => {
    completion.result = { value: await operation() }
  })
  if (!completion.result) throw new Error("Web Lock completed without running its operation")
  return completion.result.value
}
