import { expect, it } from 'vitest'
import { continueCredentialConflictRecovery } from './replicaCredentialConflictWorkflow'
it('Given unavailable automation, when recovering this device, then use only Rusty policy, original ciphertext and fresh snapshot confirmations', async () => {
  const events: string[] = []
  const ports = {
    freezeWorkers: async () => { throw new Error('Reflux is unavailable (HTTP 504)') },
    confirmPolicy: async () => { events.push('policy CAS') },
    drainOriginal: async () => { events.push('drain original ciphertext') },
    rotateWorkers: async () => { throw new Error('Reflux is unavailable (HTTP 504)') },
    activate: async () => { events.push('activate') },
    confirmSnapshot: async () => { events.push('confirm fresh snapshot') },
  }
  await continueCredentialConflictRecovery(ports)
  expect(events).toEqual(['policy CAS', 'drain original ciphertext', 'activate', 'confirm fresh snapshot'])
})
it('Given an uncertain original ciphertext replay, when recovery fails, then preserve the frozen journal and never activate credentials', async () => {
  const events: string[] = []
  await expect(continueCredentialConflictRecovery({ confirmPolicy: async () => {},
    drainOriginal: async () => { throw new Error('Receipt unavailable') },
    activate: async () => { events.push('activate') }, confirmSnapshot: async () => {} })).rejects.toThrow('Receipt unavailable')
  expect(events).toEqual([])
})
it('Given an unconfirmed Rusty policy, when recovery fails, then never drain or activate this device', async () => {
  const events: string[] = []
  await expect(continueCredentialConflictRecovery({ confirmPolicy: async () => { throw new Error('Policy receipt unavailable') },
    drainOriginal: async () => { events.push('drain') }, activate: async () => { events.push('activate') },
    confirmSnapshot: async () => { events.push('snapshot') } })).rejects.toThrow('Policy receipt unavailable')
  expect(events).toEqual([])
})
