<script setup lang="ts">
import { computed, ref } from 'vue'
import { Lock, LockOpen, ShieldAlert } from 'lucide-vue-next'
import { useCollaborationStore } from '@/stores/collaboration'

const props = defineProps<{
  projectId: string
  isLocked: boolean
  lockedBy: string | null
  lockedByName?: string | null
  lockedAt?: string | null
  lockReason?: string | null
}>()

const store = useCollaborationStore()
const perms = computed(() => store.permissions[props.projectId])

const showLockDialog = ref(false)
const lockReason = ref('')
const errorMsg = ref('')

const canLock = computed(() => !props.isLocked && perms.value?.canToggleLock)
const canSelfUnlock = computed(() => props.isLocked && perms.value?.lockedBy === perms.value?.lockedBy && perms.value?.canToggleLock)
const canForceUnlock = computed(() => props.isLocked && perms.value?.isAdmin)

async function lock() {
  errorMsg.value = ''
  try {
    await store.lockProject(props.projectId, lockReason.value.trim() || undefined)
    showLockDialog.value = false
    lockReason.value = ''
  } catch (e: any) {
    errorMsg.value = e?.response?.data?.error?.message || 'Failed to acquire lock'
  }
}

async function unlock(force = false) {
  if (force && !confirm('Force-unlock will override the original locker and write a project_update audit entry. Continue?')) return
  errorMsg.value = ''
  try {
    await store.unlockProject(props.projectId, force)
  } catch (e: any) {
    errorMsg.value = e?.response?.data?.error?.message || 'Failed to release lock'
  }
}
</script>

<template>
  <div v-if="isLocked" class="rounded-xl border border-rose-300 dark:border-rose-700 bg-rose-50 dark:bg-rose-950/30 p-4 mb-4 flex items-start gap-3">
    <Lock class="w-5 h-5 text-rose-600 dark:text-rose-400 flex-shrink-0 mt-0.5" />
    <div class="flex-1 min-w-0">
      <div class="text-sm font-semibold text-rose-900 dark:text-rose-100">
        Locked by {{ lockedByName || 'another user' }}
      </div>
      <div v-if="lockReason" class="text-xs mt-1 text-rose-700 dark:text-rose-300">
        Reason: {{ lockReason }}
      </div>
      <div v-if="lockedAt" class="text-xs mt-0.5 text-rose-600/70 dark:text-rose-400/70">
        Since {{ new Date(lockedAt).toLocaleString() }}
      </div>
      <p class="text-xs mt-2 text-rose-700 dark:text-rose-300">
        While locked, only the locker (and admins) can edit this project, its modules, and its velocity board.
      </p>
    </div>
    <div class="flex flex-col gap-2 flex-shrink-0">
      <button
        v-if="canSelfUnlock"
        @click="unlock(false)"
        class="text-xs px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-700 text-white flex items-center gap-1"
      >
        <LockOpen class="w-3.5 h-3.5" /> Release lock
      </button>
      <button
        v-if="canForceUnlock && perms?.lockedBy !== perms?.lockedBy"
        @click="unlock(true)"
        class="text-xs px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-700 text-white flex items-center gap-1"
      >
        <ShieldAlert class="w-3.5 h-3.5" /> Force-unlock (admin)
      </button>
    </div>
  </div>

  <div v-else-if="canLock" class="flex justify-end mb-4">
    <button
      @click="showLockDialog = true"
      class="text-xs px-3 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-200 flex items-center gap-1"
      title="Prevent other members from editing while you focus on this project"
    >
      <Lock class="w-3.5 h-3.5" /> Lock for focused work
    </button>
  </div>

  <p v-if="errorMsg" class="text-xs text-red-600 dark:text-red-400 mb-2">{{ errorMsg }}</p>

  <!-- Lock dialog -->
  <div
    v-if="showLockDialog"
    class="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
    @click.self="showLockDialog = false"
  >
    <div class="bg-white dark:bg-slate-800 rounded-xl shadow-xl max-w-md w-full p-6">
      <h4 class="text-base font-semibold mb-2 text-slate-900 dark:text-slate-100">Lock project</h4>
      <p class="text-xs text-slate-500 mb-4">
        While locked, only you (and admins) can mutate this project. Other members can still read it.
        Unlock when you're done.
      </p>
      <label class="block text-xs text-slate-600 dark:text-slate-300 mb-1">Reason (optional)</label>
      <textarea
        v-model="lockReason"
        rows="3"
        placeholder="e.g. running deep audit; do not modify"
        class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 mb-4"
      />
      <div class="flex justify-end gap-2">
        <button
          class="text-sm px-4 py-1.5 rounded-lg bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-200"
          @click="showLockDialog = false"
        >
          Cancel
        </button>
        <button
          class="text-sm px-4 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-700 text-white flex items-center gap-1"
          @click="lock"
        >
          <Lock class="w-3.5 h-3.5" /> Acquire lock
        </button>
      </div>
    </div>
  </div>
</template>
