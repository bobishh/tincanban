import { expect, it } from 'vitest'
import { continueCredentialConflictRecovery } from './replicaCredentialConflictWorkflow'
it('Given a frozen conflict, when recovering, then freeze Workers before rotating policy, replay original ciphertext, rotate Workers, activate and confirm snapshot', async () => {
  const events: string[] = []
  await continueCredentialConflictRecovery({
    freezeWorkers: async () => { events.push('freeze Workers') },
    confirmPolicy: async () => { events.push('policy CAS') },
    drainOriginal: async () => { events.push('drain original ciphertext') },
    rotateWorkers: async () => { events.push('rotate Workers') },
    activate: async () => { events.push('activate') },
    confirmSnapshot: async () => { events.push('confirm fresh snapshot') },
  })
  expect(events).toEqual(['freeze Workers', 'policy CAS', 'drain original ciphertext', 'rotate Workers', 'activate', 'confirm fresh snapshot'])
})
it('Given an uncertain original ciphertext replay, when recovery fails, then preserve the frozen journal and never activate credentials', async () => {
  const events: string[] = []
  await expect(continueCredentialConflictRecovery({ freezeWorkers: async () => {}, confirmPolicy: async () => {},
    drainOriginal: async () => { throw new Error('Receipt unavailable') }, rotateWorkers: async () => { events.push('rotate') },
    activate: async () => { events.push('activate') }, confirmSnapshot: async () => {} })).rejects.toThrow('Receipt unavailable')
  expect(events).toEqual([])
})
