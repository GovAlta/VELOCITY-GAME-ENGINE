<script setup lang="ts">
import { computed, ref } from 'vue'
import { ShieldOff, Shield } from 'lucide-vue-next'
import { useCollaborationStore } from '@/stores/collaboration'

const props = defineProps<{
  projectId: string
  cloneDisabled: boolean
  cloneDisabledByName?: string | null
  cloneDisabledAt?: string | null
  cloneDisabledReason?: string | null
}>()

const store = useCollaborationStore()
const perms = computed(() => store.permissions[props.projectId])

const showDialog = ref(false)
const reason = ref('')
const saving = ref(false)
const errorMsg = ref('')

async function toggle() {
  errorMsg.value = ''
  saving.value = true
  try {
    await store.setClonePolicy(props.projectId, !props.cloneDisabled, reason.value.trim() || null)
    showDialog.value = false
    reason.value = ''
  } catch (e: any) {
    errorMsg.value = e?.response?.data?.error?.message || 'Failed to update policy'
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div v-if="perms?.canTogglePolicy || cloneDisabled" class="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/40 p-3 mb-4">
    <div class="flex items-start gap-3">
      <ShieldOff v-if="cloneDisabled" class="w-5 h-5 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
      <Shield v-else class="w-5 h-5 text-emerald-600 dark:text-emerald-400 flex-shrink-0 mt-0.5" />

      <div class="flex-1 min-w-0">
        <div class="text-sm font-semibold text-slate-900 dark:text-slate-100">
          {{ cloneDisabled ? 'Cloning disabled' : 'Cloning allowed' }}
          <span v-if="!cloneDisabled" class="text-xs font-normal text-slate-500 ml-1">— anyone with runner+ may clone</span>
        </div>
        <div v-if="cloneDisabled && cloneDisabledReason" class="text-xs text-slate-700 dark:text-slate-300 mt-1">
          Reason: {{ cloneDisabledReason }}
        </div>
        <div v-if="cloneDisabled && cloneDisabledByName" class="text-xs text-slate-500 mt-0.5">
          Disabled by {{ cloneDisabledByName }}
          <span v-if="cloneDisabledAt"> on {{ new Date(cloneDisabledAt).toLocaleDateString() }}</span>
        </div>
      </div>

      <button
        v-if="perms?.canTogglePolicy"
        @click="showDialog = true"
        class="text-xs px-3 py-1.5 rounded-lg flex-shrink-0"
        :class="cloneDisabled
          ? 'bg-emerald-100 hover:bg-emerald-200 dark:bg-emerald-900/30 text-emerald-800 dark:text-emerald-200'
          : 'bg-amber-100 hover:bg-amber-200 dark:bg-amber-900/30 text-amber-800 dark:text-amber-200'"
      >
        {{ cloneDisabled ? 'Re-enable cloning' : 'Disable cloning' }}
      </button>
    </div>

    <p v-if="errorMsg" class="text-xs text-red-600 dark:text-red-400 mt-2">{{ errorMsg }}</p>

    <div
      v-if="showDialog"
      class="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
      @click.self="!saving && (showDialog = false)"
    >
      <div class="bg-white dark:bg-slate-800 rounded-xl shadow-xl max-w-md w-full p-6">
        <h4 class="text-base font-semibold mb-2 text-slate-900 dark:text-slate-100">
          {{ cloneDisabled ? 'Re-enable cloning?' : 'Disable cloning?' }}
        </h4>
        <p class="text-xs text-slate-500 mb-4">
          <span v-if="!cloneDisabled">
            New clones will be blocked with a 403 CLONE_DISABLED error.
            Existing clones are unaffected. Re-enable any time.
          </span>
          <span v-else>
            Anyone with runner+ role will be able to clone this project again.
          </span>
        </p>
        <label v-if="!cloneDisabled" class="block text-xs text-slate-600 dark:text-slate-300 mb-1">Reason (optional)</label>
        <textarea
          v-if="!cloneDisabled"
          v-model="reason"
          rows="3"
          placeholder="e.g. gold-standard reference, do not fork"
          class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 mb-4"
        />

        <div class="flex justify-end gap-2">
          <button class="text-sm px-4 py-1.5 rounded-lg bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-200" :disabled="saving" @click="showDialog = false">
            Cancel
          </button>
          <button
            class="text-sm px-4 py-1.5 rounded-lg text-white"
            :class="cloneDisabled ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-amber-600 hover:bg-amber-700'"
            :disabled="saving"
            @click="toggle"
          >
            {{ cloneDisabled ? 'Re-enable' : 'Disable' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
