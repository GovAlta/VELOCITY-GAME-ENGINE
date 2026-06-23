<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue'
import api from '@/lib/api'
import Button from 'primevue/button'
import {
  Cloud,
  FolderOpen,
  ExternalLink,
  RefreshCw,
  Search,
  Download,
  FileText,
  File,
  HardDrive,
  ChevronRight,
} from 'lucide-vue-next'
import SharePointBrowser from './SharePointBrowser.vue'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface FolderInfo {
  id: string
  name: string
  path: string
  web_url: string
  folder_type: string
  file_count?: number
}

interface RecentFile {
  id: string
  name: string
  path: string
  web_url: string
  size: number
  modified_at: string
  folder_name: string
}

interface AuditResult {
  id: string
  status: 'completed' | 'running' | 'failed'
  file_count: number
  summary: string
  created_at: string
}

// ---------------------------------------------------------------------------
// Props & Emits
// ---------------------------------------------------------------------------
const props = defineProps<{
  projectId: string
  projectName: string
  canEdit: boolean
}>()

const emit = defineEmits<{
  refresh: []
}>()

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const connected = ref(false)
const loading = ref(true)
const folders = ref<FolderInfo[]>([])
const recentFiles = ref<RecentFile[]>([])
const latestAudit = ref<AuditResult | null>(null)
const browserVisible = ref(false)
const creatingFolders = ref(false)
const auditRunning = ref(false)
const errorMessage = ref('')

// ---------------------------------------------------------------------------
// Computed
// ---------------------------------------------------------------------------
const projectFolder = computed(() => folders.value.find((f) => f.folder_type === 'project'))
const moduleFolders = computed(() => folders.value.filter((f) => f.folder_type === 'module'))
const stepFolders = computed(() => folders.value.filter((f) => f.folder_type === 'step'))
const auditFolder = computed(() => folders.value.find((f) => f.folder_type === 'audit'))

const connectionStatusClass = computed(() =>
  connected.value
    ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
    : 'bg-slate-100 text-slate-500 dark:bg-slate-700 dark:text-slate-400',
)

