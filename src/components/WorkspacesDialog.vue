<script setup lang="ts">
import type { Preset } from "../domain/seeds"

import DialogWindow from "./DialogWindow.vue"
import { computed, defineAsyncComponent, onBeforeUnmount, ref, watch, type Component } from "vue"
import type { WorkspaceCreationDraft } from "../domain/seeds"

const CreateWorkspaceDialog = defineAsyncComponent(() => import("./CreateWorkspaceDialog.vue") as Promise<{ default: Component }>)

const props = defineProps<{
  workspaces: { id: string; title: string; updatedAt: string }[]
  importing?: boolean
  importError?: string
  archivedWorkspaces: { id: string; title: string; updatedAt: string }[]
  activeWorkspaceId: string
  renameWorkspace: (payload: { id: string; title: string }) => Promise<void>
  archiveWorkspace: (id: string) => Promise<void>
  restoreWorkspace: (id: string) => Promise<void>
  canRenameWorkspace: (id: string) => boolean
  createWorkspace: (payload: { title: string; preset: Preset; config?: WorkspaceCreationDraft }) => Promise<void>
  readOwner: (id: string) => Promise<string>
  currentPersonId: string
  currentIdentityName: string
  knownPeople: { personId: string; name: string }[]
}>()

const emit = defineEmits<{
  (e: "close"): void
  (e: "switch", id: string): void
  (e: "import"): void
  (e: "busy", value: boolean): void
}>()

const isCreating = ref(false)
const creatingWorkspace = ref(false)
const editingId = ref("")
const editingTitle = ref("")
const renameError = ref("")
const renaming = ref(false)
const archivingId = ref("")
const archiveError = ref("")
const archiveBusy = ref(false)
const showArchived = ref(false)
const query = ref("")
const scope = ref<"all" | "mine" | "shared">("all")
const ownerIds = ref<Record<string, string>>({})
const pinnedIds = ref<string[]>([])
const recentIds = ref<string[]>([])
watch(() => Boolean(props.importing || creatingWorkspace.value), busy => emit("busy", busy), { immediate: true })
onBeforeUnmount(() => emit("busy", false))
const preferenceKey = computed(() => `tincanban:board-directory:${props.currentPersonId || "local"}`)
function ownerLabel(id: string) {
  const ownerId = ownerIds.value[id]
  if (!ownerId) return "Owner unavailable"
  if (ownerId === props.currentPersonId) return props.currentIdentityName || "You"
  const knownName = props.knownPeople.find(person => person.personId === ownerId)?.name
  if (knownName) return knownName
  const ids = [...new Set(Object.values(ownerIds.value).filter(Boolean))]
  let length = Math.min(6, ownerId.length)
  while (length < ownerId.length && ids.filter(candidate => candidate.slice(0, length) === ownerId.slice(0, length)).length > 1) length++
  return `Participant · ${ownerId.slice(0, length)}`
}
const filteredWorkspaces = computed(() => props.workspaces.filter(ws => {
  const ownerId = ownerIds.value[ws.id]
  if (scope.value !== "all" && !ownerId) return false
  const mine = ownerId === props.currentPersonId
  const owner = ownerLabel(ws.id)
  return (scope.value === "all" || (scope.value === "mine" ? mine : !mine)) &&
    `${ws.title} ${displayTitle(ws.title)} ${owner} ${ownerIds.value[ws.id] ?? ""}`.toLocaleLowerCase().includes(query.value.trim().toLocaleLowerCase())
}))
const pinnedWorkspaces = computed(() => pinnedIds.value.map(id => props.workspaces.find(ws => ws.id === id)).filter((ws): ws is typeof props.workspaces[number] => Boolean(ws)))
const recentWorkspaces = computed(() => recentIds.value.map(id => props.workspaces.find(ws => ws.id === id)).filter((ws): ws is typeof props.workspaces[number] => Boolean(ws)).slice(0, 5))
const directoryGroups = computed(() => {
  if (query.value.trim() || scope.value !== "all") return [{ key: "all", label: "", rows: filteredWorkspaces.value }]
  const pinned = pinnedWorkspaces.value
  const pinnedSet = new Set(pinned.map(workspace => workspace.id))
  const recent = recentWorkspaces.value.filter(workspace => !pinnedSet.has(workspace.id))
  const featured = new Set([...pinned, ...recent].map(workspace => workspace.id))
  return [
    { key: "pinned", label: "Pinned", rows: pinned },
    { key: "recent", label: "Recent", rows: recent },
    { key: "other", label: featured.size ? "Other boards" : "", rows: filteredWorkspaces.value.filter(workspace => !featured.has(workspace.id)) },
  ].filter(group => group.rows.length)
})

