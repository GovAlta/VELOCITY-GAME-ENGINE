<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import api, { fetchCsrfToken } from '@/lib/api'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import Dialog from 'primevue/dialog'
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import { Codemirror } from 'vue-codemirror'
import { EditorView } from '@codemirror/view'
import { markdown } from '@codemirror/lang-markdown'
import { json as cmJson } from '@codemirror/lang-json'
import { javascript } from '@codemirror/lang-javascript'
import { html as cmHtml } from '@codemirror/lang-html'
import { css as cmCss } from '@codemirror/lang-css'
import { xml as cmXml } from '@codemirror/lang-xml'
import { yaml as cmYaml } from '@codemirror/lang-yaml'
import { sql as cmSql } from '@codemirror/lang-sql'
import { oneDark } from '@codemirror/theme-one-dark'
import { useTheme } from '@/composables/useTheme'
import {
  FolderOpen,
  FolderPlus,
  FolderInput,
  File,
  FilePlus,
  Upload,
  Download,
  Trash2,
  Search,
  ChevronRight,
  ChevronDown,
  RefreshCw,
  X,
  ExternalLink,
  FileText,
  HardDrive,
  Edit3,
  CornerLeftUp,
  Folder,
  Eye,
} from 'lucide-vue-next'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface SharePointItem {
  id: string
  name: string
  path: string
  webUrl: string
  type: 'file' | 'folder'
  size?: number
  modifiedAt?: string
  modifiedBy?: string
  extension?: string
}

interface FolderNode {
  id: string
  name: string
  path: string
  webUrl: string
  children: FolderNode[]
  expanded: boolean
  depth: number
}

interface FolderResponse {
  id: string
  name: string
  path: string
  web_url: string
  folder_type: string
  parent_id: string | null
}

// ---------------------------------------------------------------------------
// Props & Emits
// ---------------------------------------------------------------------------
const props = withDefaults(
  defineProps<{
    visible: boolean
    projectId: string
    selectMode?: 'file' | 'folder' | 'both'
  }>(),
  { selectMode: 'both' },
)

const emit = defineEmits<{
  'update:visible': [value: boolean]
  select: [
    item: {
      id: string
      name: string
      path: string
      webUrl: string
      type: 'file' | 'folder'
      size?: number
    },
  ]
}>()

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const loading = ref(false)
const loadingFiles = ref(false)
const uploading = ref(false)
const searchQuery = ref('')
const folderTree = ref<FolderNode[]>([])
const flatFolders = ref<FolderResponse[]>([])
const selectedFolderId = ref<string | null>(null)
const selectedFolderPath = ref<string>('')
const files = ref<SharePointItem[]>([])
// Subfolder navigation stack — when browsing into SharePoint subfolders (source of truth)
const browseStack = ref<Array<{ spItemId: string; name: string }>>([])
const fileInputRef = ref<HTMLInputElement | null>(null)
const errorMessage = ref('')
const showCommonFiles = ref(true)
const showAIFiles = ref(false)
const showPipeline = ref(false)
const pipelineActiveOnly = ref(true)
const pipelineJobs = ref<any[]>([])
const pipelineLoading = ref(false)
const expandedJobs = ref<Set<string>>(new Set())
const processingAI = ref(false)

// File preview state
const previewVisible = ref(false)
const previewItemId = ref<string>('')
const previewFilename = ref('')
const previewContent = ref('')
const previewRendered = ref('')
const previewLoading = ref(false)
const previewType = ref<'markdown' | 'text' | 'image' | 'pdf' | 'office-no-shadow'>('text')
const previewImageUrl = ref('')
const previewSearch = ref('')

// Inline edit state (lives inside the preview dialog)
const previewEditing = ref(false)
const previewEditBuffer = ref('')
const previewSaving = ref(false)
const previewSaveError = ref('')

function buildLanguageExtensions(filenameOrPath: string): import('@codemirror/state').Extension[] {
  const ext = (filenameOrPath.split('.').pop() || '').toLowerCase()
  const langExtensions: import('@codemirror/state').Extension[] = []
  switch (ext) {
    case 'md': case 'markdown': langExtensions.push(markdown()); break
    case 'json': langExtensions.push(cmJson()); break
    case 'js': case 'mjs': case 'cjs': langExtensions.push(javascript()); break
    case 'ts': langExtensions.push(javascript({ typescript: true })); break
    case 'tsx': langExtensions.push(javascript({ typescript: true, jsx: true })); break
    case 'jsx': langExtensions.push(javascript({ jsx: true })); break
    case 'html': case 'htm': langExtensions.push(cmHtml()); break
    case 'css': case 'scss': langExtensions.push(cmCss()); break
    case 'xml': case 'svg': langExtensions.push(cmXml()); break
    case 'yaml': case 'yml': langExtensions.push(cmYaml()); break
    case 'sql': langExtensions.push(cmSql()); break
  }
  langExtensions.push(EditorView.lineWrapping)
  return langExtensions
}
const selectedModel = ref('claude:claude-sonnet-4-6')

function getModelParams() {
  const [provider, model] = selectedModel.value.split(':')
  return { provider, model }
}
const aiStatus = ref<{ total: number; upToDate: number; stale: number; missing: number; staleFiles: string[]; missingFiles: string[] } | null>(null)

// Re-fetch files and AI status when toggling AI Ready on
watch(showAIFiles, (val) => {
  if (val && selectedFolderId.value) fetchFiles(selectedFolderId.value)
})

// Fetch pipeline when toggling on or when SSE events fire while visible
watch(showPipeline, (val) => {
  if (val) fetchPipeline()
})

async function fetchPipeline() {
  pipelineLoading.value = true
  try {
    // Show all jobs (no folder filter) — files may be in subfolders with different SP IDs
    const res = await api.get('/sharepoint/ai-queue/jobs')
    pipelineJobs.value = res.data?.data ?? []
  } catch {
    pipelineJobs.value = []
  } finally {
    pipelineLoading.value = false
  }
}

/** Silent refresh — updates data without showing loading spinner (for SSE updates) */
async function fetchPipelineSilent() {
  try {
    const res = await api.get('/sharepoint/ai-queue/jobs')
    pipelineJobs.value = res.data?.data ?? []
  } catch { /* ignore — silent */ }
}

const filteredPipelineJobs = computed(() => {
  if (!pipelineActiveOnly.value) return pipelineJobs.value
  return pipelineJobs.value.filter((j: any) =>
    j.status === 'queued' || j.status === 'processing' || j.status === 'merging'
  )
})

function toggleJobExpand(jobId: string) {
  if (expandedJobs.value.has(jobId)) {
    expandedJobs.value.delete(jobId)
  } else {
    expandedJobs.value.add(jobId)
  }
}

function pipelineStatusColor(status: string) {
  switch (status) {
    case 'queued': return 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-400'
    case 'pending': return 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-400'
    case 'processing': return 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 animate-pulse'
    case 'merging': return 'bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300 animate-pulse'
    case 'completed': return 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300'
    case 'failed': return 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300'
    case 'skipped': return 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300'
    default: return 'bg-slate-100 dark:bg-slate-700 text-slate-500'
  }
}

function subJobLabel(subType: string, seq: number) {
  switch (subType) {
    case 'pdf_page': return `Page ${seq + 1}`
    case 'docx_text': return 'Text extraction'
    case 'docx_image': return `Image ${seq}`
    case 'pptx_text': return 'Slide extraction'
    case 'pptx_image': return `Image ${seq}`
    case 'image': return 'Vision analysis'
    case 'xlsx': return 'Table extraction'
    default: return `${subType} #${seq}`
  }
}

async function retryJob(jobId: string) {
  try {
    await fetchCsrfToken()
    await api.post(`/sharepoint/ai-queue/jobs/${jobId}/retry`)
    fetchPipelineSilent()
  } catch (err: any) {
    errorMessage.value = err?.response?.data?.error?.message || 'Retry failed'
  }
}

function timeSince(dateStr: string | null): string {
  if (!dateStr) return ''
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000)
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  return `${Math.floor(seconds / 3600)}h ago`
}

async function fetchAIStatus(folderId: string) {
  try {
    const res = await api.get(`/sharepoint/folders/${folderId}/ai-status`)
    aiStatus.value = res.data?.data ?? null
  } catch {
    aiStatus.value = null
  }
}

// ---------------------------------------------------------------------------
// Computed
// ---------------------------------------------------------------------------
const dialogVisible = computed({
  get: () => props.visible,
  set: (val: boolean) => emit('update:visible', val),
})

const breadcrumbs = computed<string[]>(() => {
  if (!selectedFolderPath.value) return []
  return selectedFolderPath.value.split('/').filter(Boolean)
})

const AI_PREFIX = '__AI__'

const filteredFiles = computed(() => {
  let result = files.value

  // Apply Common / AI Ready toggles (only to files, not folders)
  if (showCommonFiles.value && !showAIFiles.value) {
    result = result.filter(f => f.type === 'folder' || !f.name.startsWith(AI_PREFIX))
  } else if (!showCommonFiles.value && showAIFiles.value) {
    result = result.filter(f => f.type === 'folder' || f.name.startsWith(AI_PREFIX))
  } else if (!showCommonFiles.value && !showAIFiles.value) {
    result = result.filter(f => f.type === 'folder') // keep folders visible
  }
  // else both on = show all

  if (searchQuery.value.trim()) {
    const q = searchQuery.value.toLowerCase()
    result = result.filter((f) => f.name.toLowerCase().includes(q))
  }

  // Sort: folders first, then files alphabetically
  return [...result].sort((a, b) => {
    if (a.type === 'folder' && b.type !== 'folder') return -1
    if (a.type !== 'folder' && b.type === 'folder') return 1
    return a.name.localeCompare(b.name)
  })
})

async function processFileAI(fileId: string, filename: string, force = false) {
  if (!selectedFolderId.value) return
  processingAI.value = true
  try {
    const { provider, model } = getModelParams()
    // Send both DB folder ID and current SP subfolder ID (if browsed into one)
    const spFolderId = browseStack.value.length > 0
      ? browseStack.value[browseStack.value.length - 1].spItemId
      : undefined
    await api.post(`/sharepoint/files/${fileId}/process`, {
      folderId: selectedFolderId.value,
      spFolderId,
      force,
      provider,
      model,
    })
    // Poll until shadow appears
    await pollForShadows([filename])
  } catch (err: any) {
    errorMessage.value = err?.response?.data?.error?.message || 'AI processing failed'
  } finally {
    processingAI.value = false
  }
}

async function processAllAI(force = false) {
  if (!selectedFolderId.value) return
  processingAI.value = true
  try {
    // Get list of files being processed
    const processable = files.value.filter(f =>
      !f.name.startsWith('__AI__') && /\.(pdf|png|jpg|jpeg|gif|docx|xlsx|xls|pptx|ppt|bmp|webp)$/i.test(f.name)
    ).map(f => f.name)

    const { provider, model } = getModelParams()
    await api.post(`/sharepoint/folders/${selectedFolderId.value}/process-all`, { force, provider, model })
    // Poll until shadows appear for processed files
    await pollForShadows(processable)
  } catch (err: any) {
    errorMessage.value = err?.response?.data?.error?.message || 'AI processing failed'
  } finally {
    processingAI.value = false
  }
}

/**
 * Poll the folder every few seconds until expected shadow files appear, then refresh.
 * Gives up after maxAttempts to avoid infinite polling.
 */
