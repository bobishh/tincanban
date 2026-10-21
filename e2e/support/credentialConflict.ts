import { createApp, h, ref } from 'vue'
import RustyCredentialConflictRecovery from '../../src/components/RustyCredentialConflictRecovery.vue'
import RustyPanel from '../../src/components/RustyPanel.vue'
import type { BlindReplicationController } from '../../src/app/blindReplication'

export function mountPendingRustyOperation() {
  const target = document.createElement('div')
  document.body.replaceChildren(target)
  const result = ref(''), operations = ref([{ origin: 'https://rusty.example', kind: 'conflict', scopeId: 'original-scope',
    workspaceId: 'other-board', signerDeviceId: 'this-device' }])
  let attempts = 0, connections = 0
  const controller = { configs: ref([]), identityConfigs: ref([]), preferenceConflicts: ref([]), statuses: ref({}),
    now: ref(Date.now()), busy: ref(false), error: ref(''), profileSetupErrors: ref({}), profilePermissionUpdates: ref([]),
    currentDeviceId: ref('this-device'), pendingRustyOperations: operations,
    attach: async () => { connections++ },
    resumeRustyOperation: async (origin: string) => {
      if (++attempts === 1) throw new Error('Server offline; saved operation retained')
      operations.value = []
      result.value = `${origin} resumed; new connections: ${connections}`
    },
  } as unknown as BlindReplicationController
  createApp({ render: () => h('main', [h(RustyPanel, { controller, workspaceId: 'current-board', owner: true }),
    h('p', { role: 'status', 'aria-label': 'Recovery result' }, result.value)]) }).mount(target)
}
export function mountCredentialConflict(mode: 'success' | 'error' | 'pending') {
  const target = document.createElement('div')
  document.body.replaceChildren(target)
  const result = ref('')
  createApp({ render: () => h('main', [h(RustyCredentialConflictRecovery, {
    origin: 'https://rusty.example', scopeId: 'scope', workspaceId: 'board', owner: true,
    recover: async (origin: string, scopeId: string, workspaceId: string) => {
      if (mode === 'error') throw new Error('Policy changed; original upload retained')
      if (mode === 'pending') await new Promise<void>(() => {})
      result.value = `${origin} / ${scopeId} / ${workspaceId}`
    },
  }), h('p', { role: 'status', 'aria-label': 'Recovery result' }, result.value)]) }).mount(target)
}