let ownerLoad = 0
watch(() => props.workspaces.map(ws => ws.id).join("|"), async () => {
  const load = ++ownerLoad
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(preferenceKey.value) || "{}")
    const preferences = readDirectoryPreferences(saved)
    pinnedIds.value = preferences.pinned
    recentIds.value = preferences.recent
  } catch { pinnedIds.value = []; recentIds.value = [] }
  const owners = await Promise.all(props.workspaces.map(async ws => [ws.id, await props.readOwner(ws.id).catch(() => "")] as const))
  if (load === ownerLoad) ownerIds.value = { ...ownerIds.value, ...Object.fromEntries(owners) }
}, { immediate: true })

function persistDirectory() {
  try { localStorage.setItem(preferenceKey.value, JSON.stringify({ pinned: pinnedIds.value, recent: recentIds.value.slice(0, 5) })) }
  catch { /* directory preferences are local convenience */ }
}
function togglePin(id: string) {
  pinnedIds.value = pinnedIds.value.includes(id) ? pinnedIds.value.filter(item => item !== id) : [...pinnedIds.value, id]
  persistDirectory()
}
function movePin(id: string, delta: number) {
  const index = pinnedIds.value.indexOf(id)
  const target = index + delta
  if (index < 0 || target < 0 || target >= pinnedIds.value.length) return
  const next = [...pinnedIds.value]
  ;[next[index], next[target]] = [next[target]!, next[index]!]
  pinnedIds.value = next
  persistDirectory()
}

function handleSwitch(id: string) {
  recentIds.value = [id, ...recentIds.value.filter(item => item !== id)].slice(0, 5)
  persistDirectory()
  emit("switch", id)
  emit("close")
}

function startRename(workspace: { id: string; title: string }) {
  editingId.value = workspace.id
  editingTitle.value = workspace.title
  renameError.value = ""
}

async function handleRename() {
  if (!editingTitle.value.trim()) {
    renameError.value = "Workspace name is required"
    return
  }
  renameError.value = ""
  renaming.value = true
  try {
    await props.renameWorkspace({ id: editingId.value, title: editingTitle.value.trim() })
    editingId.value = ""
  } catch (error) {
    renameError.value = error instanceof Error ? error.message : "Could not rename workspace"
  } finally {
    renaming.value = false
  }
}

function startArchive(id: string) {
  archivingId.value = id
  archiveError.value = ""
  editingId.value = ""
  renameError.value = ""
}

async function confirmArchive(id: string) {
  archiveBusy.value = true
  archiveError.value = ""
  try {
    await props.archiveWorkspace(id)
    archivingId.value = ""
  } catch (error) {
    archiveError.value = error instanceof Error ? error.message : "Could not archive workspace"
  } finally {
    archiveBusy.value = false
  }
}

async function restoreArchived(id: string) {
  archiveBusy.value = true
  archiveError.value = ""
  try {
    await props.restoreWorkspace(id)
  } catch (error) {
    archiveError.value = error instanceof Error ? error.message : "Could not restore workspace"
  } finally {
    archiveBusy.value = false
  }
}

function displayTitle(title: string) {
  return title
}

function readDirectoryPreferences(value: unknown): { pinned: string[]; recent: string[] } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { pinned: [], recent: [] }
  const preferences = value as Record<string, unknown>
  const pinned = Array.isArray(preferences.pinned)
    ? preferences.pinned.filter((id): id is string => typeof id === "string")
    : []
  const recent = Array.isArray(preferences.recent)
    ? preferences.recent.filter((id): id is string => typeof id === "string").slice(0, 5)
    : []
  return { pinned, recent }
}
</script>