const connectionStatusLabel = computed(() => (connected.value ? 'Connected' : 'Not Configured'))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function formatBytes(bytes?: number): string {
  if (bytes == null || bytes === 0) return '--'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatDate(dateStr?: string): string {
  if (!dateStr) return '--'
  const d = new Date(dateStr)
  return d.toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' })
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

function handleDownload(file: RecentFile) {
  const baseUrl = api.defaults.baseURL || '/api/v1'
  window.open(`${baseUrl}/sharepoint/files/${file.id}/download`, '_blank')
}

// ---------------------------------------------------------------------------
// Data Fetching
// ---------------------------------------------------------------------------
async function checkConnection() {
  try {
    const res = await api.get('/sharepoint/status')
    connected.value = res.data?.data?.connected ?? res.data?.connected ?? false
  } catch {
    connected.value = false
  }
}

async function fetchFolders() {
  try {
    const res = await api.get(`/sharepoint/projects/${props.projectId}/folders`)
    const raw = res.data?.data ?? res.data ?? []
    folders.value = raw.map((f: any) => ({
      id: f.pk_sharepoint_folder,
      name: f.sp_folder_path?.split('/').pop() || '',
      path: f.sp_folder_path || '',
      web_url: f.sp_web_url || '',
      folder_type: f.folder_type || 'project',
    }))
  } catch {
    folders.value = []
  }
}

async function fetchRecentFiles() {
  const pf = projectFolder.value
  if (!pf) return
  try {
    const res = await api.get(`/sharepoint/folders/${pf.id}/files`)
    const allFiles: RecentFile[] = (res.data?.data ?? res.data ?? [])
      .filter((f: any) => !f.folder) // skip subfolders
      .map((f: any) => ({
        id: f.id,
        name: f.name,
        path: f.parentReference?.path || '',
        web_url: f.webUrl || '',
        size: f.size || 0,
        modified_at: f.lastModifiedDateTime || '',
        folder_name: pf.name,
      }))
    // Sort by modified date descending, take top 5
    allFiles.sort((a, b) => new Date(b.modified_at).getTime() - new Date(a.modified_at).getTime())
    recentFiles.value = allFiles.slice(0, 5)
  } catch {
    recentFiles.value = []
  }
}

async function loadAll() {
  loading.value = true
  errorMessage.value = ''
  try {
    await checkConnection()
    if (connected.value) {
      await fetchFolders()
      await fetchRecentFiles()
    }
  } catch (err: any) {
    errorMessage.value = err?.response?.data?.message || 'Failed to load SharePoint data'
  } finally {
    loading.value = false
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
async function createFolders() {
  creatingFolders.value = true
  errorMessage.value = ''
  try {
    await api.post(`/sharepoint/projects/${props.projectId}/folders`)
    await fetchFolders()
    await fetchRecentFiles()
    emit('refresh')
  } catch (err: any) {
    errorMessage.value = err?.response?.data?.message || 'Failed to create folders'
  } finally {
    creatingFolders.value = false
  }
}

async function runAudit() {
  auditRunning.value = true
  errorMessage.value = ''
  try {
    const res = await api.post(`/sharepoint/projects/${props.projectId}/audit`)
    latestAudit.value = res.data?.data ?? res.data ?? null
  } catch (err: any) {
    errorMessage.value = err?.response?.data?.message || 'Audit failed'
  } finally {
    auditRunning.value = false
  }
}

function openBrowser() {
  browserVisible.value = true
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
// SSE: auto-refresh on SharePoint events
let sseSource: EventSource | null = null
const SP_EVENTS = [
  'sharepoint_file_uploaded', 'sharepoint_file_deleted', 'sharepoint_item_renamed',
  'sharepoint_item_moved', 'sharepoint_folder_deleted', 'sharepoint_subfolder_created',
  'sharepoint_folders_created', 'sharepoint_import', 'sharepoint_ai_processing',
]

function connectSharePointSSE() {
  const baseUrl = import.meta.env.VITE_API_BASE_URL || '/api'
  sseSource = new EventSource(`${baseUrl}/velocity/stream`)
  for (const evt of SP_EVENTS) {
    sseSource.addEventListener(evt, (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data)
        // Only refresh if this event is for our project
        if (!data.projectId || data.projectId === props.projectId) {
          loadAll()
        }
      } catch { loadAll() }
    })
  }
  sseSource.onerror = () => {
    sseSource?.close()
    setTimeout(connectSharePointSSE, 10000)
  }
}

onMounted(() => {
  loadAll()
  connectSharePointSSE()
})

onUnmounted(() => {
  sseSource?.close()
  sseSource = null
})
</script>

<template>
  <div class="rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-hidden">
    <!-- Header -->
    <div class="px-5 py-4 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
      <div class="flex items-center gap-3">
        <div class="flex items-center justify-center w-9 h-9 rounded-xl bg-sky-50 dark:bg-sky-900/30">
          <Cloud class="w-4.5 h-4.5 text-sky-600 dark:text-sky-400" />
        </div>
        <div>
          <h3 class="text-sm font-semibold font-jakarta text-slate-900 dark:text-white">SharePoint</h3>
        </div>
        <span
          class="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold font-geist"
          :class="connectionStatusClass"
        >
          {{ connectionStatusLabel }}
        </span>
      </div>

      <div class="flex items-center gap-2">
        <button
          v-if="canEdit && connected"
          :disabled="creatingFolders"
          @click="createFolders"
          class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-600 text-xs font-geist text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 hover:text-indigo-600 dark:hover:text-indigo-400 hover:border-indigo-300 dark:hover:border-indigo-600 transition-colors disabled:opacity-50"
        >
          <FolderOpen class="w-3.5 h-3.5" />
          {{ creatingFolders ? 'Creating...' : 'Create Folders' }}
        </button>

        <button
          v-if="connected"
          @click="openBrowser"
          class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-600 text-xs font-geist text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 hover:text-indigo-600 dark:hover:text-indigo-400 hover:border-indigo-300 dark:hover:border-indigo-600 transition-colors"
        >
          <Search class="w-3.5 h-3.5" />
          Browse
        </button>

        <button
          v-if="canEdit && connected && folders.length > 0"
          :disabled="auditRunning"
          @click="runAudit"
          class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-600 text-xs font-geist text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 hover:text-indigo-600 dark:hover:text-indigo-400 hover:border-indigo-300 dark:hover:border-indigo-600 transition-colors disabled:opacity-50"
        >
          <RefreshCw class="w-3.5 h-3.5" :class="{ 'animate-spin': auditRunning }" />
          {{ auditRunning ? 'Auditing...' : 'Audit' }}
        </button>
      </div>
    </div>

    <!-- Loading -->
    <div v-if="loading" class="px-5 py-8 flex items-center justify-center">
      <RefreshCw class="w-5 h-5 text-slate-400 animate-spin" />
    </div>

    <!-- Not Connected -->
    <div v-else-if="!connected" class="px-5 py-8 text-center">
      <Cloud class="w-10 h-10 text-slate-200 dark:text-slate-700 mx-auto mb-3" />
      <p class="text-sm font-geist text-slate-500 dark:text-slate-400 mb-1">
        SharePoint integration is not configured for this project.
      </p>
      <p class="text-xs font-geist text-slate-400 dark:text-slate-500">
        Contact your administrator to enable SharePoint connectivity.
      </p>
    </div>

    <!-- Connected Content -->
    <div v-else class="divide-y divide-slate-100 dark:divide-slate-800">
      <!-- Error Banner -->
      <div
        v-if="errorMessage"
        class="px-5 py-3 bg-red-50 dark:bg-red-900/20 text-sm font-geist text-red-700 dark:text-red-300 flex items-center justify-between"
      >
        <span>{{ errorMessage }}</span>
        <button @click="errorMessage = ''" class="text-red-500 hover:text-red-700 dark:hover:text-red-200">
          <span class="text-xs font-semibold">Dismiss</span>
        </button>
      </div>

      <!-- Folder Summary -->
      <div class="px-5 py-4">
        <p class="text-xs font-semibold font-jakarta text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-3">
          Folder Structure
        </p>

        <div v-if="folders.length === 0" class="text-sm font-geist text-slate-400 dark:text-slate-500">
          No folders created yet. Click "Create Folders" to set up the project structure.
        </div>

        <div v-else class="space-y-2">
          <!-- Project folder -->
          <div v-if="projectFolder" class="flex items-center gap-2.5 text-sm font-geist">
            <FolderOpen class="w-4 h-4 text-amber-500 dark:text-amber-400 flex-shrink-0" />
            <span class="text-slate-700 dark:text-slate-300">Project folder</span>
            <a
              v-if="projectFolder.web_url"
              :href="projectFolder.web_url"
              target="_blank"
              rel="noopener noreferrer"
              class="text-sky-600 dark:text-sky-400 hover:underline flex items-center gap-1"
            >
              <span class="text-xs">Open</span>
              <ExternalLink class="w-3 h-3" />
            </a>
          </div>

          <!-- Module folders -->
          <div v-if="moduleFolders.length > 0" class="flex items-center gap-2.5 text-sm font-geist">
            <FolderOpen class="w-4 h-4 text-blue-500 dark:text-blue-400 flex-shrink-0" />
            <span class="text-slate-700 dark:text-slate-300">
              {{ moduleFolders.length }} module folder{{ moduleFolders.length === 1 ? '' : 's' }}
            </span>
          </div>

          <!-- Step folders -->
          <div v-if="stepFolders.length > 0" class="flex items-center gap-2.5 text-sm font-geist">
            <FolderOpen class="w-4 h-4 text-emerald-500 dark:text-emerald-400 flex-shrink-0" />
            <span class="text-slate-700 dark:text-slate-300">
              {{ stepFolders.length }} step folder{{ stepFolders.length === 1 ? '' : 's' }}
            </span>
          </div>

          <!-- Audit folder -->
          <div v-if="auditFolder" class="flex items-center gap-2.5 text-sm font-geist">
            <FolderOpen class="w-4 h-4 text-violet-500 dark:text-violet-400 flex-shrink-0" />
            <span class="text-slate-700 dark:text-slate-300">Audits folder</span>
            <a
              v-if="auditFolder.web_url"
              :href="auditFolder.web_url"
              target="_blank"
              rel="noopener noreferrer"
              class="text-sky-600 dark:text-sky-400 hover:underline flex items-center gap-1"
            >
              <span class="text-xs">Open</span>
              <ExternalLink class="w-3 h-3" />
            </a>
          </div>
        </div>
      </div>

      <!-- Recent Files -->
      <div class="px-5 py-4">
        <p class="text-xs font-semibold font-jakarta text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-3">
          Recent Files
        </p>

        <div v-if="recentFiles.length === 0" class="text-sm font-geist text-slate-400 dark:text-slate-500">
          No files found in the project folder.
        </div>

        <div v-else class="space-y-1.5">
          <div
            v-for="file in recentFiles"
            :key="file.id"
            class="group flex items-center gap-2.5 py-1.5 px-2 -mx-2 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors"
          >
            <span
              class="inline-flex items-center justify-center px-1.5 py-0.5 rounded text-[10px] font-bold tracking-wide leading-none flex-shrink-0"
              :class="getExtensionLabel(file.name).color"
            >
              {{ getExtensionLabel(file.name).label }}
            </span>
            <div class="flex-1 min-w-0">
              <p class="text-sm font-geist text-slate-800 dark:text-slate-200 truncate">
                {{ file.name }}
              </p>
              <p class="text-[11px] font-geist text-slate-400 dark:text-slate-500">
                {{ formatBytes(file.size) }} &middot; {{ formatDate(file.modified_at) }}
              </p>
            </div>
            <button
              class="opacity-0 group-hover:opacity-100 transition-opacity p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-400 hover:text-sky-600 dark:hover:text-sky-400"
              title="Download"
              @click="handleDownload(file)"
            >
              <Download class="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>

      <!-- Latest Audit -->
      <div v-if="latestAudit" class="px-5 py-4">
        <p class="text-xs font-semibold font-jakarta text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-3">
          Latest Audit
        </p>
        <div class="rounded-xl border border-slate-200 dark:border-slate-700 p-3">
          <div class="flex items-center gap-2 mb-2">
            <span
              class="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold font-geist"
              :class="{
                'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400':
                  latestAudit.status === 'completed',
                'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400':
                  latestAudit.status === 'running',
                'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400':
                  latestAudit.status === 'failed',
              }"
            >
              {{ latestAudit.status }}
            </span>
            <span class="text-xs font-geist text-slate-400 dark:text-slate-500">
              {{ latestAudit.file_count }} files scanned
            </span>
            <span class="text-xs font-geist text-slate-400 dark:text-slate-500 ml-auto">
              {{ formatDate(latestAudit.created_at) }}
            </span>
          </div>
          <p class="text-sm font-geist text-slate-600 dark:text-slate-400">
            {{ latestAudit.summary }}
          </p>
        </div>
      </div>
    </div>

    <!-- Browser Dialog -->
    <SharePointBrowser
      v-model:visible="browserVisible"
      :project-id="projectId"
      select-mode="both"
    />
  </div>
</template>