async function pollForShadows(originalFilenames: string[], maxAttempts = 30, intervalMs = 4000) {
  const expectedShadows = new Set(
    originalFilenames.map(n => `__AI__${n.replace(/\.[^.]+$/, '')}.md`)
  )

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise(r => setTimeout(r, intervalMs))

    if (!selectedFolderId.value) break

    // Re-fetch files
    await fetchFiles(selectedFolderId.value)

    // Check if all expected shadows have appeared
    const currentNames = new Set(files.value.map(f => f.name))
    const allFound = [...expectedShadows].every(s => currentNames.has(s))

    if (allFound) {
      // All done — refresh AI status too
      fetchAIStatus(selectedFolderId.value)
      return
    }

    // At least some appeared — partial progress, keep going
  }

  // Final refresh even if not all appeared (timeout)
  if (selectedFolderId.value) {
    await fetchFiles(selectedFolderId.value)
    fetchAIStatus(selectedFolderId.value)
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function getExtensionLabel(name: string): { label: string; color: string } {
  const ext = name.split('.').pop()?.toLowerCase() || ''
  const map: Record<string, { label: string; color: string }> = {
    pdf: { label: 'PDF', color: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300' },
    doc: { label: 'DOC', color: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300' },
    docx: { label: 'DOCX', color: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300' },
    xls: { label: 'XLS', color: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300' },
    xlsx: { label: 'XLSX', color: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300' },
    csv: { label: 'CSV', color: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300' },
    ppt: { label: 'PPT', color: 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300' },
    pptx: { label: 'PPTX', color: 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300' },
    png: { label: 'PNG', color: 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300' },
    jpg: { label: 'JPG', color: 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300' },
    jpeg: { label: 'JPEG', color: 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300' },
    gif: { label: 'GIF', color: 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300' },
    svg: { label: 'SVG', color: 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300' },
    md: { label: 'MD', color: 'bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-300' },
    txt: { label: 'TXT', color: 'bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-300' },
    json: { label: 'JSON', color: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300' },
    zip: { label: 'ZIP', color: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300' },
  }
  return map[ext] || { label: ext.toUpperCase() || 'FILE', color: 'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300' }
}

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

function buildTree(folders: FolderResponse[]): FolderNode[] {
  // Build tree from folder paths (e.g. "Velo Projects/AISH-ADAP/Module 1/requirements")
  // Sort by path length so parents come before children
  const sorted = [...folders].sort((a, b) => a.path.length - b.path.length)
  const pathToNode = new Map<string, FolderNode>()
  const roots: FolderNode[] = []

  for (const f of sorted) {
    const segments = f.path.split('/').filter(Boolean)
    const parentPath = segments.slice(0, -1).join('/')
    const depth = segments.length - 1

    const node: FolderNode = {
      id: f.id,
      name: f.name,
      path: f.path,
      webUrl: f.web_url,
      children: [],
      expanded: depth < 2, // auto-expand first two levels
      depth,
    }

    pathToNode.set(f.path, node)

    // Find parent by path
    const parentNode = parentPath ? pathToNode.get(parentPath) : null
    if (parentNode) {
      parentNode.children.push(node)
    } else {
      roots.push(node)
    }
  }

  return roots
}

function flattenTree(nodes: FolderNode[]): FolderNode[] {
  const result: FolderNode[] = []
  function walk(list: FolderNode[]) {
    for (const node of list) {
      result.push(node)
      if (node.expanded && node.children.length > 0) {
        walk(node.children)
      }
    }
  }
  walk(nodes)
  return result
}

const visibleFolders = computed(() => flattenTree(folderTree.value))

// ---------------------------------------------------------------------------
// Data Fetching
// ---------------------------------------------------------------------------
async function fetchFolders() {
  loading.value = true
  errorMessage.value = ''
  try {
    const res = await api.get(`/sharepoint/projects/${props.projectId}/folders`)
    const raw = res.data?.data ?? res.data ?? []
    // Map API response (snake_case DB columns) to component interface
    const data: FolderResponse[] = raw.map((f: any) => ({
      id: f.pk_sharepoint_folder,
      name: f.sp_folder_path?.split('/').pop() || f.sp_folder_path || '',
      path: f.sp_folder_path || '',
      web_url: f.sp_web_url || '',
      folder_type: f.folder_type || 'project',
      parent_id: null,
    }))
    flatFolders.value = data
    folderTree.value = buildTree(data)

    // Auto-select first project-level folder
    const projectFolder = data.find((f: FolderResponse) => f.folder_type === 'project') || data[0]
    if (projectFolder && !selectedFolderId.value) {
      await selectFolder(projectFolder.id, projectFolder.path)
    }
  } catch (err: any) {
    errorMessage.value = err?.response?.data?.message || 'Failed to load folders'
  } finally {
    loading.value = false
  }
}

async function fetchFiles(folderId: string) {
  // Only show spinner on first load (empty list), not on refreshes
  const isFirstLoad = files.value.length === 0
  if (isFirstLoad) loadingFiles.value = true

  try {
    // If browsing into a subfolder, use SharePoint item ID directly (source of truth)
    // Otherwise use DB folder ID for the root-level tracked folders
    const isSubfolder = browseStack.value.length > 0
    const url = isSubfolder
      ? `/sharepoint/items/${browseStack.value[browseStack.value.length - 1].spItemId}/children`
      : `/sharepoint/folders/${folderId}/files`

    const res = await api.get(url)
    const data = res.data?.data ?? res.data ?? []
    const incoming: SharePointItem[] = data
      .map((f: any) => ({
        id: f.id,
        name: f.name,
        path: f.parentReference?.path || '',
        webUrl: f.webUrl || '',
        type: f.folder ? 'folder' as const : 'file' as const,
        size: f.size || 0,
        modifiedAt: f.lastModifiedDateTime || '',
        modifiedBy: f.lastModifiedBy?.user?.displayName || '',
        extension: f.folder ? '' : (f.name?.split('.').pop()?.toLowerCase() || ''),
      }))

    // Merge: update existing, add new, remove deleted — avoids full re-render blink
    const existingMap = new Map(files.value.map(f => [f.id, f]))
    const incomingIds = new Set(incoming.map(f => f.id))

    // Update existing items in-place and add new ones
    for (const item of incoming) {
      const existing = existingMap.get(item.id)
      if (existing) {
        Object.assign(existing, item)
      } else {
        files.value.push(item)
      }
    }

    // Remove files that no longer exist on the server
    files.value = files.value.filter(f => incomingIds.has(f.id))
  } catch (err: any) {
    if (isFirstLoad) {
      errorMessage.value = err?.response?.data?.message || 'Failed to load files'
      files.value = []
    }
  } finally {
    loadingFiles.value = false
  }
}

/** Navigate into a SharePoint subfolder */
function browseIntoSubfolder(item: SharePointItem) {
  browseStack.value.push({ spItemId: item.id, name: item.name })
  files.value = []
  if (selectedFolderId.value) fetchFiles(selectedFolderId.value)
}

/** Navigate up one level (or back to root) */
function browseUp() {
  browseStack.value.pop()
  files.value = []
  if (selectedFolderId.value) fetchFiles(selectedFolderId.value)
}

async function selectFolder(folderId: string, path: string) {
  selectedFolderId.value = folderId
  selectedFolderPath.value = path
  browseStack.value = [] // reset subfolder navigation when switching tracked folders
  files.value = []
  await fetchFiles(folderId)
  // Check AI staleness in background (non-blocking)
  fetchAIStatus(folderId)
}

function toggleExpand(node: FolderNode) {
  node.expanded = !node.expanded
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
function handleDownload(item: SharePointItem) {
  const baseUrl = api.defaults.baseURL || '/api/v1'
  window.open(`${baseUrl}/sharepoint/files/${item.id}/download`, '_blank')
}

// ---------------------------------------------------------------------------
// File Preview
// ---------------------------------------------------------------------------

const PREVIEWABLE_TEXT = new Set(['md', 'txt', 'json', 'xml', 'html', 'css', 'js', 'ts', 'csv', 'yaml', 'yml', 'log'])
const PREVIEWABLE_IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg'])
const PREVIEWABLE_PDF = new Set(['pdf'])
const PREVIEWABLE_OFFICE = new Set(['docx', 'pptx', 'xlsx', 'xls'])

function canPreview(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase() || ''
  return PREVIEWABLE_TEXT.has(ext) || PREVIEWABLE_IMAGE.has(ext) ||
    PREVIEWABLE_PDF.has(ext) || PREVIEWABLE_OFFICE.has(ext)
}

const previewPdfUrl = ref('')
const previewShadowBanner = ref('')

async function openPreview(item: SharePointItem) {
  const ext = item.name.split('.').pop()?.toLowerCase() || ''
  previewItemId.value = item.id
  previewFilename.value = item.name
  previewSearch.value = ''
  previewContent.value = ''
  previewRendered.value = ''
  previewImageUrl.value = ''
  previewPdfUrl.value = ''
  previewShadowBanner.value = ''
  previewEditing.value = false
  previewEditBuffer.value = ''
  previewSaveError.value = ''
  previewVisible.value = true
  previewLoading.value = true

  const baseUrl = api.defaults.baseURL || '/api/v1'

  try {
    if (PREVIEWABLE_IMAGE.has(ext)) {
      previewType.value = 'image'
      previewImageUrl.value = `${baseUrl}/sharepoint/files/${item.id}/download?inline=true`

    } else if (PREVIEWABLE_PDF.has(ext)) {
      previewType.value = 'pdf'
      previewPdfUrl.value = `${baseUrl}/sharepoint/files/${item.id}/download?inline=true`

    } else if (PREVIEWABLE_OFFICE.has(ext)) {
      // For Office files, try to find and show the __AI__ shadow markdown
      const shadowName = `__AI__${item.name.replace(/\.[^.]+$/, '')}.md`
      const shadowFile = files.value.find(f => f.name === shadowName)

      if (shadowFile) {
        previewType.value = 'markdown'
        previewShadowBanner.value = `Showing AI-processed version of ${item.name}`
        const res = await api.get(`/sharepoint/files/${shadowFile.id}/download`, { responseType: 'arraybuffer' })
        const text = new TextDecoder('utf-8').decode(res.data)
        previewContent.value = text
        renderMarkdown(text)
      } else {
        // No shadow file — show helpful message
        previewType.value = 'office-no-shadow'
        previewContent.value = item.name
      }

    } else {
      // Text files
      const res = await api.get(`/sharepoint/files/${item.id}/download`, { responseType: 'arraybuffer' })
      const text = new TextDecoder('utf-8').decode(res.data)
      previewContent.value = text

      if (ext === 'md' || item.name.startsWith('__AI__')) {
        previewType.value = 'markdown'
        renderMarkdown(text)
      } else {
        previewType.value = 'text'
        previewRendered.value = ''
      }
    }
  } catch (err: any) {
    previewContent.value = `Error loading file: ${err?.message || 'unknown error'}`
    previewType.value = 'text'
  } finally {
    previewLoading.value = false
  }
}

function renderMarkdown(raw: string) {
  // Strip the source-ctag comment for cleaner display
  const cleaned = raw.replace(/<!--\s*source-ctag:.*?-->\n?/g, '')

  const html = marked.parse(cleaned, { async: false, gfm: true, breaks: true }) as string

  // Sanitize with a permissive allowlist for rendered markdown
  previewRendered.value = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr',
      'strong', 'b', 'em', 'i', 'u', 's', 'del', 'mark',
      'ul', 'ol', 'li', 'dl', 'dt', 'dd',
      'table', 'thead', 'tbody', 'tr', 'th', 'td',
      'blockquote', 'pre', 'code', 'kbd',
      'a', 'img', 'span', 'div', 'sup', 'sub',
      'details', 'summary',
    ],
    ALLOWED_ATTR: ['href', 'target', 'rel', 'class', 'id', 'src', 'alt', 'title', 'width', 'height', 'colspan', 'rowspan'],
  })
}

const previewSearchHighlighted = computed(() => {
  if (!previewSearch.value.trim()) return previewRendered.value
  const q = previewSearch.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return previewRendered.value.replace(
    new RegExp(`(${q})`, 'gi'),
    '<mark class="bg-yellow-200 dark:bg-yellow-700/50 px-0.5 rounded">$1</mark>'
  )
})

// Drag and drop
const isDragging = ref(false)
const uploadQueue = ref<{ name: string; progress: 'pending' | 'uploading' | 'done' | 'error'; size?: string }[]>([])
const uploadStats = computed(() => {
  const q = uploadQueue.value
  if (q.length === 0) return null
  return {
    total: q.length,
    done: q.filter(f => f.progress === 'done').length,
    error: q.filter(f => f.progress === 'error').length,
    pending: q.filter(f => f.progress === 'pending').length,
    uploading: q.filter(f => f.progress === 'uploading').length,
  }
})
let dragCounter = 0

function onDragEnter(e: DragEvent) {
  e.preventDefault()
  dragCounter++
  if (e.dataTransfer?.types.includes('Files')) {
    isDragging.value = true
  }
}

function onDragOver(e: DragEvent) {
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
}

function onDragLeave(e: DragEvent) {
  e.preventDefault()
  dragCounter--
  if (dragCounter <= 0) {
    isDragging.value = false
    dragCounter = 0
  }
}

async function onDrop(e: DragEvent) {
  e.preventDefault()
  isDragging.value = false
  dragCounter = 0

  if (!selectedFolderId.value) {
    errorMessage.value = 'Select a folder first before dropping files'
    return
  }

  const files = e.dataTransfer?.files
  if (!files || files.length === 0) return

  await uploadFiles(Array.from(files))
}

async function uploadFiles(files: File[]) {
  if (!selectedFolderId.value) return

  uploading.value = true
  errorMessage.value = ''
  uploadQueue.value = files.map(f => ({ name: f.name, progress: 'pending' }))

  // Proactively fetch CSRF token before starting uploads to avoid 403 races
  await fetchCsrfToken()

  try {
    for (let i = 0; i < files.length; i++) {
      uploadQueue.value[i].progress = 'uploading'
      try {
        const formData = new FormData()
        formData.append('file', files[i])
        // Upload to subfolder (SharePoint item ID) or root folder (DB UUID)
        const uploadUrl = browseStack.value.length > 0
          ? `/sharepoint/items/${browseStack.value[browseStack.value.length - 1].spItemId}/files`
          : `/sharepoint/folders/${selectedFolderId.value}/files`
        await api.post(uploadUrl, formData, {
          headers: { 'Content-Type': 'multipart/form-data' },
        })
        uploadQueue.value[i].progress = 'done'
      } catch {
        uploadQueue.value[i].progress = 'error'
      }
    }
    await fetchFiles(selectedFolderId.value)
    // AI processing is handled automatically by the server background queue
  } catch (err: any) {
    errorMessage.value = err?.response?.data?.message || 'Upload failed'
  } finally {
    uploading.value = false
    // Clear queue after a delay so user can see results
    setTimeout(() => { uploadQueue.value = [] }, 3000)
  }
}

const zipInputRef = ref<HTMLInputElement | null>(null)
const importingZip = ref(false)

async function handleZipImport(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file || !selectedFolderId.value) return

  importingZip.value = true
  errorMessage.value = ''
  try {
    await fetchCsrfToken()
    const formData = new FormData()
    formData.append('file', file)
    // When inside a subfolder, import into that subfolder (SharePoint item ID)
    const importUrl = browseStack.value.length > 0
      ? `/sharepoint/items/${browseStack.value[browseStack.value.length - 1].spItemId}/import-zip`
      : `/sharepoint/folders/${selectedFolderId.value}/import-zip`
    const res = await api.post(importUrl, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
    const data = res.data?.data
    if (data) {
      errorMessage.value = '' // clear any previous errors
      // Refresh folders and files
      await fetchFolders()
      if (selectedFolderId.value) await fetchFiles(selectedFolderId.value)
    }
  } catch (err: any) {
    errorMessage.value = err?.response?.data?.error?.message || 'ZIP import failed'
  } finally {
    importingZip.value = false
    input.value = ''
  }
}

function handleZipExport() {
  if (!selectedFolderId.value) return
  const baseUrl = api.defaults.baseURL || '/api/v1'
  window.open(`${baseUrl}/sharepoint/folders/${selectedFolderId.value}/export-zip`, '_blank')
}

function triggerUpload() {
  fileInputRef.value?.click()
}

async function handleFileUpload(event: Event) {
  const input = event.target as HTMLInputElement
  const fileList = input.files
  if (!fileList || fileList.length === 0 || !selectedFolderId.value) return
  await uploadFiles(Array.from(fileList))
  input.value = ''
}

function handleSelectItem(item: SharePointItem) {
  if (props.selectMode === 'file' && item.type !== 'file') return
  if (props.selectMode === 'folder' && item.type !== 'folder') return
  emit('select', {
    id: item.id,
    name: item.name,
    path: item.path,
    webUrl: item.webUrl,
    type: item.type,
    size: item.size,
  })
}

function handleSelectFolder(node: FolderNode) {
  if (props.selectMode === 'folder' || props.selectMode === 'both') {
    emit('select', {
      id: node.id,
      name: node.name,
      path: node.path,
      webUrl: node.webUrl,
      type: 'folder',
    })
  }
}

// New document (blank file) dialog
const newDocDialogVisible = ref(false)
const newDocFilename = ref('')
const newDocContent = ref('')
const newDocSaving = ref(false)
const newDocError = ref('')

const { currentTheme } = useTheme()
const isDarkTheme = computed(() => currentTheme.value === 'dark')

// CodeMirror language extension chosen from the filename. Returns an array so it
// can be spread straight into :extensions without conditional null entries.
const newDocExtensions = computed(() => {
  const exts = buildLanguageExtensions(newDocFilename.value)
  if (isDarkTheme.value) exts.push(oneDark)
  return exts
})

// Same logic for the inline preview-editor; uses the file currently open.
const previewEditExtensions = computed(() => {
  const exts = buildLanguageExtensions(previewFilename.value)
  if (isDarkTheme.value) exts.push(oneDark)
  return exts
})

// Editing is offered only for text-like files we already render inline.
// AI shadow renderings of Office files are not editable — they are regenerated
// from the source on the next AI run, so any hand edit would be lost.
const previewIsEditable = computed(
  () => (previewType.value === 'markdown' || previewType.value === 'text') && !previewShadowBanner.value
)

function enterPreviewEdit() {
  previewEditBuffer.value = previewContent.value
  previewSaveError.value = ''
  previewEditing.value = true
}

function cancelPreviewEdit() {
  if (previewSaving.value) return
  previewEditing.value = false
  previewEditBuffer.value = ''
  previewSaveError.value = ''
}

async function savePreviewEdit() {
  if (!previewItemId.value) return
  previewSaving.value = true
  previewSaveError.value = ''
  try {
    await fetchCsrfToken()
    await api.put(`/sharepoint/files/${previewItemId.value}/content`, {
      content: previewEditBuffer.value,
    })
    previewContent.value = previewEditBuffer.value
    if (previewType.value === 'markdown') {
      renderMarkdown(previewEditBuffer.value)
    }
    previewEditing.value = false
    if (selectedFolderId.value) await fetchFiles(selectedFolderId.value)
  } catch (err: any) {
    previewSaveError.value =
      err?.response?.data?.error?.message ||
      err?.response?.data?.message ||
      'Save failed'
  } finally {
    previewSaving.value = false
  }
}

// Focus the editor when it mounts so the user can type immediately.
function onNewDocReady(payload: { view: EditorView }) {
  payload.view.focus()
}

function openNewDoc() {
  if (!selectedFolderId.value) return
  newDocFilename.value = ''
  newDocContent.value = ''
  newDocError.value = ''
  newDocDialogVisible.value = true
}

async function submitNewDoc() {
  const filename = newDocFilename.value.trim()
  if (!filename || !selectedFolderId.value) return
  newDocSaving.value = true
  newDocError.value = ''
  try {
    await fetchCsrfToken()
    // If the user has navigated into a subfolder, target it by SharePoint item ID;
    // otherwise target the root folder by its local DB UUID — exactly like uploadFiles().
    const url = browseStack.value.length > 0
      ? `/sharepoint/items/${browseStack.value[browseStack.value.length - 1].spItemId}/blank-file`
      : `/sharepoint/folders/${selectedFolderId.value}/blank-file`
    await api.post(url, { filename, content: newDocContent.value })
    newDocDialogVisible.value = false
    if (selectedFolderId.value) await fetchFiles(selectedFolderId.value)
  } catch (err: any) {
    newDocError.value =
      err?.response?.data?.error?.message ||
      err?.response?.data?.message ||
      'Failed to create document'
  } finally {
    newDocSaving.value = false
  }
}

// Rename / Move / Delete
const renameDialogVisible = ref(false)
const renameTarget = ref<{ id: string; name: string; type: 'file' | 'folder' } | null>(null)
const renameNewName = ref('')
const renaming = ref(false)

const moveDialogVisible = ref(false)
const moveTarget = ref<{ id: string; name: string } | null>(null)
const moveTargetFolderId = ref('')
const moving = ref(false)

function openRename(id: string, name: string, type: 'file' | 'folder' = 'file') {
  renameTarget.value = { id, name, type }
  renameNewName.value = name
  renameDialogVisible.value = true
}

async function submitRename() {
  if (!renameTarget.value || !renameNewName.value.trim()) return
  renaming.value = true
  try {
    await api.patch(`/sharepoint/files/${renameTarget.value.id}/rename`, { name: renameNewName.value.trim() })
    renameDialogVisible.value = false
    if (selectedFolderId.value) await fetchFiles(selectedFolderId.value)
  } catch (err: any) {
    errorMessage.value = err?.response?.data?.error?.message || 'Rename failed'
  } finally {
    renaming.value = false
  }
}

function openMove(id: string, name: string) {
  moveTarget.value = { id, name }
  moveTargetFolderId.value = ''
  moveDialogVisible.value = true
}

async function submitMove() {
  if (!moveTarget.value || !moveTargetFolderId.value) return
  // Get the SP folder ID from the local folder record
  const folder = flatFolders.value.find(f => f.id === moveTargetFolderId.value)
  if (!folder) return
  moving.value = true
  try {
    // We need the actual SharePoint driveItem ID, not our DB ID. Fetch from the folder's file listing context.
    // The controller looks up sp_folder_id from pk_sharepoint_folder for delete, but for move we need the raw SP ID.
    // We'll pass the folder DB ID and let the controller resolve it — but wait, the move endpoint takes raw SP IDs.
    // For simplicity, we use the sp_folder_id that we can fetch. Let's call the metadata endpoint.
    // Actually, the easiest path: use the folders API to get the sp_folder_id
    const foldersRes = await api.get(`/sharepoint/projects/${props.projectId}/folders`)
    const allFolders = foldersRes.data?.data ?? []
    const target = allFolders.find((f: any) => f.pk_sharepoint_folder === moveTargetFolderId.value)
    if (!target) { errorMessage.value = 'Target folder not found'; return }

    await api.patch(`/sharepoint/files/${moveTarget.value.id}/move`, { targetFolderId: target.sp_folder_id })
    moveDialogVisible.value = false
    if (selectedFolderId.value) await fetchFiles(selectedFolderId.value)
  } catch (err: any) {
    errorMessage.value = err?.response?.data?.error?.message || 'Move failed'
  } finally {
    moving.value = false
  }
}

async function handleDeleteFile(itemId: string, name: string) {
  if (!confirm(`Delete "${name}"? This cannot be undone.`)) return
  try {
    await api.delete(`/sharepoint/files/${itemId}`)
    if (selectedFolderId.value) await fetchFiles(selectedFolderId.value)
  } catch (err: any) {
    errorMessage.value = err?.response?.data?.error?.message || 'Delete failed'
  }
}

async function handleDeleteFolder(folderId: string, name: string) {
  if (!confirm(`Delete folder "${name}" and all its contents? This cannot be undone.`)) return
  try {
    await api.delete(`/sharepoint/folders/${folderId}/folder`)
    await fetchFolders()
  } catch (err: any) {
    errorMessage.value = err?.response?.data?.error?.message || 'Delete failed'
  }
}

const newSubfolderName = ref('')
const creatingSubfolder = ref(false)
const subfolderTargetId = ref<string | null>(null)
const subfolderDialogVisible = ref(false)
const subfolderNewName = ref('')

function promptNewSubfolder(folderId: string) {
  subfolderTargetId.value = folderId
  subfolderNewName.value = ''
  subfolderDialogVisible.value = true
}

async function submitNewSubfolder() {
  const targetId = subfolderTargetId.value || selectedFolderId.value
  if (!targetId || !subfolderNewName.value.trim()) return
  creatingSubfolder.value = true
  try {
    await api.post(`/sharepoint/folders/${targetId}/subfolder`, { name: subfolderNewName.value.trim() })
    subfolderDialogVisible.value = false
    subfolderNewName.value = ''
    if (selectedFolderId.value) await fetchFiles(selectedFolderId.value)
    await fetchFolders()
  } catch (err: any) {
    errorMessage.value = err?.response?.data?.error?.message || 'Create folder failed'
  } finally {
    creatingSubfolder.value = false
  }
}

async function createNewSubfolder() {
  if (!selectedFolderId.value || !newSubfolderName.value.trim()) return
  creatingSubfolder.value = true
  try {
    await fetchCsrfToken()
    // When inside a subfolder, use SharePoint item ID directly
    const url = browseStack.value.length > 0
      ? `/sharepoint/items/${browseStack.value[browseStack.value.length - 1].spItemId}/subfolder`
      : `/sharepoint/folders/${selectedFolderId.value}/subfolder`
    await api.post(url, { name: newSubfolderName.value.trim() })
    newSubfolderName.value = ''
    if (selectedFolderId.value) await fetchFiles(selectedFolderId.value)
    // Only refresh DB folder tree when at root level
    if (browseStack.value.length === 0) await fetchFolders()
  } catch (err: any) {
    errorMessage.value = err?.response?.data?.error?.message || 'Create folder failed'
  } finally {
    creatingSubfolder.value = false
  }
}

function navigateToBreadcrumb(idx: number) {
  // Build the target path from breadcrumb segments up to idx
  const segments = selectedFolderPath.value.split('/').filter(Boolean)
  const targetPath = segments.slice(0, idx + 1).join('/')
  // Find the folder matching this path
  const folder = flatFolders.value.find(f => f.path === targetPath)
  if (folder) {
    selectFolder(folder.id, folder.path)
  }
}

function closeDialog() {
  dialogVisible.value = false
}

// ---------------------------------------------------------------------------
// Watchers & Lifecycle
// ---------------------------------------------------------------------------
// SSE: auto-refresh when SharePoint events fire (uses the velocity SSE stream)
let browserSSE: EventSource | null = null
const SP_EVENTS = [
  'sharepoint_file_uploaded', 'sharepoint_file_deleted', 'sharepoint_item_renamed',
  'sharepoint_item_moved', 'sharepoint_folder_deleted', 'sharepoint_subfolder_created',
  'sharepoint_folders_created', 'sharepoint_import', 'sharepoint_ai_processing',
  'sharepoint_ai_shadow_created', 'sharepoint_ai_job_started', 'sharepoint_ai_sub_progress',
  'sharepoint_ai_job_failed', 'sharepoint_ai_skipped',
]

function connectBrowserSSE() {
  const baseUrl = import.meta.env.VITE_API_BASE_URL || '/api'
  browserSSE = new EventSource(`${baseUrl}/velocity/stream`)
  for (const evt of SP_EVENTS) {
    browserSSE.addEventListener(evt, () => {
      // Silently refresh current folder
      if (selectedFolderId.value) fetchFiles(selectedFolderId.value)
      // Silently refresh pipeline if visible (no loading spinner)
      if (showPipeline.value) fetchPipelineSilent()
    })
  }
  browserSSE.onerror = () => {
    browserSSE?.close()
    browserSSE = null
    // Reconnect after 10s if dialog is still open
    if (props.visible) setTimeout(connectBrowserSSE, 10000)
  }
}

watch(
  () => props.visible,
  (val) => {
    if (val) {
      selectedFolderId.value = null
      selectedFolderPath.value = ''
      files.value = []
      searchQuery.value = ''
      errorMessage.value = ''
      fetchFolders()
      connectBrowserSSE()
    } else {
      browserSSE?.close()
      browserSSE = null
    }
  },
)

onUnmounted(() => {
  browserSSE?.close()
  browserSSE = null
})
</script>

<template>
  <Dialog
    v-model:visible="dialogVisible"
    modal
    :closable="false"
    :dismissable-mask="true"
    :draggable="false"
    :style="{ width: 'calc(100vw - 50px)', height: 'calc(100vh - 50px)', margin: '25px', maxHeight: 'calc(100vh - 50px)' }"
    :pt="{
      root: { class: '!rounded-2xl overflow-hidden' },
      header: { class: '!hidden !p-0 !m-0 !h-0 !min-h-0' },
      content: { class: '!p-0 flex flex-col', style: 'height: 100%; overflow: hidden;' },
    }"
  >
    <!-- Custom Header -->
    <div
      class="flex items-center justify-between px-6 py-4 border-b border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
    >
      <div class="flex items-center gap-3">
        <div
          class="flex items-center justify-center w-10 h-10 rounded-xl bg-sky-50 dark:bg-sky-900/30"
        >
          <HardDrive class="w-5 h-5 text-sky-600 dark:text-sky-400" />
        </div>
        <div>
          <h2 class="text-lg font-semibold font-jakarta text-slate-900 dark:text-white">
            SharePoint Browser
          </h2>
          <p class="text-xs font-geist text-slate-500 dark:text-slate-400">
            Browse project files and folders
          </p>
        </div>
      </div>
      <!-- AI Model selector -->
      <div class="flex items-center gap-2 ml-auto mr-4">
        <label class="text-[10px] font-geist text-slate-400 dark:text-slate-500 whitespace-nowrap">AI Model:</label>
        <select
          v-model="selectedModel"
          class="text-xs font-geist px-2 py-1 rounded-lg border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300"
        >
          <option value="claude:claude-sonnet-4-6">Claude Sonnet 4.6</option>
          <option value="claude:claude-opus-4-6">Claude Opus 4.6</option>
          <option value="gemini:gemini-3.0-flash">Gemini 3.0 Flash</option>
          <option value="gemini:gemini-3.1-pro">Gemini 3.1 Pro</option>
        </select>
      </div>
      <div class="flex items-center gap-2">
        <Button
          severity="secondary"
          text
          rounded
          @click="fetchFolders"
          :disabled="loading"
          v-tooltip.bottom="'Refresh'"
        >
          <template #icon>
            <RefreshCw class="w-4 h-4" :class="{ 'animate-spin': loading }" />
          </template>
        </Button>
        <Button severity="secondary" text rounded @click="closeDialog" v-tooltip.bottom="'Close'">
          <template #icon>
            <X class="w-4 h-4" />
          </template>
        </Button>
      </div>
    </div>

    <!-- Error Banner -->
    <div
      v-if="errorMessage"
      class="mx-6 mt-4 px-4 py-2 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-sm font-geist text-red-700 dark:text-red-300 flex items-center justify-between"
    >
      <span>{{ errorMessage }}</span>
      <button
        @click="errorMessage = ''"
        class="text-red-500 hover:text-red-700 dark:hover:text-red-200"
      >
        <X class="w-3.5 h-3.5" />
      </button>
    </div>

    <!-- Body -->
    <div class="flex flex-1 min-h-0 bg-white dark:bg-slate-900">
      <!-- Left Panel: Folder Tree -->
      <div
        class="w-1/3 border-r border-slate-200 dark:border-slate-700 flex flex-col overflow-hidden"
      >
        <div class="px-4 py-3 border-b border-slate-100 dark:border-slate-800">
          <p class="text-xs font-semibold font-jakarta text-slate-500 dark:text-slate-400 uppercase tracking-wider">
            Folders
          </p>
        </div>

        <!-- Loading State -->
        <div v-if="loading" class="flex-1 flex items-center justify-center">
          <RefreshCw class="w-5 h-5 text-slate-400 animate-spin" />
        </div>

        <!-- Folder Tree -->
        <div v-else class="flex-1 overflow-y-auto">
          <div v-if="visibleFolders.length === 0" class="px-4 py-8 text-center">
            <FolderOpen class="w-8 h-8 text-slate-300 dark:text-slate-600 mx-auto mb-2" />
            <p class="text-sm font-geist text-slate-400 dark:text-slate-500">No folders found</p>
          </div>

          <button
            v-for="node in visibleFolders"
            :key="node.id"
            class="group w-full flex items-center gap-2 px-4 py-2 text-left text-sm font-geist transition-colors hover:bg-slate-50 dark:hover:bg-slate-800"
            :class="{
              'bg-sky-50 dark:bg-sky-900/20 text-sky-700 dark:text-sky-300 border-r-2 border-sky-500':
                selectedFolderId === node.id,
              'text-slate-700 dark:text-slate-300': selectedFolderId !== node.id,
            }"
            :style="{ paddingLeft: `${1 + node.depth * 1.25}rem` }"
            @click="selectFolder(node.id, node.path)"
          >
            <button
              v-if="node.children.length > 0"
              class="flex-shrink-0 p-0.5 rounded hover:bg-slate-200 dark:hover:bg-slate-700"
              @click.stop="toggleExpand(node)"
            >
              <ChevronDown v-if="node.expanded" class="w-3.5 h-3.5" />
              <ChevronRight v-else class="w-3.5 h-3.5" />
            </button>
            <span v-else class="w-4.5 flex-shrink-0" />

            <FolderOpen
              class="w-4 h-4 flex-shrink-0"
              :class="
                selectedFolderId === node.id
                  ? 'text-sky-500 dark:text-sky-400'
                  : 'text-amber-500 dark:text-amber-400'
              "
            />
            <span class="truncate">{{ node.name }}</span>

            <!-- Folder actions (shown on hover) -->
            <span class="ml-auto flex items-center gap-0.5 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
              <button
                class="p-1 rounded hover:bg-emerald-100 dark:hover:bg-emerald-900/30 text-slate-400 hover:text-emerald-600 dark:hover:text-emerald-400"
                @click.stop="promptNewSubfolder(node.id)"
                title="Create subfolder"
              >
                <FolderPlus class="w-3.5 h-3.5" />
              </button>
              <button
                class="p-1 rounded hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-400 hover:text-amber-600 dark:hover:text-amber-400"
                @click.stop="openRename(node.id, node.name, 'folder')"
                title="Rename folder"
              >
                <Edit3 class="w-3 h-3" />
              </button>
              <button
                class="p-1 rounded hover:bg-red-50 dark:hover:bg-red-900/20 text-slate-400 hover:text-red-600 dark:hover:text-red-400"
                @click.stop="handleDeleteFolder(node.id, node.name)"
                title="Delete folder"
              >
                <Trash2 class="w-3 h-3" />
              </button>
            </span>
          </button>
        </div>
      </div>

      <!-- Right Panel: File List (drop zone) -->
      <div
        class="flex-1 flex flex-col overflow-hidden relative"
        @dragenter="onDragEnter"
        @dragover="onDragOver"
        @dragleave="onDragLeave"
        @drop="onDrop"
      >
        <!-- Drag overlay -->
        <Transition
          enter-active-class="transition ease-out duration-150"
          enter-from-class="opacity-0"
          enter-to-class="opacity-100"
          leave-active-class="transition ease-in duration-100"
          leave-from-class="opacity-100"
          leave-to-class="opacity-0"
        >
          <div
            v-if="isDragging"
            class="absolute inset-0 z-30 flex flex-col items-center justify-center bg-indigo-50/90 dark:bg-indigo-950/90 border-2 border-dashed border-indigo-400 dark:border-indigo-500 rounded-lg m-2"
          >
            <Upload class="w-10 h-10 text-indigo-500 dark:text-indigo-400 mb-3" />
            <p class="text-sm font-jakarta font-bold text-indigo-700 dark:text-indigo-300">Drop files to upload</p>
            <p v-if="selectedFolderId" class="text-xs font-geist text-indigo-500 dark:text-indigo-400 mt-1">
              to {{ selectedFolderPath.split('/').pop() || 'selected folder' }}
            </p>
            <p v-else class="text-xs font-geist text-red-500 mt-1">
              Select a folder first
            </p>
          </div>
        </Transition>
        <!-- File Panel Header -->
        <div
          class="px-4 py-3 border-b border-slate-100 dark:border-slate-800 flex items-center gap-3"
        >
          <!-- Breadcrumbs (clickable to navigate up) -->
          <div class="flex items-center gap-1 flex-1 min-w-0 text-sm font-geist overflow-x-auto">
            <span class="text-slate-400 dark:text-slate-500 flex-shrink-0">
              <HardDrive class="w-3.5 h-3.5 inline -mt-0.5" />
            </span>
            <template v-for="(crumb, idx) in breadcrumbs" :key="idx">
              <ChevronRight class="w-3 h-3 text-slate-300 dark:text-slate-600 flex-shrink-0" />
              <button
                v-if="idx < breadcrumbs.length - 1"
                class="truncate text-slate-500 dark:text-slate-400 hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors cursor-pointer"
                @click="navigateToBreadcrumb(idx)"
              >
                {{ crumb }}
              </button>
              <span
                v-else
                class="truncate text-slate-800 dark:text-white font-medium"
              >
                {{ crumb }}
              </span>
            </template>
            <span
              v-if="breadcrumbs.length === 0"
              class="text-slate-400 dark:text-slate-500 italic"
            >
              Select a folder
            </span>
          </div>

          <!-- Search -->
          <div class="relative w-48 flex-shrink-0">
            <Search
              class="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 pointer-events-none"
            />
            <InputText
              v-model="searchQuery"
              placeholder="Filter files..."
              class="w-full !pl-8 !py-1.5 !text-xs"
            />
          </div>

          <!-- New Document -->
          <button
            :disabled="!selectedFolderId"
            @click="openNewDoc"
            class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-indigo-300 dark:border-indigo-600 text-indigo-600 dark:text-indigo-400 text-xs font-geist font-medium hover:bg-indigo-50 dark:hover:bg-indigo-900/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title="Create a new file in the selected folder"
          >
            <FilePlus class="w-3.5 h-3.5" />
            New Document
          </button>
          <!-- Upload -->
          <button
            :disabled="!selectedFolderId || uploading"
            @click="triggerUpload"
            class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-xs font-geist font-medium hover:bg-indigo-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Upload class="w-3.5 h-3.5" />
            {{ uploading ? 'Uploading...' : 'Upload' }}
          </button>
          <!-- Import ZIP -->
          <button
            :disabled="!selectedFolderId || importingZip"
            @click="zipInputRef?.click()"
            class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-indigo-300 dark:border-indigo-600 text-indigo-600 dark:text-indigo-400 text-xs font-geist font-medium hover:bg-indigo-50 dark:hover:bg-indigo-900/20 transition-colors disabled:opacity-50"
          >
            {{ importingZip ? 'Importing...' : 'Import ZIP' }}
          </button>
          <input
            ref="zipInputRef"
            type="file"
            accept=".zip"
            class="hidden"
            @change="handleZipImport"
          />
          <!-- Export ZIP -->
          <button
            :disabled="!selectedFolderId"
            @click="handleZipExport"
            class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-600 text-slate-600 dark:text-slate-400 text-xs font-geist font-medium hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors disabled:opacity-50"
          >
            <Download class="w-3.5 h-3.5" />
            Export ZIP
          </button>
          <input
            ref="fileInputRef"
            type="file"
            multiple
            class="hidden"
            @change="handleFileUpload"
          />
        </div>

        <!-- File type toggles + AI process -->
        <div v-if="selectedFolderId" class="px-4 py-2 border-b border-slate-100 dark:border-slate-800 flex items-center gap-3">
          <label class="flex items-center gap-1.5 text-[11px] font-geist cursor-pointer"
            :class="showCommonFiles ? 'text-slate-700 dark:text-slate-300' : 'text-slate-400 dark:text-slate-600'">
            <input type="checkbox" v-model="showCommonFiles" class="rounded accent-indigo-600 w-3.5 h-3.5" />
            Common
          </label>
          <label class="flex items-center gap-1.5 text-[11px] font-geist cursor-pointer"
            :class="showAIFiles ? 'text-violet-700 dark:text-violet-300' : 'text-slate-400 dark:text-slate-600'">
            <input type="checkbox" v-model="showAIFiles" class="rounded accent-violet-600 w-3.5 h-3.5" />
            AI Ready
          </label>
          <button
            @click="showPipeline = !showPipeline"
            class="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-geist font-semibold transition-colors"
            :class="showPipeline
              ? 'bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300 ring-1 ring-indigo-300 dark:ring-indigo-700'
              : 'bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-600'"
          >
            <span class="w-1.5 h-1.5 rounded-full" :class="pipelineJobs.some((j: any) => j.status === 'processing' || j.status === 'merging') ? 'bg-blue-500 animate-pulse' : 'bg-slate-400'" />
            Pipeline
          </button>
          <label v-if="showPipeline" class="flex items-center gap-1.5 text-[10px] font-geist cursor-pointer"
            :class="pipelineActiveOnly ? 'text-blue-700 dark:text-blue-300' : 'text-slate-400 dark:text-slate-600'">
            <input type="checkbox" v-model="pipelineActiveOnly" class="rounded accent-blue-600 w-3.5 h-3.5" />
            Active
          </label>
          <!-- Staleness indicator -->
          <span v-if="aiStatus && (aiStatus.stale > 0 || aiStatus.missing > 0)"
            class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-geist font-semibold bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400"
            :title="`${aiStatus.stale} stale, ${aiStatus.missing} missing — ${aiStatus.upToDate} up to date`"
          >
            {{ aiStatus.stale + aiStatus.missing }} to refresh
          </span>
          <span v-else-if="aiStatus && aiStatus.total > 0 && aiStatus.stale === 0 && aiStatus.missing === 0"
            class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-geist font-semibold bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400"
          >
            All current
          </span>
          <div class="ml-auto flex items-center gap-1.5">
            <button
              :disabled="!selectedFolderId || processingAI"
              @click="processAllAI(false)"
              class="inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-violet-300 dark:border-violet-600 text-violet-600 dark:text-violet-400 text-[11px] font-geist hover:bg-violet-50 dark:hover:bg-violet-900/20 transition-colors disabled:opacity-50"
              title="Process new and changed files only (skips unchanged)"
            >
              <RefreshCw v-if="processingAI" class="w-3 h-3 animate-spin" />
              <span v-else class="w-3 h-3 text-center font-bold">AI</span>
              {{ processingAI ? 'Processing...' : 'Process New' }}
            </button>
            <button
              :disabled="!selectedFolderId || processingAI"
              @click="processAllAI(true)"
              class="inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-amber-300 dark:border-amber-600 text-amber-600 dark:text-amber-400 text-[11px] font-geist hover:bg-amber-50 dark:hover:bg-amber-900/20 transition-colors disabled:opacity-50"
              title="Re-process all files (ignores cache)"
            >
              Re-process All
            </button>
          </div>
        </div>

        <!-- Upload Queue -->
        <div v-if="uploadQueue.length > 0" class="border-b border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/50">
          <!-- Summary bar -->
          <div v-if="uploadStats" class="px-4 py-1.5 flex items-center gap-3 text-[11px] font-geist border-b border-slate-100 dark:border-slate-800">
            <span class="font-medium text-slate-700 dark:text-slate-300">
              Uploading {{ uploadStats.done + uploadStats.error }}/{{ uploadStats.total }}
            </span>
            <span v-if="uploadStats.done > 0" class="text-emerald-600 dark:text-emerald-400">{{ uploadStats.done }} done</span>
            <span v-if="uploadStats.error > 0" class="text-red-600 dark:text-red-400">{{ uploadStats.error }} failed</span>
            <span v-if="uploadStats.pending > 0" class="text-slate-400">{{ uploadStats.pending }} queued</span>
            <!-- Progress bar -->
            <div class="flex-1 h-1.5 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden ml-2">
              <div
                class="h-full rounded-full transition-all duration-300"
                :class="uploadStats.error > 0 ? 'bg-amber-500' : 'bg-indigo-500'"
                :style="{ width: `${((uploadStats.done + uploadStats.error) / uploadStats.total) * 100}%` }"
              ></div>
            </div>
          </div>
          <!-- File list (collapsible if many) -->
          <div class="px-4 py-1.5 space-y-0.5 max-h-24 overflow-y-auto">
            <div
              v-for="(item, idx) in uploadQueue"
              :key="idx"
              class="flex items-center gap-2 text-[11px] font-geist"
            >
              <span v-if="item.progress === 'pending'" class="w-2.5 h-2.5 rounded-full bg-slate-300 dark:bg-slate-600 flex-shrink-0" />
              <RefreshCw v-else-if="item.progress === 'uploading'" class="w-2.5 h-2.5 text-indigo-500 animate-spin flex-shrink-0" />
              <span v-else-if="item.progress === 'done'" class="w-2.5 h-2.5 rounded-full bg-emerald-500 flex-shrink-0" />
              <span v-else class="w-2.5 h-2.5 rounded-full bg-red-500 flex-shrink-0" />
              <span class="truncate" :class="item.progress === 'error' ? 'text-red-500' : 'text-slate-500 dark:text-slate-400'">{{ item.name }}</span>
            </div>
          </div>
        </div>

        <!-- ═══ AI Pipeline View ═══ -->
        <div v-if="showPipeline" class="flex-1 overflow-y-auto">
          <div v-if="pipelineLoading" class="flex items-center justify-center py-8">
            <RefreshCw class="w-5 h-5 text-indigo-400 animate-spin" />
          </div>
          <div v-else-if="filteredPipelineJobs.length === 0" class="flex flex-col items-center justify-center py-12 text-center">
            <span class="text-3xl mb-2">&#x2699;</span>
            <p class="text-sm font-geist text-slate-500 dark:text-slate-400">
              {{ pipelineActiveOnly ? 'No active processing jobs' : 'No AI processing jobs' }}
            </p>
            <p class="text-xs font-geist text-slate-400 dark:text-slate-500 mt-1">
              {{ pipelineActiveOnly ? 'Uncheck "Active" to see completed and failed jobs' : 'Upload files or click "Process New" to start' }}
            </p>
          </div>
          <div v-else class="divide-y divide-slate-100 dark:divide-slate-800">
            <div v-for="job in filteredPipelineJobs" :key="job.pk_ai_processing_job" class="px-4 py-2.5">
              <!-- Job header row -->
              <div class="flex items-center gap-2 cursor-pointer" @click="toggleJobExpand(job.pk_ai_processing_job)">
                <ChevronRight
                  class="w-3.5 h-3.5 text-slate-400 transition-transform flex-shrink-0"
                  :class="{ 'rotate-90': expandedJobs.has(job.pk_ai_processing_job) }"
                />
                <span
                  class="text-[10px] font-geist font-bold px-1.5 py-0.5 rounded uppercase tracking-wide"
                  :class="pipelineStatusColor(job.status)"
                >{{ job.status }}</span>
                <span class="text-[10px] font-geist font-semibold px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-400 uppercase">{{ job.file_type }}</span>
                <span class="text-xs font-geist text-slate-800 dark:text-slate-200 truncate flex-1">{{ job.filename }}</span>
                <!-- Progress fraction -->
                <span v-if="job.total_sub_jobs > 0" class="text-[10px] font-geist text-slate-400 dark:text-slate-500 flex-shrink-0">
                  {{ job.completed_sub_jobs + job.failed_sub_jobs }}/{{ job.total_sub_jobs }}
                </span>
                <span class="text-[10px] font-geist text-slate-400 dark:text-slate-500 flex-shrink-0">{{ timeSince(job.created_at) }}</span>
                <button
                  v-if="job.status === 'failed'"
                  @click.stop="retryJob(job.pk_ai_processing_job)"
                  class="flex-shrink-0 px-2 py-0.5 text-[9px] font-geist font-semibold rounded bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 hover:bg-amber-200 dark:hover:bg-amber-900/50 transition-colors"
                >
                  Retry
                </button>
              </div>

              <!-- Progress bar -->
              <div v-if="job.total_sub_jobs > 1" class="mt-1.5 ml-5 flex items-center gap-2">
                <div class="flex-1 h-1.5 bg-slate-100 dark:bg-slate-700 rounded-full overflow-hidden">
                  <div class="h-full rounded-full transition-all duration-500 flex">
                    <div
                      class="h-full bg-emerald-500"
                      :style="{ width: `${(job.completed_sub_jobs / job.total_sub_jobs) * 100}%` }"
                    />
                    <div
                      v-if="job.failed_sub_jobs > 0"
                      class="h-full bg-red-400"
                      :style="{ width: `${(job.failed_sub_jobs / job.total_sub_jobs) * 100}%` }"
                    />
                  </div>
                </div>
                <span class="text-[9px] font-geist text-slate-400 w-8 text-right">{{ Math.round(((job.completed_sub_jobs + job.failed_sub_jobs) / job.total_sub_jobs) * 100) }}%</span>
              </div>

              <!-- Error message -->
              <div v-if="job.error_message" class="mt-1 ml-5 flex items-center gap-2">
                <span class="text-[10px] font-geist text-red-500 dark:text-red-400 truncate" :title="job.error_message">
                  {{ job.error_message }}
                </span>
                <button
                  v-if="job.status === 'failed'"
                  @click.stop="retryJob(job.pk_ai_processing_job)"
                  class="flex-shrink-0 px-2 py-0.5 text-[9px] font-geist font-semibold rounded bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 hover:bg-amber-200 dark:hover:bg-amber-900/50 transition-colors"
                >
                  Retry
                </button>
              </div>

              <!-- Shadow file result -->
              <div v-if="job.status === 'completed' && job.shadow_item_id" class="mt-1 ml-5 flex items-center gap-1.5">
                <span class="text-[10px] font-geist text-emerald-600 dark:text-emerald-400">Merged &rarr;</span>
                <span class="text-[10px] font-geist text-violet-600 dark:text-violet-400">__AI__{{ job.filename.replace(/\.[^.]+$/, '') }}.md</span>
              </div>

              <!-- Expanded: sub-jobs -->
              <div v-if="expandedJobs.has(job.pk_ai_processing_job) && job.sub_jobs?.length" class="mt-2 ml-5 space-y-1">
                <div
                  v-for="sub in job.sub_jobs"
                  :key="sub.pk_ai_processing_sub_job"
                  class="flex items-start gap-2 py-1 px-2 rounded-lg bg-slate-50/80 dark:bg-slate-800/50"
                >
                  <!-- Status dot -->
                  <span class="mt-0.5 w-2 h-2 rounded-full flex-shrink-0"
                    :class="{
                      'bg-slate-300 dark:bg-slate-600': sub.status === 'pending',
                      'bg-blue-500 animate-pulse': sub.status === 'processing',
                      'bg-emerald-500': sub.status === 'completed',
                      'bg-red-500': sub.status === 'failed',
                    }"
                  />
                  <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2">
                      <span class="text-[10px] font-geist font-medium text-slate-700 dark:text-slate-300">
                        {{ subJobLabel(sub.sub_type, sub.sequence_num) }}
                      </span>
                      <span class="text-[9px] font-geist px-1 py-0.5 rounded"
                        :class="pipelineStatusColor(sub.status)"
                      >{{ sub.status }}</span>
                      <span v-if="sub.input_size_bytes" class="text-[9px] font-geist text-slate-400">
                        {{ (sub.input_size_bytes / 1024).toFixed(0) }} KB
                      </span>
                      <span v-if="sub.retry_count > 0" class="text-[9px] font-geist text-amber-500">
                        retry {{ sub.retry_count }}
                      </span>
                    </div>
                    <!-- Sub-job error -->
                    <div v-if="sub.error_message" class="text-[9px] font-geist text-red-400 truncate mt-0.5" :title="sub.error_message">
                      {{ sub.error_message }}
                    </div>
                    <!-- Sub-job result preview -->
                    <div v-if="sub.result_markdown && sub.sub_type !== 'docx_text' && sub.sub_type !== 'pptx_text'" class="text-[9px] font-geist text-slate-400 dark:text-slate-500 mt-0.5 line-clamp-2">
                      {{ sub.result_markdown.substring(0, 200) }}{{ sub.result_markdown.length > 200 ? '...' : '' }}
                    </div>
                    <div v-else-if="sub.result_markdown && (sub.sub_type === 'docx_text' || sub.sub_type === 'pptx_text')" class="text-[9px] font-geist text-slate-400 dark:text-slate-500 mt-0.5">
                      {{ sub.result_markdown.length > 0 ? `${(sub.result_markdown.length / 1024).toFixed(1)} KB extracted` : 'Empty' }}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- File Loading -->
        <div v-else-if="loadingFiles" class="flex-1 flex items-center justify-center">
          <RefreshCw class="w-5 h-5 text-slate-400 animate-spin" />
        </div>

        <!-- No Folder Selected -->
        <div
          v-else-if="!selectedFolderId"
          class="flex-1 flex flex-col items-center justify-center text-center px-8"
        >
          <FolderOpen class="w-12 h-12 text-slate-200 dark:text-slate-700 mb-3" />
          <p class="text-sm font-geist text-slate-500 dark:text-slate-400">
            Select a folder from the tree to view its files
          </p>
        </div>

        <!-- Empty Folder -->
        <div
          v-else-if="filteredFiles.length === 0 && !loadingFiles"
          class="flex-1 flex flex-col items-center justify-center text-center px-8"
        >
          <FileText class="w-12 h-12 text-slate-200 dark:text-slate-700 mb-3" />
          <p class="text-sm font-geist text-slate-500 dark:text-slate-400">
            {{ searchQuery ? 'No files match your search' : 'This folder is empty' }}
          </p>
        </div>

        <!-- File Table -->
        <div v-else class="flex-1 overflow-y-auto">
          <table class="w-full text-sm font-geist">
            <thead
              class="sticky top-0 bg-slate-50 dark:bg-slate-800/80 backdrop-blur-sm border-b border-slate-200 dark:border-slate-700"
            >
              <tr>
                <th
                  class="text-left px-4 py-2.5 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider"
                >
                  Name
                </th>
                <th
                  class="text-right px-4 py-2.5 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider w-24"
                >
                  Size
                </th>
                <th
                  class="text-left px-4 py-2.5 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider w-32"
                >
                  Modified
                </th>
                <th
                  class="text-right px-4 py-2.5 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider w-28"
                >
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              <!-- Subfolder breadcrumb: go up row -->
              <tr
                v-if="browseStack.length > 0"
                class="border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/50 cursor-pointer transition-colors"
                @click="browseUp()"
              >
                <td class="px-4 py-2" colspan="4">
                  <div class="flex items-center gap-2 text-slate-500 dark:text-slate-400">
                    <CornerLeftUp class="w-4 h-4" />
                    <span class="text-xs">
                      .. / {{ browseStack.length > 1 ? browseStack[browseStack.length - 2].name : 'Root' }}
                    </span>
                    <span class="text-[10px] text-slate-400 dark:text-slate-500 ml-2">
                      {{ browseStack.map(s => s.name).join(' / ') }}
                    </span>
                  </div>
                </td>
              </tr>
              <tr
                v-for="file in filteredFiles"
                :key="file.id"
                class="group border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors"
                :class="{
                  'cursor-pointer': file.type === 'folder' || selectMode === 'file' || selectMode === 'both',
                }"
                @click="file.type === 'folder' ? browseIntoSubfolder(file) : handleSelectItem(file)"
              >
                <td class="px-4 py-2.5">
                  <div class="flex items-center gap-2.5">
                    <!-- Folder icon for folders, extension badge for files -->
                    <template v-if="file.type === 'folder'">
                      <Folder class="w-4 h-4 text-amber-500 dark:text-amber-400 flex-shrink-0" />
                    </template>
                    <template v-else>
                      <span
                        class="inline-flex items-center justify-center px-1.5 py-0.5 rounded text-[10px] font-bold tracking-wide leading-none"
                        :class="getExtensionLabel(file.name).color"
                      >
                        {{ getExtensionLabel(file.name).label }}
                      </span>
                    </template>
                    <span v-if="file.type === 'file' && file.name.startsWith('__AI__')" class="inline-flex items-center px-1 py-0.5 rounded text-[9px] font-bold bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300">AI</span>
                    <span
                      class="truncate max-w-xs"
                      :class="[
                        file.type === 'folder'
                          ? 'font-medium text-slate-800 dark:text-slate-200'
                          : file.name.startsWith('__AI__')
                            ? 'text-violet-700 dark:text-violet-300'
                            : 'text-slate-800 dark:text-slate-200'
                      ]"
                    >
                      <span
                        v-if="file.type === 'file' && canPreview(file.name)"
                        class="hover:underline cursor-pointer"
                        @click.stop="openPreview(file)"
                      >{{ file.name.startsWith('__AI__') ? file.name.replace('__AI__', '') : file.name }}</span>
                      <template v-else>{{ file.type === 'file' && file.name.startsWith('__AI__') ? file.name.replace('__AI__', '') : file.name }}</template>
                    </span>
                    <a
                      v-if="file.webUrl"
                      :href="file.webUrl"
                      target="_blank"
                      rel="noopener noreferrer"
                      class="opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
                      @click.stop
                      title="Open in SharePoint"
                    >
                      <ExternalLink
                        class="w-3.5 h-3.5 text-slate-400 hover:text-sky-500 dark:hover:text-sky-400"
                      />
                    </a>
                  </div>
                </td>
                <td class="px-4 py-2.5 text-right text-slate-500 dark:text-slate-400">
                  <template v-if="file.type === 'folder'">&mdash;</template>
                  <template v-else>{{ formatBytes(file.size) }}</template>
                </td>
                <td class="px-4 py-2.5 text-slate-500 dark:text-slate-400">
                  {{ formatDate(file.modifiedAt) }}
                </td>
                <td class="px-4 py-2.5 text-right">
                  <div v-if="file.type === 'file'" class="flex items-center justify-end gap-1">
                    <button
                      v-if="canPreview(file.name)"
                      class="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-500 dark:text-slate-400 hover:text-emerald-600 dark:hover:text-emerald-400 transition-colors"
                      title="Preview"
                      @click.stop="openPreview(file)"
                    >
                      <Eye class="w-4 h-4" />
                    </button>
                    <button
                      class="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-500 dark:text-slate-400 hover:text-sky-600 dark:hover:text-sky-400 transition-colors"
                      title="Download"
                      @click.stop="handleDownload(file)"
                    >
                      <Download class="w-4 h-4" />
                    </button>
                    <button
                      class="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-500 dark:text-slate-400 hover:text-amber-600 dark:hover:text-amber-400 transition-colors"
                      title="Rename"
                      @click.stop="openRename(file.id, file.name)"
                    >
                      <Edit3 class="w-4 h-4" />
                    </button>
                    <button
                      class="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-500 dark:text-slate-400 hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors"
                      title="Move"
                      @click.stop="openMove(file.id, file.name)"
                    >
                      <FolderInput class="w-4 h-4" />
                    </button>
                    <button
                      v-if="!file.name.startsWith('__AI__') && /\.(pdf|png|jpg|jpeg|gif|docx|xlsx|xls|pptx|ppt|bmp|webp)$/i.test(file.name)"
                      class="p-1.5 rounded-lg hover:bg-violet-50 dark:hover:bg-violet-900/20 text-slate-500 dark:text-slate-400 hover:text-violet-600 dark:hover:text-violet-400 transition-colors"
                      title="Generate AI-ready version"
                      @click.stop="processFileAI(file.id, file.name)"
                      :disabled="processingAI"
                    >
                      <span class="w-4 h-4 flex items-center justify-center text-[10px] font-bold">AI</span>
                    </button>
                    <button
                      class="p-1.5 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/20 text-slate-500 dark:text-slate-400 hover:text-red-600 dark:hover:text-red-400 transition-colors"
                      title="Delete"
                      @click.stop="handleDeleteFile(file.id, file.name)"
                    >
                      <Trash2 class="w-4 h-4" />
                    </button>
                  </div>
                  <div v-else class="flex items-center justify-end gap-1">
                    <button
                      class="p-1.5 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/20 text-slate-500 dark:text-slate-400 hover:text-red-600 dark:hover:text-red-400 transition-colors"
                      title="Delete folder"
                      @click.stop="handleDeleteFile(file.id, file.name)"
                    >
                      <Trash2 class="w-4 h-4" />
                    </button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- New Subfolder + File Count Footer -->
        <div
          v-if="selectedFolderId"
          class="px-4 py-2 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between gap-2"
        >
          <div class="flex items-center gap-2">
            <input
              v-model="newSubfolderName"
              type="text"
              placeholder="New folder name..."
              class="text-xs font-geist px-2 py-1 rounded border border-slate-200 dark:border-slate-600 bg-transparent text-slate-700 dark:text-slate-300 w-40 focus:outline-none focus:border-indigo-400"
              @keydown.enter="createNewSubfolder"
            />
            <button
              :disabled="!newSubfolderName.trim() || creatingSubfolder"
              @click="createNewSubfolder"
              class="text-[11px] font-geist px-2 py-1 rounded border border-slate-200 dark:border-slate-600 text-slate-500 dark:text-slate-400 hover:text-indigo-600 hover:border-indigo-300 transition-colors disabled:opacity-50"
            >
              <FolderPlus class="w-3.5 h-3.5 inline -mt-0.5 mr-0.5" /> Create
            </button>
          </div>
          <span v-if="!loadingFiles" class="text-xs font-geist text-slate-400 dark:text-slate-500">
            {{ filteredFiles.filter(f => f.type === 'folder').length }} folder{{ filteredFiles.filter(f => f.type === 'folder').length === 1 ? '' : 's' }},
            {{ filteredFiles.filter(f => f.type === 'file').length }} file{{ filteredFiles.filter(f => f.type === 'file').length === 1 ? '' : 's' }}
          </span>
        </div>
      </div>
    </div>

    <!-- ═══ Create Subfolder Dialog ═══ -->
    <Dialog v-model:visible="subfolderDialogVisible" header="Create Subfolder" :modal="true" :style="{ width: '420px' }" :breakpoints="{ '768px': '90vw' }">
      <div class="space-y-3">
        <label class="text-xs font-geist text-slate-500 dark:text-slate-400 block">Folder name</label>
        <input
          v-model="subfolderNewName"
          type="text"
          placeholder="New folder name..."
          class="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800 text-sm font-geist text-slate-800 dark:text-slate-200 focus:outline-none focus:border-indigo-400"
          @keydown.enter="submitNewSubfolder"
        />
      </div>
      <template #footer>
        <button class="px-3 py-1.5 text-xs font-geist text-slate-500 hover:text-slate-700 dark:text-slate-400" @click="subfolderDialogVisible = false">Cancel</button>
        <button
          :disabled="!subfolderNewName.trim() || creatingSubfolder"
          @click="submitNewSubfolder"
          class="px-3 py-1.5 text-xs font-geist font-medium bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors"
        >
          {{ creatingSubfolder ? 'Creating...' : 'Create' }}
        </button>
      </template>
    </Dialog>

    <!-- ═══ New Document Dialog ═══ -->
    <Dialog
      v-model:visible="newDocDialogVisible"
      header="New Document"
      :modal="true"
      :style="{ width: '720px' }"
      :breakpoints="{ '768px': '95vw' }"
    >
      <div class="space-y-3">
        <div>
          <label class="text-xs font-geist text-slate-500 dark:text-slate-400 block mb-1">
            Filename (include extension, e.g. <code class="font-mono text-[11px]">notes.md</code>)
          </label>
          <input
            v-model="newDocFilename"
            type="text"
            placeholder="filename.ext"
            autocomplete="off"
            spellcheck="false"
            class="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800 text-sm font-geist text-slate-800 dark:text-slate-200 focus:outline-none focus:border-indigo-400"
          />
          <p class="text-[10px] font-geist text-slate-400 dark:text-slate-500 mt-1">
            Will be saved into:
            <span class="font-medium text-slate-600 dark:text-slate-300">{{ selectedFolderPath || '(folder)' }}</span>
            <span v-if="browseStack.length > 0">
              / {{ browseStack.map(s => s.name).join(' / ') }}
            </span>
          </p>
        </div>
        <div>
          <label class="text-xs font-geist text-slate-500 dark:text-slate-400 block mb-1">Content</label>
          <div class="rounded-lg border border-slate-200 dark:border-slate-600 overflow-hidden bg-white dark:bg-slate-900">
            <Codemirror
              v-model="newDocContent"
              :placeholder="'Type the document contents here. Leave blank to create an empty file.'"
              :style="{ height: '420px', fontSize: '13px' }"
              :indent-with-tab="true"
              :tab-size="2"
              :extensions="newDocExtensions"
              @ready="onNewDocReady"
            />
          </div>
          <p class="text-[10px] font-geist text-slate-400 dark:text-slate-500 mt-1">
            {{ newDocContent.length.toLocaleString() }} characters · UTF-8
          </p>
        </div>
        <p v-if="newDocError" class="text-xs font-geist text-red-600 dark:text-red-400">
          {{ newDocError }}
        </p>
      </div>
      <template #footer>
        <button
          class="px-3 py-1.5 text-xs font-geist text-slate-500 hover:text-slate-700 dark:text-slate-400"
          @click="newDocDialogVisible = false"
        >
          Cancel
        </button>
        <button
          :disabled="!newDocFilename.trim() || newDocSaving"
          @click="submitNewDoc"
          class="px-3 py-1.5 text-xs font-geist font-medium bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors"
        >
          {{ newDocSaving ? 'Saving...' : 'Save to SharePoint' }}
        </button>
      </template>
    </Dialog>

    <!-- ═══ Rename Dialog ═══ -->
    <Dialog v-model:visible="renameDialogVisible" header="Rename" :modal="true" :style="{ width: '420px' }" :breakpoints="{ '768px': '90vw' }">
      <div class="space-y-3">
        <label class="text-xs font-geist text-slate-500 dark:text-slate-400 block">New name</label>
        <input
          v-model="renameNewName"
          type="text"
          class="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800 text-sm font-geist text-slate-800 dark:text-slate-200 focus:outline-none focus:border-indigo-400"
          @keydown.enter="submitRename"
        />
      </div>
      <template #footer>
        <button class="px-3 py-1.5 text-xs font-geist text-slate-500 hover:text-slate-700 dark:text-slate-400" @click="renameDialogVisible = false">Cancel</button>
        <button
          :disabled="!renameNewName.trim() || renaming"
          @click="submitRename"
          class="px-3 py-1.5 text-xs font-geist font-medium bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors"
        >
          {{ renaming ? 'Renaming...' : 'Rename' }}
        </button>
      </template>
    </Dialog>

    <!-- ═══ Move Dialog ═══ -->
    <Dialog v-model:visible="moveDialogVisible" header="Move to Folder" :modal="true" :style="{ width: '420px' }" :breakpoints="{ '768px': '90vw' }">
      <div class="space-y-3">
        <p class="text-xs font-geist text-slate-500 dark:text-slate-400">Move "{{ moveTarget?.name }}" to:</p>
        <select
          v-model="moveTargetFolderId"
          class="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800 text-sm font-geist text-slate-800 dark:text-slate-200"
        >
          <option value="">Select destination folder...</option>
          <option v-for="f in flatFolders" :key="f.id" :value="f.id">{{ f.path }}</option>
        </select>
      </div>
      <template #footer>
        <button class="px-3 py-1.5 text-xs font-geist text-slate-500 hover:text-slate-700 dark:text-slate-400" @click="moveDialogVisible = false">Cancel</button>
        <button
          :disabled="!moveTargetFolderId || moving"
          @click="submitMove"
          class="px-3 py-1.5 text-xs font-geist font-medium bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors"
        >
          {{ moving ? 'Moving...' : 'Move' }}
        </button>
      </template>
    </Dialog>

    <!-- ═══ File Preview Dialog ═══ -->
    <Dialog
      v-model:visible="previewVisible"
      :modal="true"
      :style="{ width: 'calc(100vw - 50px)', height: 'calc(100vh - 50px)', margin: '25px', maxHeight: 'calc(100vh - 50px)' }"
      :contentStyle="{ padding: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', flex: '1' }"
    >
      <template #header>
        <div class="flex items-center gap-2 min-w-0">
          <span v-if="previewFilename.startsWith('__AI__')" class="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300 flex-shrink-0">AI</span>
          <span class="text-sm font-geist font-medium text-slate-800 dark:text-slate-200 truncate">{{ previewFilename.startsWith('__AI__') ? previewFilename.replace('__AI__', '') : previewFilename }}</span>
        </div>
      </template>
      <!-- Shadow file banner -->
      <div v-if="previewShadowBanner" class="px-4 py-1.5 border-b border-violet-200 dark:border-violet-800 bg-violet-50 dark:bg-violet-900/20 flex items-center gap-2">
        <span class="text-[10px] font-bold px-1.5 py-0.5 rounded bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300">AI</span>
        <span class="text-[11px] font-geist text-violet-700 dark:text-violet-300">{{ previewShadowBanner }}</span>
      </div>

      <!-- Toolbar for markdown/text: search (view) or edit controls (edit) -->
      <div v-if="previewType === 'markdown' || previewType === 'text'" class="px-4 py-2 border-b border-slate-100 dark:border-slate-800 flex items-center gap-2">
        <template v-if="!previewEditing">
          <Search class="w-3.5 h-3.5 text-slate-400" />
          <input
            v-model="previewSearch"
            type="text"
            placeholder="Search in document..."
            class="flex-1 text-xs font-geist bg-transparent text-slate-800 dark:text-slate-200 focus:outline-none placeholder:text-slate-400"
          />
          <span v-if="previewContent" class="text-[10px] font-geist text-slate-400">
            {{ (previewContent.length / 1024).toFixed(1) }} KB
          </span>
          <button
            v-if="previewIsEditable"
            @click="enterPreviewEdit"
            class="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-geist font-medium border border-indigo-300 dark:border-indigo-600 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 transition-colors"
          >
            <Edit3 class="w-3 h-3" />
            Edit
          </button>
        </template>
        <template v-else>
          <Edit3 class="w-3.5 h-3.5 text-indigo-500" />
          <span class="text-[11px] font-geist text-slate-500 dark:text-slate-400 truncate">
            Editing — changes save in place to <span class="font-medium text-slate-700 dark:text-slate-300">{{ previewFilename }}</span>
          </span>
          <span class="ml-auto text-[10px] font-geist text-slate-400">
            {{ previewEditBuffer.length.toLocaleString() }} chars
          </span>
          <button
            :disabled="previewSaving"
            @click="cancelPreviewEdit"
            class="inline-flex items-center px-2 py-1 rounded-md text-[11px] font-geist text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors disabled:opacity-50"
          >Cancel</button>
          <button
            :disabled="previewSaving"
            @click="savePreviewEdit"
            class="inline-flex items-center px-2 py-1 rounded-md text-[11px] font-geist font-medium bg-indigo-600 text-white hover:bg-indigo-700 transition-colors disabled:opacity-50"
          >{{ previewSaving ? 'Saving…' : 'Save' }}</button>
        </template>
      </div>
      <div v-if="previewSaveError" class="px-4 py-1.5 border-b border-red-200 dark:border-red-800/40 bg-red-50/60 dark:bg-red-900/20 text-[11px] font-geist text-red-700 dark:text-red-300">
        {{ previewSaveError }}
      </div>

      <!-- Loading -->
      <div v-if="previewLoading" class="flex-1 flex items-center justify-center py-16">
        <RefreshCw class="w-6 h-6 text-indigo-400 animate-spin" />
      </div>

      <!-- Inline CodeMirror editor (replaces rendered view while editing) -->
      <div
        v-else-if="previewEditing && (previewType === 'markdown' || previewType === 'text')"
        class="flex-1 overflow-hidden flex flex-col bg-white dark:bg-slate-900"
      >
        <Codemirror
          v-model="previewEditBuffer"
          :style="{ flex: '1', minHeight: '0', fontSize: '13px' }"
          :indent-with-tab="true"
          :tab-size="2"
          :extensions="previewEditExtensions"
        />
      </div>

      <!-- Markdown rendered view -->
      <div
        v-else-if="previewType === 'markdown'"
        class="md-preview flex-1 overflow-y-auto"
        v-html="previewSearchHighlighted || previewRendered"
      />

      <!-- Plain text view -->
      <div
        v-else-if="previewType === 'text'"
        class="flex-1 overflow-y-auto"
      >
        <pre class="px-6 py-4 text-xs font-mono text-slate-700 dark:text-slate-300 whitespace-pre-wrap break-words leading-relaxed">{{ previewContent }}</pre>
      </div>

      <!-- Image view -->
      <div
        v-else-if="previewType === 'image'"
        class="flex-1 overflow-auto flex items-center justify-center bg-slate-50 dark:bg-slate-900 p-4"
      >
        <img :src="previewImageUrl" :alt="previewFilename" class="max-w-full max-h-full object-contain rounded-lg shadow-lg" />
      </div>

      <!-- PDF view (native browser viewer) -->
      <div
        v-else-if="previewType === 'pdf'"
        class="flex-1 overflow-hidden bg-slate-100 dark:bg-slate-900"
      >
        <iframe
          :src="previewPdfUrl"
          class="w-full h-full border-0"
          :title="previewFilename"
        />
      </div>

      <!-- Office file with no AI shadow -->
      <div
        v-else-if="previewType === 'office-no-shadow'"
        class="flex-1 flex flex-col items-center justify-center text-center px-8 gap-4"
      >
        <div class="w-16 h-16 rounded-2xl bg-slate-100 dark:bg-slate-800 flex items-center justify-center">
          <FileText class="w-8 h-8 text-slate-300 dark:text-slate-600" />
        </div>
        <div>
          <p class="text-sm font-geist font-medium text-slate-700 dark:text-slate-300 mb-1">{{ previewContent }}</p>
          <p class="text-xs font-geist text-slate-500 dark:text-slate-400">
            This file type can't be rendered directly in the browser.
          </p>
          <p class="text-xs font-geist text-slate-400 dark:text-slate-500 mt-1">
            Process it with AI to create a readable markdown version, or download the original.
          </p>
        </div>
        <div class="flex gap-2">
          <button
            @click="previewVisible = false"
            class="px-3 py-1.5 text-xs font-geist font-medium bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors"
          >Close</button>
        </div>
      </div>

      <template #footer>
        <div class="flex items-center justify-between w-full">
          <span class="text-[10px] font-geist text-slate-400">
            <template v-if="previewEditing">Editing</template>
            <template v-else-if="previewType === 'markdown' && previewShadowBanner">AI-Processed Markdown</template>
            <template v-else-if="previewType === 'markdown'">Rendered Markdown</template>
            <template v-else-if="previewType === 'text'">Plain Text</template>
            <template v-else-if="previewType === 'pdf'">PDF Viewer</template>
            <template v-else-if="previewType === 'image'">Image Preview</template>
          </span>
          <button
            @click="previewVisible = false"
            class="px-3 py-1.5 text-xs font-geist font-medium bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors"
          >Close</button>
        </div>
      </template>
    </Dialog>
  </Dialog>
</template>

<style>
/* ═══════════════════════════════════════════════════════════════
   Markdown Preview Styles
   Clean, readable document rendering with Calibri/Arial font stack
   ═══════════════════════════════════════════════════════════════ */

.md-preview {
  padding: 24px 32px;
  font-family: Calibri, 'Segoe UI', Arial, Helvetica, sans-serif;
  font-size: 14px;
  line-height: 1.75;
  color: #334155;
  max-width: 100%;
  word-wrap: break-word;
}

.dark .md-preview {
  color: #f1f5f9;
}

.dark .md-preview p,
.dark .md-preview li,
.dark .md-preview td,
.dark .md-preview dd,
.dark .md-preview dt {
  color: #e2e8f0;
}

.dark .md-preview strong {
  color: #f8fafc;
}

.dark .md-preview h5,
.dark .md-preview h6 {
  color: #94a3b8;
}

/* ── Headings ── */
.md-preview h1 {
  font-size: 1.75rem;
  font-weight: 700;
  color: #0f172a;
  margin: 0 0 1rem 0;
  padding-bottom: 0.6rem;
  border-bottom: 2px solid #e2e8f0;
  line-height: 1.3;
}

.md-preview h2 {
  font-size: 1.35rem;
  font-weight: 600;
  color: #1e293b;
  margin: 2rem 0 0.75rem 0;
  padding-bottom: 0.4rem;
  border-bottom: 1px solid #f1f5f9;
  line-height: 1.35;
}

.md-preview h3 {
  font-size: 1.1rem;
  font-weight: 600;
  color: #334155;
  margin: 1.5rem 0 0.5rem 0;
  line-height: 1.4;
}

.md-preview h4 {
  font-size: 1rem;
  font-weight: 600;
  color: #475569;
  margin: 1.25rem 0 0.4rem 0;
}

.md-preview h5,
.md-preview h6 {
  font-size: 0.875rem;
  font-weight: 600;
  color: #64748b;
  margin: 1rem 0 0.3rem 0;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

/* Dark mode headings */
.dark .md-preview h1 { color: #f1f5f9; border-bottom-color: #334155; }
.dark .md-preview h2 { color: #e2e8f0; border-bottom-color: #1e293b; }
.dark .md-preview h3 { color: #cbd5e1; }
.dark .md-preview h4 { color: #94a3b8; }

/* ── Paragraphs & Text ── */
.md-preview p {
  margin: 0 0 1rem 0;
}

.md-preview strong { font-weight: 700; }
.md-preview em { font-style: italic; }
.md-preview del { text-decoration: line-through; opacity: 0.6; }

/* ── Links ── */
.md-preview a {
  color: #4f46e5;
  text-decoration: none;
  border-bottom: 1px solid transparent;
  transition: border-color 0.15s;
}
.md-preview a:hover { border-bottom-color: #4f46e5; }
.dark .md-preview a { color: #818cf8; }

/* ── Lists ── */
.md-preview ul,
.md-preview ol {
  margin: 0.5rem 0 1rem 0;
  padding-left: 1.5rem;
}

.md-preview li {
  margin: 0.3rem 0;
  line-height: 1.65;
}

.md-preview ul { list-style-type: disc; }
.md-preview ul ul { list-style-type: circle; }
.md-preview ol { list-style-type: decimal; }

/* ── Tables — striped, bordered, polished ── */
.md-preview table {
  width: 100%;
  border-collapse: collapse;
  margin: 1rem 0 1.5rem 0;
  font-size: 0.8125rem;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  overflow: hidden;
}

.dark .md-preview table {
  border-color: #334155;
}

.md-preview thead {
  background: linear-gradient(to bottom, #f8fafc, #f1f5f9);
}

.dark .md-preview thead {
  background: linear-gradient(to bottom, #1e293b, #0f172a);
}

.md-preview th {
  padding: 10px 14px;
  font-weight: 700;
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: #475569;
  text-align: left;
  border-bottom: 2px solid #e2e8f0;
}

.dark .md-preview th {
  color: #94a3b8;
  border-bottom-color: #334155;
}

.md-preview td {
  padding: 9px 14px;
  border-bottom: 1px solid #f1f5f9;
  vertical-align: top;
}

.dark .md-preview td {
  border-bottom-color: #1e293b;
}

/* Striped rows */
.md-preview tbody tr:nth-child(even) {
  background-color: #f8fafc;
}

.dark .md-preview tbody tr:nth-child(even) {
  background-color: rgba(30, 41, 59, 0.3);
}

.md-preview tbody tr:hover {
  background-color: #eff6ff;
}

.dark .md-preview tbody tr:hover {
  background-color: rgba(30, 58, 138, 0.15);
}

/* ── Code ── */
.md-preview code {
  font-family: 'Cascadia Code', 'Fira Code', 'JetBrains Mono', Consolas, monospace;
  font-size: 0.8125rem;
  background: #f1f5f9;
  color: #be185d;
  padding: 2px 6px;
  border-radius: 4px;
}

.dark .md-preview code {
  background: #1e293b;
  color: #f472b6;
}

.md-preview pre {
  background: #0f172a;
  color: #e2e8f0;
  padding: 16px 20px;
  border-radius: 8px;
  overflow-x: auto;
  margin: 1rem 0 1.5rem 0;
  font-size: 0.8125rem;
  line-height: 1.6;
}

.md-preview pre code {
  background: none;
  color: inherit;
  padding: 0;
  font-size: inherit;
}

/* ── Blockquotes ── */
.md-preview blockquote {
  margin: 1rem 0;
  padding: 12px 20px;
  border-left: 4px solid #6366f1;
  background: #f8fafc;
  color: #475569;
  border-radius: 0 6px 6px 0;
}

.dark .md-preview blockquote {
  background: rgba(30, 41, 59, 0.5);
  color: #94a3b8;
  border-left-color: #818cf8;
}

.md-preview blockquote p:last-child { margin-bottom: 0; }

/* ── Horizontal rules ── */
.md-preview hr {
  border: none;
  border-top: 1px solid #e2e8f0;
  margin: 2rem 0;
}

.dark .md-preview hr {
  border-top-color: #334155;
}

/* ── Images ── */
.md-preview img {
  max-width: 100%;
  height: auto;
  border-radius: 8px;
  box-shadow: 0 1px 3px rgba(0,0,0,0.1);
  margin: 1rem 0;
}

/* ── Italic markers for placeholders like *[Image 1: ]* ── */
.md-preview em {
  font-style: italic;
}

/* ── Details/Summary (collapsible) ── */
.md-preview details {
  margin: 0.75rem 0;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  padding: 0;
}

.md-preview summary {
  padding: 8px 14px;
  cursor: pointer;
  font-weight: 600;
  user-select: none;
}

.md-preview details[open] summary {
  border-bottom: 1px solid #e2e8f0;
}

/* ── Search highlight ── */
.md-preview mark {
  background: #fef08a;
  padding: 1px 3px;
  border-radius: 2px;
}

.dark .md-preview mark {
  background: rgba(161, 98, 7, 0.4);
  color: #fef08a;
}
</style>
