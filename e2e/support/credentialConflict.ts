import { createApp, h, ref } from 'vue'
import RustyCredentialConflictRecovery from '../../src/components/RustyCredentialConflictRecovery.vue'
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