<template>
  <DialogWindow :window-id="`workspaces:${currentPersonId || 'local'}`" :workspace-id="activeWorkspaceId" :title="isCreating ? 'Create workspace' : 'Workspaces'" :busy="importing || creatingWorkspace" @close="emit('close')">
    <section v-if="!isCreating" class="dialog dialog-window-content">
      <section class="board-directory" aria-label="Board discovery">
        <label class="board-directory-search">Search boards<input v-model="query" type="search" aria-label="Search boards" placeholder="Title or owner" /></label>
        <div class="board-directory-filters" role="group" aria-label="Board filters">
          <button v-for="filter in ['all', 'mine', 'shared'] as const" :key="filter" type="button" :aria-pressed="scope === filter" @click="scope = filter">{{ filter === 'all' ? 'All boards' : filter === 'mine' ? 'Mine' : 'Shared' }}</button>
        </div>
      <div class="workspace-list">
        <section v-for="group in directoryGroups" :key="group.key" :aria-label="group.label ? `${group.label} boards` : 'Matching boards'">
        <h3 v-if="group.label">{{ group.label }}</h3>
        <div
          v-for="(ws, index) in group.rows"
          :key="ws.id"
          :data-workspace-id="ws.id"
          class="workspace-item"
          :class="{ 'workspace-item-active': ws.id === activeWorkspaceId }"
        >
          <button class="workspace-switch" type="button" @click="handleSwitch(ws.id)">
            <strong>{{ displayTitle(ws.title) }}</strong>
            <small>Owner: {{ ownerLabel(ws.id) }}</small>
            <span v-if="ws.id === activeWorkspaceId" class="workspace-active-badge">Active</span>
          </button>
          <div class="workspace-item-actions">
            <button v-if="group.key === 'pinned'" type="button" :aria-label="`Move ${ws.title} up`" :disabled="index === 0" @click="movePin(ws.id, -1)">↑</button>
            <button v-if="group.key === 'pinned'" type="button" :aria-label="`Move ${ws.title} down`" :disabled="index === group.rows.length - 1" @click="movePin(ws.id, 1)">↓</button>
            <button type="button" :aria-label="pinnedIds.includes(ws.id) ? `Unpin ${ws.title}` : `Pin ${ws.title}`" @click="togglePin(ws.id)">{{ pinnedIds.includes(ws.id) ? '★' : '☆' }}</button>
            <button v-if="canRenameWorkspace(ws.id)" type="button" aria-label="Rename" @click="startRename(ws)">Rename</button>
            <button type="button" aria-label="Archive" :disabled="archiveBusy" @click="startArchive(ws.id)">Archive</button>
          </div>
          <form v-if="editingId === ws.id" class="workspace-rename-form" :aria-busy="renaming" @submit.prevent="handleRename">
            <label>
              <span class="sr-only">Workspace name</span>
              <input v-model="editingTitle" aria-label="Workspace name" :disabled="renaming" autofocus />
            </label>
            <button class="button button-primary" type="submit" :disabled="renaming">{{ renaming ? 'Saving…' : 'Save name' }}</button>
            <button class="button button-quiet" type="button" :disabled="renaming" @click="editingId = ''; renameError = ''">Cancel</button>
            <p v-if="renameError" class="form-error" role="alert">{{ renameError }}</p>
          </form>
          <div v-if="archivingId === ws.id" class="workspace-delete-confirm" role="group" :aria-label="`Archive ${ws.title}`">
            <p>Archive “{{ ws.title }}” and hide it from active workspaces? Its cards and documents remain saved.</p>
            <button class="button button-danger" type="button" :disabled="archiveBusy" @click="confirmArchive(ws.id)">{{ archiveBusy ? 'Archiving…' : 'Archive workspace' }}</button>
            <button class="button button-quiet" type="button" :disabled="archiveBusy" @click="archivingId = ''">Cancel</button>
            <p v-if="archiveError" class="form-error" role="alert">{{ archiveError }}</p>
          </div>
        </div>
        </section>
        <p v-if="!filteredWorkspaces.length" class="dialog-copy" role="status">No boards match this search.</p>
      </div>

      </section>

      <button v-if="archivedWorkspaces.length" class="button button-quiet" type="button" @click="showArchived = !showArchived">{{ showArchived ? 'Hide archived' : 'Show archived' }}</button>
      <div v-if="showArchived" class="workspace-list" aria-label="Archived workspaces">
        <div v-for="ws in archivedWorkspaces" :key="ws.id" class="workspace-item">
          <div class="workspace-label"><strong>{{ displayTitle(ws.title) }}</strong></div>
          <div class="workspace-item-actions"><button type="button" :disabled="archiveBusy" @click="restoreArchived(ws.id)">{{ archiveBusy ? 'Restoring…' : 'Restore workspace' }}</button></div>
        </div>
        <p v-if="archiveError" class="form-error" role="alert">{{ archiveError }}</p>
      </div>

      <div class="dialog-actions">
        <button class="button button-primary" type="button" @click="isCreating = true">New workspace</button>
        <button class="button button-quiet" type="button" :disabled="importing" @click="emit('import')">{{ importing ? 'Importing…' : 'Import as new board' }}</button>
      </div>
      <p v-if="importing" role="status">Importing this backup as a new board…</p>
      <p v-if="importError" class="form-error" role="alert">{{ importError }}</p>
    </section>

    <CreateWorkspaceDialog v-else :create-workspace="createWorkspace" @busy="creatingWorkspace = $event" @close="isCreating = false; creatingWorkspace = false" />
  </DialogWindow>
</template>

<style scoped>
.board-directory { display: grid; gap: var(--space-3); margin: 0 0 var(--space-4); }
.board-directory-search { display: grid; gap: var(--space-1); font-weight: 650; }
.board-directory-search input { min-height: var(--control-size-compact); padding: var(--space-2) var(--space-2); }
.board-directory-filters { display: flex; gap: var(--space-1); flex-wrap: wrap; }
.board-directory-filters button[aria-pressed="true"] { background: var(--ink); color: var(--paper); }
.board-directory section { display: grid; gap: var(--space-1); }
.board-directory h3 { margin: var(--space-1) 0; font-size: .84rem; }
.workspace-switch small { color: var(--muted); font-size: .76rem; font-weight: 500; }
.workspace-switch { display: flex; flex-direction: column; align-items: flex-start; gap: var(--space-1); }
</style>
