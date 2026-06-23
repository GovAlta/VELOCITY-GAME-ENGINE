<script setup lang="ts">
import { ref, onMounted } from 'vue'
import api from '@/lib/api'
import Button from 'primevue/button'
import {
  Paperclip,
  Download,
  Upload,
  FileText,
  RefreshCw,
} from 'lucide-vue-next'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface Artifact {
  id: string
  name: string
  size: number
  modified_at: string
  web_url: string
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------
const props = defineProps<{
  moduleId: string
  stepName: string
  canEdit: boolean
}>()

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const artifacts = ref<Artifact[]>([])
const loading = ref(true)
const uploading = ref(false)
const errorMessage = ref('')
const fileInputRef = ref<HTMLInputElement | null>(null)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function formatBytes(bytes?: number): string {
  if (bytes == null || bytes === 0) return '--'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function getExtensionLabel(name: string): { label: string; color: string } {
  const ext = name.split('.').pop()?.toLowerCase() || ''
  const map: Record<string, { label: string; color: string }> = {
    pdf: { label: 'PDF', color: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300' },
    doc: { label: 'DOC', color: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300' },
    docx: { label: 'DOCX', color: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300' },
    xls: { label: 'XLS', color: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300' },
    xlsx: { label: 'XLSX', color: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300' },
    ppt: { label: 'PPT', color: 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300' },
    pptx: { label: 'PPTX', color: 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300' },
    png: { label: 'PNG', color: 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300' },
    jpg: { label: 'JPG', color: 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300' },
    md: { label: 'MD', color: 'bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-300' },
  }
  return map[ext] || { label: ext.toUpperCase() || 'FILE', color: 'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300' }
}

function handleDownload(artifact: Artifact) {
  const baseUrl = api.defaults.baseURL || '/api/v1'
  window.open(`${baseUrl}/sharepoint/files/${artifact.id}/download`, '_blank')
}

// ---------------------------------------------------------------------------
// Data Fetching
// ---------------------------------------------------------------------------
async function fetchArtifacts() {
  loading.value = true
  errorMessage.value = ''
  try {
    const res = await api.get(
      `/sharepoint/modules/${props.moduleId}/steps/${props.stepName}/artifacts`,
    )
    artifacts.value = (res.data?.data ?? res.data ?? [])
      .filter((a: any) => !a.folder)
      .map((a: any) => ({
        id: a.id,
        name: a.name,
        size: a.size || 0,
        modified_at: a.lastModifiedDateTime || '',
        web_url: a.webUrl || '',
      }))
  } catch (err: any) {
    errorMessage.value = err?.response?.data?.message || 'Failed to load artifacts'
    artifacts.value = []
  } finally {
    loading.value = false
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
function triggerUpload() {
  fileInputRef.value?.click()
}

async function handleFileUpload(event: Event) {
  const input = event.target as HTMLInputElement
  const fileList = input.files
  if (!fileList || fileList.length === 0) return

  uploading.value = true
  errorMessage.value = ''
  try {
    // Upload one file at a time (multer expects single 'file' field)
    for (let i = 0; i < fileList.length; i++) {
      const formData = new FormData()
      formData.append('file', fileList[i])
      await api.post(
        `/sharepoint/modules/${props.moduleId}/steps/${props.stepName}/artifacts`,
        formData,
        { headers: { 'Content-Type': 'multipart/form-data' } },
      )
    }
    await fetchArtifacts()
  } catch (err: any) {
    errorMessage.value = err?.response?.data?.message || 'Upload failed'
  } finally {
    uploading.value = false
    input.value = ''
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
onMounted(fetchArtifacts)
</script>

<template>
  <div class="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-hidden">
    <!-- Header -->
    <div class="px-4 py-3 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
      <div class="flex items-center gap-2">
        <Paperclip class="w-4 h-4 text-slate-500 dark:text-slate-400" />
        <h4 class="text-xs font-semibold font-jakarta text-slate-700 dark:text-slate-300 uppercase tracking-wider">
          Step Artifacts
        </h4>
        <span
          v-if="!loading && artifacts.length > 0"
          class="inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1.5 rounded-full bg-slate-100 dark:bg-slate-700 text-[11px] font-semibold font-geist text-slate-600 dark:text-slate-400"
        >
          {{ artifacts.length }}
        </span>
      </div>
      <button
        v-if="canEdit"
        :disabled="uploading"
        @click="triggerUpload"
        class="inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-slate-200 dark:border-slate-600 text-[11px] font-geist text-slate-500 dark:text-slate-400 hover:text-indigo-600 dark:hover:text-indigo-400 hover:border-indigo-300 dark:hover:border-indigo-600 transition-colors disabled:opacity-50"
      >
        <Upload class="w-3 h-3" />
        {{ uploading ? 'Uploading...' : 'Upload' }}
      </button>
      <input
        ref="fileInputRef"
        type="file"
        multiple
        class="hidden"
        @change="handleFileUpload"
      />
    </div>

    <!-- Error Banner -->
    <div
      v-if="errorMessage"
      class="px-4 py-2 bg-red-50 dark:bg-red-900/20 text-xs font-geist text-red-600 dark:text-red-400"
    >
      {{ errorMessage }}
    </div>

    <!-- Loading -->
    <div v-if="loading" class="px-4 py-6 flex items-center justify-center">
      <RefreshCw class="w-4 h-4 text-slate-400 animate-spin" />
    </div>

    <!-- Empty State -->
    <div v-else-if="artifacts.length === 0" class="px-4 py-6 text-center">
      <FileText class="w-8 h-8 text-slate-200 dark:text-slate-700 mx-auto mb-2" />
      <p class="text-xs font-geist text-slate-400 dark:text-slate-500">No artifacts yet</p>
      <p v-if="canEdit" class="text-[11px] font-geist text-slate-400 dark:text-slate-500 mt-1">
        Upload files to attach artifacts to this step.
      </p>
    </div>

    <!-- Artifact List -->
    <div v-else class="divide-y divide-slate-100 dark:divide-slate-800">
      <div
        v-for="artifact in artifacts"
        :key="artifact.id"
        class="group flex items-center gap-2.5 px-4 py-2.5 hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors"
      >
        <span
          class="inline-flex items-center justify-center px-1.5 py-0.5 rounded text-[10px] font-bold tracking-wide leading-none flex-shrink-0"
          :class="getExtensionLabel(artifact.name).color"
        >
          {{ getExtensionLabel(artifact.name).label }}
        </span>
        <div class="flex-1 min-w-0">
          <p class="text-sm font-geist text-slate-800 dark:text-slate-200 truncate">
            {{ artifact.name }}
          </p>
          <p class="text-[11px] font-geist text-slate-400 dark:text-slate-500">
            {{ formatBytes(artifact.size) }}
          </p>
        </div>
        <button
          class="opacity-0 group-hover:opacity-100 transition-opacity p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-400 hover:text-sky-600 dark:hover:text-sky-400 flex-shrink-0"
          title="Download"
          @click="handleDownload(artifact)"
        >
          <Download class="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  </div>
</template>
