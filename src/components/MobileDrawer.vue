<script setup lang="ts">
import { ref } from "vue"
import { hideLeavingElement, showEnteringElement, useModal } from "../ui/modal"

defineProps<{
  canEditBoard?: boolean
  isOpen: boolean
  activeWorkspaceTitle: string
  isEditingBoard: boolean
  entityName: string
  showSignIn?: boolean
  signInReady?: boolean
}>()

const emit = defineEmits<{
  (e: "close"): void
  (e: "openWorkspaces"): void
  (e: "openSettings"): void
  (e: "signIn"): void
  (e: "toggleBoardEdit"): void
  (e: "openEntitySettings"): void
  (e: "openSync"): void
  (e: "openExport"): void
  (e: "openImport"): void
}>()

const drawerRef = ref<HTMLElement | null>(null)
const closeButtonRef = ref<HTMLButtonElement | null>(null)
useModal(drawerRef, () => emit("close"))

function handleAction(event: () => void) {
  emit("close")
  event()
}

</script>

<template>
  <Transition name="drawer" @before-enter="showEnteringElement" @before-leave="hideLeavingElement">
  <div v-if="isOpen" ref="drawerRef" class="mobile-drawer-root">
    <div class="mobile-drawer-backdrop" aria-hidden="true" @click="emit('close')"></div>
    <nav
      id="mobile-drawer"
      class="mobile-drawer"
      role="dialog"
      aria-modal="true"
      aria-label="Navigation menu"
      tabindex="-1"
    >
      <div class="drawer-header">
        <div class="drawer-workspace-info">
          <span class="drawer-eyebrow">WORKSPACE</span>
          <strong class="drawer-workspace-title">{{ activeWorkspaceTitle || "tincanban" }}</strong>
        </div>
        <button
          ref="closeButtonRef"
          class="icon-button drawer-close-btn"
          type="button"
          aria-label="Close menu"
          @click="emit('close')"
        >
          ✕
        </button>
      </div>

      <div class="drawer-scroll">
        <!-- Workspaces Group -->
        <section class="drawer-group" aria-labelledby="heading-workspaces">
          <h3 id="heading-workspaces" class="drawer-group-title">Workspaces</h3>
          <div class="drawer-group-items">
            <button
              class="drawer-item-btn"
              type="button"
              @click="handleAction(() => emit('openWorkspaces'))"
            >
              <span>Workspaces</span>
              <span class="drawer-item-arrow" aria-hidden="true">→</span>
            </button>
          </div>
        </section>

        <section class="drawer-group" aria-labelledby="heading-settings">
          <h3 id="heading-settings" class="drawer-group-title">Settings</h3>
          <div class="drawer-group-items">
            <button v-if="showSignIn" class="drawer-item-btn" type="button" :disabled="!signInReady" @click="handleAction(() => emit('signIn'))">
              <span>Sign in</span>
              <span class="drawer-item-arrow" aria-hidden="true">→</span>
            </button>
            <button
              class="drawer-item-btn"
              type="button"
              @click="handleAction(() => emit('openSettings'))"
            >
              <span>Settings</span>
              <span class="drawer-item-arrow" aria-hidden="true">→</span>
            </button>
            <button v-if="canEditBoard !== false" class="drawer-item-btn" type="button" @click="handleAction(() => emit('toggleBoardEdit'))">
              <span>{{ isEditingBoard ? "Done editing" : "Edit board" }}</span>
              <span class="drawer-item-arrow" aria-hidden="true">→</span>
            </button>
            <button v-if="isEditingBoard" class="drawer-item-btn" type="button" @click="handleAction(() => emit('openEntitySettings'))">
              <span>Edit {{ entityName }}</span>
              <span class="drawer-item-arrow" aria-hidden="true">→</span>
            </button>
          </div>
        </section>

        <!-- Collaboration Group -->
        <section class="drawer-group" aria-labelledby="heading-sync">
          <h3 id="heading-sync" class="drawer-group-title">Sync & data</h3>
          <div class="drawer-group-items">
            <button
              class="drawer-item-btn"
              type="button"
              @click="handleAction(() => emit('openSync'))"
            >
              <span>Sync</span>
              <span class="drawer-item-arrow" aria-hidden="true">→</span>
            </button>
          </div>
        </section>
      </div>
    </nav>
  </div>
  </Transition>
</template>
