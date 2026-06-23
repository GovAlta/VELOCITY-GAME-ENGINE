<script setup lang="ts">
import { ref } from 'vue'
import { GitFork, Loader2 } from 'lucide-vue-next'
import { useCollaborationStore } from '@/stores/collaboration'
import { useRouter } from 'vue-router'

const props = defineProps<{
  projectId: string
  projectName: string
  visible: boolean
}>()

const emit = defineEmits<{
  (e: 'update:visible', v: boolean): void
  (e: 'cloned', newProjectId: string): void
}>()

const router = useRouter()
const store = useCollaborationStore()

const versionLabel = ref('')
const copyLinks = ref(true)
const copyBudgets = ref(false)
const submitting = ref(false)
const errorMsg = ref('')

async function clone() {
  errorMsg.value = ''
  submitting.value = true
  try {
    const result = await store.cloneProject(props.projectId, {
      versionLabel: versionLabel.value.trim() || null,
      copyLinks: copyLinks.value,
      copyBudgets: copyBudgets.value,
    })
    emit('cloned', result.pk_project)
    emit('update:visible', false)
    versionLabel.value = ''
    // Navigate to the new clone
    router.push(`/projects/${result.pk_project}`)
  } catch (e: any) {
    const code = e?.response?.data?.error?.code
    if (code === 'CLONE_DISABLED') {
      errorMsg.value = 'An admin has disabled cloning for this project.'
    } else if (code === 'CLONE_OF_CLONE') {
      errorMsg.value = 'You can only clone a top-level project, not another clone.'
    } else {
      errorMsg.value = e?.response?.data?.error?.message || 'Clone failed'
    }
  } finally {
    submitting.value = false
  }
}

function close() {
  if (submitting.value) return
  emit('update:visible', false)
}
</script>

<template>
  <div
    v-if="visible"
    class="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
    @click.self="close"
  >
    <div class="bg-white dark:bg-slate-800 rounded-xl shadow-xl max-w-md w-full p-6">
      <h4 class="text-base font-semibold mb-1 text-slate-900 dark:text-slate-100 flex items-center gap-2">
        <GitFork class="w-4 h-4" /> Clone project
      </h4>
      <p class="text-xs text-slate-500 mb-4">
        Creates your own copy of <span class="font-medium">{{ projectName }}</span>.
        Modules and links are copied; status, dates, and percent complete reset.
        You become the sole owner.
      </p>

      <label class="block text-xs text-slate-600 dark:text-slate-300 mb-1">Version label (optional)</label>
      <input
        v-model="versionLabel"
        type="text"
        placeholder="e.g. CGI alt approach"
        maxlength="200"
        class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 mb-4"
      />

      <div class="space-y-2 mb-4">
        <label class="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
          <input v-model="copyLinks" type="checkbox" class="rounded" />
          Copy external links (GitHub, Jira, Confluence, SharePoint)
        </label>
        <label class="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
          <input v-model="copyBudgets" type="checkbox" class="rounded" />
          Copy budget lines (resets <em>spent</em> to 0)
        </label>
      </div>

      <p v-if="errorMsg" class="text-xs text-red-600 dark:text-red-400 mb-3">{{ errorMsg }}</p>

      <div class="flex justify-end gap-2">
        <button
          class="text-sm px-4 py-1.5 rounded-lg bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-200 disabled:opacity-50"
          :disabled="submitting"
          @click="close"
        >
          Cancel
        </button>
        <button
          class="text-sm px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white flex items-center gap-1 disabled:opacity-50"
          :disabled="submitting"
          @click="clone"
        >
          <Loader2 v-if="submitting" class="w-3.5 h-3.5 animate-spin" />
          <GitFork v-else class="w-3.5 h-3.5" />
          Clone
        </button>
      </div>
    </div>
  </div>
</template>
