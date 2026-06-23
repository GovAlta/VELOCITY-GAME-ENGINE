<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import api from '@/lib/api'
import InputText from 'primevue/inputtext'
import Textarea from 'primevue/textarea'
import Select from 'primevue/select'
import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import { Search, X, Bot, User, Clock, CheckCircle, AlertTriangle, Play, ArrowRight, Hand, Target } from 'lucide-vue-next'
import ModuleDetailDialog from '@/components/modules/ModuleDetailDialog.vue'
import QuickStartGuide from '@/components/velocity/QuickStartGuide.vue'
import ApiPlaybook from '@/components/velocity/ApiPlaybook.vue'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface StepData {
  pk_module_velocity: string
  step_name: string
  step_order: number
  status: string
  current_actor: string | null
  loop_count: number
  turn_count: number
  is_locked: boolean
}

interface ModuleMetrics {
  fk_mvm_module: string
  loopback_count: number
  total_turns: number
  ai_time_seconds: number
  human_time_seconds: number
  current_step_name: string | null
  velocity_score?: number
  velocity_bonus?: number
  velocity_penalty?: number
  alignment_count?: number
  misalignment_count?: number
}

interface VelocityModule {
  module_name: string
  pk_module: string
  steps: StepData[]
  metrics?: ModuleMetrics
  is_mission_critical?: boolean
}

interface VelocityProject {
  project_name: string
  pk_project: string
  modules: VelocityModule[]
  // Lineage (decorated by reloadAllData from /velocity payload)
  fk_project_parent: string | null
  project_version_label: string | null
  project_cloned_from_name: string | null
  project_is_locked: boolean
  project_locked_by: string | null
}

interface VelocityRow {
  project_name: string
  pk_project: string
  module_name: string
  pk_module: string
  steps: StepData[]
  metrics?: ModuleMetrics
  is_mission_critical?: boolean
  // Lineage
  fk_project_parent: string | null
  project_version_label: string | null
  project_is_locked: boolean
}

interface TurnEntry {
  pk_velocity_turn: string
  turn_actor: string
  turn_action: string
  turn_from_status: string
  turn_to_status: string
  turn_content: string
  turn_attachments: { filename: string; url: string; type?: string }[]
  turn_user_email: string | null
  turn_user_name: string | null
  turn_api_key_id: string | null
  created_at: string
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const STEP_KEYS = ['requirements', 'planning', 'architecture', 'prototyping', 'development', 'user_testing', 'user_acceptance', 'deployment']
const STEP_LABELS: Record<string, string> = {
  requirements: 'Requirements', planning: 'Planning', architecture: 'Architecture',
  prototyping: 'Prototyping', development: 'Development', user_testing: 'User Testing',
  user_acceptance: 'User Acceptance', deployment: 'Deployment',
}

const STATUS_COLORS: Record<string, { bg: string; text: string; pulse?: boolean; ring?: string }> = {
  'not_started':    { bg: 'bg-slate-100 dark:bg-slate-700', text: 'text-slate-400 dark:text-slate-500' },
  'ready_to_start': { bg: 'bg-sky-100 dark:bg-sky-900/40', text: 'text-sky-700 dark:text-sky-300' },
  'ai_working':     { bg: 'bg-violet-200 dark:bg-violet-800/50', text: 'text-violet-800 dark:text-violet-200', pulse: true },
  'human_working':  { bg: 'bg-blue-200 dark:bg-blue-800/50', text: 'text-blue-800 dark:text-blue-200', pulse: true },
  'ai_review':      { bg: 'bg-violet-100 dark:bg-violet-900/40', text: 'text-violet-600 dark:text-violet-300' },
  'human_review':   { bg: 'bg-blue-100 dark:bg-blue-900/40', text: 'text-blue-600 dark:text-blue-300' },
  'completed':      { bg: 'bg-emerald-100 dark:bg-emerald-900/40', text: 'text-emerald-700 dark:text-emerald-300' },
  'blocked':        { bg: 'bg-red-100 dark:bg-red-900/40', text: 'text-red-700 dark:text-red-300', ring: 'ring-2 ring-red-400 dark:ring-red-600' },
  'hand_raised':    { bg: 'bg-yellow-100 dark:bg-yellow-900/40', text: 'text-yellow-800 dark:text-yellow-200', pulse: true, ring: 'ring-2 ring-yellow-400 dark:ring-yellow-500' },
}

const STATUS_LABELS: Record<string, string> = {
  'not_started': 'Not Started',
  'ready_to_start': 'Ready',
  'ai_working': 'AI Working',
  'human_working': 'Human Working',
  'ai_review': 'AI Reviewing',
  'human_review': 'Human Reviewing',
  'completed': 'Completed',
  'blocked': 'Blocked',
  'hand_raised': 'Hand Raised',
}

// Action-oriented labels for the transition dropdown (what the move DOES)
const TRANSITION_LABELS: Record<string, string> = {
  'ready_to_start': 'Set Ready to Start',
  'ai_working': 'Task to AI →',
  'human_working': 'Task to Human →',
  'ai_review': 'Send to AI for Review',
  'human_review': 'Send to Human for Review',
  'completed': 'Approve & Complete ✓',
  'blocked': 'Mark as Blocked ✗',
  'hand_raised': 'Raise Hand ✋',
}

const STATUS_ABBREV: Record<string, string> = {
  'not_started': '',
  'ready_to_start': 'RDY',
  'ai_working': 'AI',
  'human_working': 'HUM',
  'ai_review': 'REV',
  'human_review': 'REV',
  'completed': 'DONE',
  'blocked': 'BLK',
  'hand_raised': '✋',
}

// hand_raised + blocked are universally available from every other state so
// the player can always flag "I need help" or "I'm impeded" regardless of
// what cell they're in. Keep this in sync with VALID_TRANSITIONS in
// server/src/services/velocity.service.ts.
const VALID_TRANSITIONS: Record<string, string[]> = {
  'not_started':    ['ready_to_start', 'hand_raised', 'blocked'],
  'ready_to_start': ['ai_working', 'human_working', 'hand_raised', 'blocked'],
  'ai_working':     ['ai_review', 'human_review', 'blocked', 'hand_raised', 'human_working', 'ready_to_start'],
  'human_working':  ['ai_review', 'human_review', 'blocked', 'hand_raised', 'ai_working', 'ready_to_start'],
  'ai_review':      ['ai_working', 'human_working', 'completed', 'hand_raised', 'blocked'],
  'human_review':   ['ai_working', 'human_working', 'completed', 'hand_raised', 'blocked'],
  'blocked':        ['ready_to_start', 'ai_working', 'human_working', 'hand_raised'],
  'hand_raised':    ['ai_working', 'human_working', 'ai_review', 'human_review', 'blocked'],
  'completed':      ['ready_to_start', 'hand_raised', 'blocked'],
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const apiBase = import.meta.env.VITE_API_BASE_URL || '/api'
const loading = ref(true)
const rawData = ref<VelocityProject[]>([])
const searchQuery = ref('')

// Detail dialog
const dialogVisible = ref(false)
const selectedCell = ref<{ row: VelocityRow; step: StepData } | null>(null)
const turnHistory = ref<TurnEntry[]>([])
const turnLoading = ref(false)

// Action form
const moveStatus = ref('')
const moveActor = ref<'ai' | 'human'>('human')
const moveNotes = ref('')
const moveAttachments = ref<{ filename: string; url: string }[]>([])
const newAttachmentUrl = ref('')
const newAttachmentLabel = ref('')
const moveSubmitting = ref(false)

// Send back
const sendBackStep = ref('')
const sendBackNotes = ref('')
const sendingBack = ref(false)

// Module detail dialog
const moduleDialogVisible = ref(false)
const moduleDialogRow = ref<VelocityRow | null>(null)
const moduleDialogData = ref<Record<string, any> | null>(null)

async function openModuleDetail(row: VelocityRow) {
  moduleDialogRow.value = row
  moduleDialogVisible.value = true
  // Fetch full module data from project API
  try {
    const res = await api.get(`/projects/${row.pk_project}`)
    const mods = res.data?.data?.modules || []
    moduleDialogData.value = mods.find((m: any) => m.pk_module === row.pk_module) || null
  } catch {
    moduleDialogData.value = null
  }
}

function onModuleDialogRefresh() {
  // Reload velocity data for the module
  if (moduleDialogRow.value) {
    reloadModuleSteps(moduleDialogRow.value.pk_module,
      rawData.value.flatMap(p => p.modules).find(m => m.pk_module === moduleDialogRow.value!.pk_module)!)
  }
}

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

async function reloadAllData() {
  try {
    const res = await api.get('/velocity')
    const apiData = res.data?.data || {}
    const rows = apiData.steps || apiData || []
    const metricsArr: ModuleMetrics[] = apiData.metrics || []
    const metricsMap = new Map<string, ModuleMetrics>()
    for (const m of metricsArr) metricsMap.set(m.fk_mvm_module, m)

    // Bucket by pk_project (UUID), NOT project_name. Cloning inherits the
    // parent's name, so two distinct projects (parent + clone) often share a
    // name. Bucketing by name silently merged their modules into a single row.
    const projectMap = new Map<string, VelocityProject>()
    for (const row of rows) {
      const key = row.pk_project || row.fk_mv_module // fall back if pk_project is missing
      const moduleKey = row.fk_mv_module
      if (!projectMap.has(key)) {
        projectMap.set(key, {
          project_name: row.project_name,
          pk_project: row.pk_project || key,
          modules: [],
          fk_project_parent: row.fk_project_parent ?? null,
          project_version_label: row.project_version_label ?? null,
          project_cloned_from_name: row.project_cloned_from_name ?? null,
          project_is_locked: !!row.project_is_locked,
          project_locked_by: row.project_locked_by ?? null,
        })
      }
      const project = projectMap.get(key)!
      let mod = project.modules.find(m => m.pk_module === moduleKey)
      if (!mod) {
        mod = { module_name: row.module_name, pk_module: moduleKey, steps: [], metrics: metricsMap.get(moduleKey), is_mission_critical: row.module_is_mission_critical || row.project_is_mission_critical || false }
        project.modules.push(mod)
      }
      mod.steps.push({
        pk_module_velocity: row.pk_module_velocity,
        step_name: row.step_name,
        step_order: row.step_order,
        status: row.status,
        current_actor: row.current_actor,
        loop_count: row.loop_count,
        turn_count: row.turn_count || 0,
        is_locked: row.is_locked || false,
      })
    }
    for (const project of projectMap.values()) {
      for (const mod of project.modules) {
        mod.steps.sort((a: any, b: any) => a.step_order - b.step_order)
      }
    }
    rawData.value = Array.from(projectMap.values())
  } catch (e) {
    console.error('Failed to load velocity data:', e)
  }
}

onMounted(async () => {
  await reloadAllData()
  loading.value = false
  connectSSE()
})

// ---------------------------------------------------------------------------
// SSE: Real-time multiplayer updates
// ---------------------------------------------------------------------------
const connectedClients = ref(0)
let eventSource: EventSource | null = null

// Debounced full reload. Coalesces bursty SSE triggers (many lifecycle events,
// reconnect storms, cloned-project edits) into at most one reload per window.
// Why: when 100+ clients are watching the same board, an unguarded
// reloadAllData() from every SSE handler turns into N concurrent
// authenticated API calls per client per event — which has caused DB pool
// exhaustion and a self-reinforcing herd on App Service restarts.
const FULL_RELOAD_DEBOUNCE_MS = 60_000
let lastFullReloadAt = 0
let pendingReloadTimer: ReturnType<typeof setTimeout> | null = null
function scheduleFullReload() {
  const now = Date.now()
  const since = now - lastFullReloadAt
  if (since >= FULL_RELOAD_DEBOUNCE_MS) {
    lastFullReloadAt = now
    reloadAllData()
    return
  }
  if (pendingReloadTimer) return
  pendingReloadTimer = setTimeout(() => {
    pendingReloadTimer = null
    lastFullReloadAt = Date.now()
    reloadAllData()
  }, FULL_RELOAD_DEBOUNCE_MS - since)
}

function connectSSE() {
  const baseUrl = import.meta.env.VITE_API_BASE_URL || '/api'
  eventSource = new EventSource(`${baseUrl}/velocity/stream`)

  eventSource.addEventListener('connected', (e: MessageEvent) => {
    const data = JSON.parse(e.data)
    connectedClients.value = data.clients || 1
    // Intentionally do NOT auto-reload on reconnect. With many clients, a
    // synchronized reconnect after a server restart fans into a herd of
    // authenticated API calls that exhausts the DB pool. Events broadcast
    // during a brief disconnect window will be missed; the unknown-moduleId
    // fallback below self-heals once events resume flowing.
  })

  eventSource.addEventListener('clients', (e: MessageEvent) => {
    const data = JSON.parse(e.data)
    connectedClients.value = data.count || 1
  })

  eventSource.addEventListener('move', (e: MessageEvent) => {
    const data = JSON.parse(e.data)
    // Update the local step state without full reload
    let matched = false
    for (const project of rawData.value) {
      for (const mod of project.modules) {
        if (mod.pk_module === data.moduleId) {
          matched = true
          const step = mod.steps.find((s: StepData) => s.step_name === data.stepName)
          if (step) {
            step.status = data.updatedStep?.status || data.toStatus
            step.current_actor = data.updatedStep?.current_actor || data.actor
            step.loop_count = data.updatedStep?.loop_count ?? step.loop_count
            step.turn_count = (step.turn_count || 0) + 1
          }
          // If step completed, auto-advance next step
          if (data.toStatus === 'completed') {
            const nextStep = mod.steps.find((s: StepData) => s.step_order === (step?.step_order || 0) + 1)
            if (nextStep && nextStep.status === 'not_started') {
              nextStep.status = 'ready_to_start'
            }
          }
          // Update metrics if available
          if (mod.metrics && data.updatedStep) {
            mod.metrics.total_turns = (mod.metrics.total_turns || 0) + 1
          }
        }
      }
    }
    // Fallback — moduleId not on this board yet (e.g. a project was cloned
    // after the board loaded, or rawData drifted). Refetch so the cell can't
    // stay stale. This is the safety net that makes the system self-healing.
    if (!matched) {
      console.debug('[velocity SSE] move for unknown moduleId — scheduling debounced reload', data.moduleId, data.stepName)
      scheduleFullReload()
    }
    // If the detail dialog is open for this step, refresh the turn history
    if (selectedCell.value && selectedCell.value.row.pk_module === data.moduleId && selectedCell.value.step.step_name === data.stepName) {
      refreshTurnHistory()
    }
  })

  eventSource.addEventListener('note', (e: MessageEvent) => {
    const data = JSON.parse(e.data)
    // If viewing this step's detail, refresh turns
    if (selectedCell.value && selectedCell.value.row.pk_module === data.moduleId && selectedCell.value.step.step_name === data.stepName) {
      refreshTurnHistory()
    }
  })

  eventSource.addEventListener('send_back', (e: MessageEvent) => {
    const data = JSON.parse(e.data)
    // Send-back affects multiple steps — reload all data for this module
    let matched = false
    for (const project of rawData.value) {
      for (const mod of project.modules) {
        if (mod.pk_module === data.moduleId) {
          matched = true
          reloadModuleSteps(data.moduleId, mod)
        }
      }
    }
    if (!matched) {
      console.debug('[velocity SSE] send_back for unknown moduleId — scheduling debounced reload', data.moduleId)
      scheduleFullReload()
    }
  })

  eventSource.addEventListener('lock', (e: MessageEvent) => {
    const data = JSON.parse(e.data)
    let matched = false
    for (const project of rawData.value) {
      for (const mod of project.modules) {
        if (mod.pk_module === data.moduleId) {
          matched = true
          const step = mod.steps.find((s: StepData) => s.step_name === data.stepName)
          if (step) step.is_locked = data.locked
        }
      }
    }
    if (!matched) {
      console.debug('[velocity SSE] lock for unknown moduleId — scheduling debounced reload', data.moduleId, data.stepName)
      scheduleFullReload()
    }
  })

  // Project/module lifecycle events — debounced board reload (every connected
  // client sees the same event; a hard reload from each one is a herd vector).
  eventSource.addEventListener('project_created', () => { scheduleFullReload() })
  eventSource.addEventListener('project_updated', () => { scheduleFullReload() })
  eventSource.addEventListener('project_deleted', () => { scheduleFullReload() })
  eventSource.addEventListener('module_created', () => { scheduleFullReload() })
  eventSource.addEventListener('module_updated', () => { scheduleFullReload() })
  eventSource.addEventListener('module_deleted', () => { scheduleFullReload() })

  eventSource.onerror = () => {
    // Reconnect with jittered backoff (5–8 s) so simultaneously disconnected
    // clients don't all hit the server in the same instant after a restart.
    // Previous 1 s value, combined with an auto-reload-on-connect, caused a
    // thundering-herd DB pool exhaustion on App Service restarts.
    eventSource?.close()
    const delay = 5000 + Math.floor(Math.random() * 3000)
    setTimeout(connectSSE, delay)
  }
}

async function refreshTurnHistory() {
  if (!selectedCell.value) return
  try {
    const res = await api.get(`/velocity/modules/${selectedCell.value.row.pk_module}/steps/${selectedCell.value.step.step_name}/turns`)
    turnHistory.value = res.data?.data || []
  } catch { /* silent */ }
}

async function reloadModuleSteps(moduleId: string, mod: VelocityModule) {
  try {
    const res = await api.get(`/velocity/modules/${moduleId}`)
    const steps = res.data?.data || []
    if (Array.isArray(steps) && steps.length > 0) {
      mod.steps = steps.map((s: any) => ({
        pk_module_velocity: s.pk_module_velocity,
        step_name: s.step_name,
        step_order: s.step_order,
        status: s.status,
        current_actor: s.current_actor,
        loop_count: s.loop_count,
        turn_count: s.turn_count || 0,
        is_locked: s.is_locked || false,
      })).sort((a: any, b: any) => a.step_order - b.step_order)
    }
  } catch { /* silent */ }
}

onUnmounted(() => {
  eventSource?.close()
  eventSource = null
})

// ---------------------------------------------------------------------------
// Computed
// ---------------------------------------------------------------------------
const missionCriticalOnly = ref(false)

const rows = computed((): VelocityRow[] => {
  const result: VelocityRow[] = []
  for (const proj of rawData.value) {
    for (const mod of proj.modules) {
      result.push({
        project_name: proj.project_name,
        pk_project: proj.pk_project,
        module_name: mod.module_name,
        pk_module: mod.pk_module,
        steps: mod.steps,
        metrics: mod.metrics,
        is_mission_critical: mod.is_mission_critical,
        fk_project_parent: proj.fk_project_parent,
        project_version_label: proj.project_version_label,
        project_is_locked: proj.project_is_locked,
      })
    }
  }
  return result
})

const filteredRows = computed(() => {
  let result = rows.value

  if (missionCriticalOnly.value) {
    result = result.filter(r => r.is_mission_critical)
  }

  if (searchQuery.value) {
    const q = searchQuery.value.toLowerCase()
    result = result.filter(r =>
      r.project_name.toLowerCase().includes(q) ||
      r.module_name.toLowerCase().includes(q),
    )
  }

  return result
})

// Group rows by project for display
interface ProjectGroup {
  project_name: string
  pk_project: string
  modules: VelocityRow[]
  fk_project_parent: string | null
  project_version_label: string | null
  project_is_locked: boolean
}

const projectGroups = computed((): ProjectGroup[] => {
  const map = new Map<string, ProjectGroup>()
  for (const row of filteredRows.value) {
    if (!map.has(row.pk_project)) {
      map.set(row.pk_project, {
        project_name: row.project_name,
        pk_project: row.pk_project,
        modules: [],
        fk_project_parent: row.fk_project_parent,
        project_version_label: row.project_version_label,
        project_is_locked: row.project_is_locked,
      })
    }
    map.get(row.pk_project)!.modules.push(row)
  }
  return Array.from(map.values())
})

// Cluster grouping: bucket project groups by lineage (parent-id key OR self).
// A cluster header is shown when 2+ versions exist for the same parent.
interface ProjectCluster {
  rootId: string                // parent's UUID, or self if standalone
  rootName: string              // displayed name for the cluster header
  versions: ProjectGroup[]      // parent first (if present), then clones
}

const projectClusters = computed((): ProjectCluster[] => {
  // First pass: bucket by rootId
  const buckets = new Map<string, ProjectGroup[]>()
  for (const pg of projectGroups.value) {
    const rootId = pg.fk_project_parent || pg.pk_project
    if (!buckets.has(rootId)) buckets.set(rootId, [])
    buckets.get(rootId)!.push(pg)
  }
  // Second pass: build clusters with parent ordered first
  const clusters: ProjectCluster[] = []
  for (const [rootId, list] of buckets) {
    list.sort((a, b) => {
      // Parent (no fk_project_parent) sorts first
      if (!a.fk_project_parent && b.fk_project_parent) return -1
      if (a.fk_project_parent && !b.fk_project_parent) return 1
      return a.project_name.localeCompare(b.project_name)
    })
    const root = list.find(p => !p.fk_project_parent) || list[0]
    clusters.push({ rootId, rootName: root.project_name, versions: list })
  }
  return clusters
})

// Cluster expand/collapse state — collapsed by default when ≥3 versions
const expandedClusters = ref<Set<string>>(new Set())
function toggleCluster(rootId: string) {
  if (expandedClusters.value.has(rootId)) expandedClusters.value.delete(rootId)
  else expandedClusters.value.add(rootId)
}
function isClusterExpanded(c: ProjectCluster) {
  // Auto-expand singletons and 2-version clusters; collapse larger by default
  return c.versions.length <= 2 || expandedClusters.value.has(c.rootId)
}

const totalProjects = computed(() => {
  const set = new Set(filteredRows.value.map(r => r.pk_project))
  return set.size
})

const totalModules = computed(() => filteredRows.value.length)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function getStepForColumn(steps: StepData[], stepKey: string): StepData | null {
  return steps.find(s => s.step_name === stepKey) || null
}

function statusColor(status: string | undefined) {
  return STATUS_COLORS[status || 'not_started'] || STATUS_COLORS['not_started']
}

function isActiveStatus(status: string | undefined): boolean {
  const s = status || 'not_started'
  return STATUS_COLORS[s]?.pulse === true
}

function statusAbbrev(status: string | undefined): string {
  return STATUS_ABBREV[status || 'not_started'] || ''
}

function actorIcon(step: StepData | null): 'ai' | 'human' | null {
  if (!step) return null
  if (step.status === 'ai_working' || step.status === 'ai_review') return 'ai'
  if (step.status === 'human_working' || step.status === 'human_review') return 'human'
  return null
}

// ---------------------------------------------------------------------------
// Detail dialog
// ---------------------------------------------------------------------------
async function openCellDetail(row: VelocityRow, step: StepData) {
  selectedCell.value = { row, step }
  moveStatus.value = ''
  moveActor.value = 'human' // Always default to human — the person clicking is the actor
  moveNotes.value = ''
  moveAttachments.value = []
  newAttachmentUrl.value = ''
  newAttachmentLabel.value = ''
  sendBackStep.value = ''
  sendBackNotes.value = ''
  turnHistory.value = []
  dialogVisible.value = true

  // Fetch turn history
  turnLoading.value = true
  try {
    const res = await api.get(`/velocity/modules/${row.pk_module}/steps/${step.step_name}/turns`)
    turnHistory.value = res.data?.data || []
  } catch {
    turnHistory.value = []
  } finally {
    turnLoading.value = false
  }
}

const validTransitions = computed(() => {
  if (!selectedCell.value) return []
  const current = selectedCell.value.step.status
  return (VALID_TRANSITIONS[current] || []).map(s => ({
    label: TRANSITION_LABELS[s] || STATUS_LABELS[s] || s,
    value: s,
  }))
})

async function submitMove() {
  if (!selectedCell.value || !moveStatus.value) return
  moveSubmitting.value = true
  try {
    const res = await api.put(`/velocity/modules/${selectedCell.value.row.pk_module}/steps/${selectedCell.value.step.step_name}`, {
      status: moveStatus.value,
      actor: moveActor.value,
      content: moveNotes.value || undefined,
      attachments: moveAttachments.value.length > 0 ? moveAttachments.value : undefined,
    })

    // Update local state from response
    const updated = res.data?.data?.step || res.data?.data
    if (updated) {
      selectedCell.value.step.status = updated.status || moveStatus.value
      selectedCell.value.step.current_actor = updated.current_actor || moveActor.value
      selectedCell.value.step.loop_count = updated.loop_count ?? selectedCell.value.step.loop_count
    } else {
      selectedCell.value.step.status = moveStatus.value
      selectedCell.value.step.current_actor = moveActor.value
    }

    // Refresh history
    const histRes = await api.get(`/velocity/modules/${selectedCell.value.row.pk_module}/steps/${selectedCell.value.step.step_name}/turns`)
    turnHistory.value = histRes.data?.data || []

    moveStatus.value = ''
    moveNotes.value = ''
  } catch {
    // TODO: toast error
  } finally {
    moveSubmitting.value = false
  }
}

function formatTimestamp(ts: string): string {
  if (!ts) return ''
  const d = new Date(ts)
  return d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function addAttachment() {
  if (!newAttachmentUrl.value) return
  moveAttachments.value.push({ filename: newAttachmentLabel.value || newAttachmentUrl.value, url: newAttachmentUrl.value })
  newAttachmentUrl.value = ''
  newAttachmentLabel.value = ''
}

function removeAttachment(idx: number) { moveAttachments.value.splice(idx, 1) }

// Steps available to send back to (earlier completed or active steps)
const sendBackOptions = computed(() => {
  if (!selectedCell.value) return []
  const currentOrder = selectedCell.value.step.step_order
  // Only show earlier steps, and check that no locked step would be reset
  const earlierSteps = selectedCell.value.row.steps.filter(s => s.step_order < currentOrder)
  // Find the earliest locked step — can't send back past it
  const earliestLocked = selectedCell.value.row.steps.find(s => s.is_locked && s.step_order >= 1)
  return earlierSteps
    .filter(s => !earliestLocked || s.step_order >= earliestLocked.step_order)
    .map(s => ({
      label: `${STEP_LABELS[s.step_name] || s.step_name}${s.is_locked ? ' 🔒' : ''}`,
      value: s.step_name,
    }))
})

async function executeSendBack() {
  if (!selectedCell.value || !sendBackStep.value) return
  sendingBack.value = true
  try {
    await api.post(`/velocity/modules/${selectedCell.value.row.pk_module}/send-back`, {
      targetStep: sendBackStep.value,
      content: sendBackNotes.value || `Sent back to ${STEP_LABELS[sendBackStep.value] || sendBackStep.value}`,
      actor: 'human',
    })
    // Reload the whole page data since multiple steps changed
    window.location.reload()
  } catch { /* ignore */ }
  sendingBack.value = false
}

async function toggleStepLock() {
  if (!selectedCell.value) return
  const step = selectedCell.value.step
  try {
    await api.put(`/velocity/modules/${selectedCell.value.row.pk_module}/steps/${step.step_name}/lock`, {
      locked: !step.is_locked,
    })
    step.is_locked = !step.is_locked
  } catch { /* ignore */ }
}

function turnActorLabel(turn: TurnEntry): string {
  if (turn.turn_actor === 'ai') {
    return turn.turn_api_key_id ? 'AI (API)' : 'AI'
  }
  if (turn.turn_user_email) return turn.turn_user_name || turn.turn_user_email
  if (turn.turn_user_name) return turn.turn_user_name
  return 'Human'
}

function formatDuration(seconds: number): string {
  if (!seconds || seconds <= 0) return '0m'
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (h < 24) return m > 0 ? `${h}h ${m}m` : `${h}h`
  const d = Math.floor(h / 24)
  return `${d}d ${h % 24}h`
}
</script>

<template>
  <div class="min-h-screen pt-8 px-4 md:px-8">
    <div class="max-w-screen-2xl mx-auto">
      <!-- Header -->
      <div class="mb-8">
        <div class="flex items-start justify-between">
          <div>
            <h1 class="text-3xl font-jakarta font-bold text-slate-900 dark:text-white mb-2 flex items-center gap-3">
              <Play class="w-8 h-8 text-indigo-600" />
              Velocity
            </h1>
            <p class="text-slate-500 dark:text-slate-400 font-geist">
              Step-level heatmap across all projects and modules.
          <span v-if="!loading" class="text-slate-400">
            {{ totalProjects }} projects &middot; {{ totalModules }} modules
          </span>
          <span v-if="connectedClients > 0" class="inline-flex items-center gap-1.5 ml-3 text-xs font-geist px-2 py-0.5 rounded-full bg-emerald-50 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400">
            <span class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
            {{ connectedClients }} live
          </span>
        </p>
        <p class="text-xs text-slate-400 dark:text-slate-500 font-geist mt-1">
          Open projects (no members) allow any runner+ to play.
          Claimed projects require membership — non-members get 403 NOT_A_MEMBER. Admins must add themselves to play.
        </p>
          </div>
        </div>
      </div>

      <!-- Search -->
      <div class="flex flex-wrap items-center gap-3 mb-6">
        <div class="relative flex-1 min-w-[200px] max-w-md">
          <Search class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
          <InputText v-model="searchQuery" placeholder="Search projects, modules..." class="w-full !pl-9" />
        </div>
        <Button
          v-if="searchQuery"
          severity="secondary"
          size="small"
          outlined
          @click="searchQuery = ''"
        >
          <template #icon><X class="w-3.5 h-3.5 mr-1" /></template>
          Clear
        </Button>
        <label class="flex items-center gap-2 text-xs font-geist cursor-pointer px-3 py-2 rounded-lg border transition-colors"
          :class="missionCriticalOnly ? 'border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400' : 'border-slate-200 dark:border-slate-600 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800'"
        >
          <input type="checkbox" v-model="missionCriticalOnly" class="rounded accent-red-600" />
          Mission Critical
        </label>
        <div class="text-xs font-geist text-slate-400 dark:text-slate-500 ml-auto">
          {{ filteredRows.length }} modules
        </div>
      </div>

      <!-- Loading -->
      <div v-if="loading" class="text-center py-20 text-slate-400 font-geist">
        Loading velocity data...
      </div>

      <!-- Empty -->
      <div v-else-if="projectGroups.length === 0" class="text-center py-20 text-slate-400 font-geist">
        No data matches the current search.
      </div>

      <!-- Heatmap grid -->
      <div v-else class="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-700 overflow-hidden">
        <div class="overflow-x-auto">
          <table class="w-full border-collapse" style="min-width: 1000px">
            <thead>
              <tr class="bg-slate-50 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700">
                <th class="sticky left-0 z-10 bg-slate-50 dark:bg-slate-800 px-3 py-2 text-left text-[10px] font-geist font-semibold text-slate-600 dark:text-slate-400 uppercase tracking-wider border-r border-slate-200 dark:border-slate-700 w-[280px] min-w-[280px]">
                  Project / Module
                </th>
                <th
                  v-for="col in STEP_KEYS"
                  :key="col"
                  class="px-1 py-2 text-center text-[10px] font-geist font-semibold text-slate-600 dark:text-slate-400 uppercase tracking-wider border-r border-slate-100 dark:border-slate-700 min-w-[90px]"
                >
                  {{ STEP_LABELS[col] || col }}
                </th>
              </tr>
            </thead>
            <tbody>
              <template v-for="cluster in projectClusters" :key="cluster.rootId">
                <!-- Cluster header (only when ≥2 versions in lineage) -->
                <tr v-if="cluster.versions.length > 1" class="bg-violet-50/70 dark:bg-violet-950/30 border-b border-violet-200 dark:border-violet-800">
                  <td
                    class="sticky left-0 z-10 bg-violet-50/70 dark:bg-violet-950/30 px-3 py-1.5 border-r border-violet-200 dark:border-violet-800 cursor-pointer"
                    :colspan="1 + STEP_KEYS.length"
                    @click="toggleCluster(cluster.rootId)"
                  >
                    <span class="text-[10px] font-geist font-bold text-violet-800 dark:text-violet-200 uppercase tracking-wider">
                      ⤳ Cluster: {{ cluster.rootName }}
                    </span>
                    <span class="text-[10px] font-geist text-violet-600 dark:text-violet-300 ml-2">
                      {{ cluster.versions.length }} versions
                    </span>
                    <span class="text-[10px] font-geist text-violet-500 dark:text-violet-400 ml-2">
                      {{ isClusterExpanded(cluster) ? '▾ collapse' : '▸ expand' }}
                    </span>
                  </td>
                </tr>
              <template v-for="group in cluster.versions" :key="group.pk_project">
                <template v-if="cluster.versions.length === 1 || isClusterExpanded(cluster)">
                <!--
                  Project header row.
                  Parent: amber-tinted, crown icon, distinguishes the canonical version.
                  Clone:  violet-tinted, indented arrow, version label badge.
                -->
                <tr
                  class="border-b border-slate-100 dark:border-slate-700"
                  :class="!group.fk_project_parent
                    ? 'bg-amber-50/70 dark:bg-amber-950/30'
                    : 'bg-violet-50/50 dark:bg-violet-950/20'"
                >
                  <td
                    class="sticky left-0 z-10 px-3 py-1.5 border-r border-slate-200 dark:border-slate-700"
                    :class="!group.fk_project_parent
                      ? 'bg-amber-50/70 dark:bg-amber-950/30 border-l-4 border-l-amber-400'
                      : 'bg-violet-50/50 dark:bg-violet-950/20 border-l-4 border-l-violet-300'"
                    :colspan="1 + STEP_KEYS.length"
                  >
                    <!-- Crown for parents, ↳ for clones -->
                    <span v-if="!group.fk_project_parent" class="mr-1.5 inline-flex items-center text-amber-600 dark:text-amber-400" title="Parent / canonical version">👑</span>
                    <span v-else class="text-[10px] text-violet-500 dark:text-violet-400 mr-1.5">↳</span>

                    <router-link
                      :to="`/projects/${group.pk_project}`"
                      class="text-xs font-jakarta font-bold transition-colors"
                      :class="!group.fk_project_parent
                        ? 'text-amber-900 dark:text-amber-100 hover:text-amber-700 dark:hover:text-amber-200'
                        : 'text-violet-900 dark:text-violet-100 hover:text-violet-700 dark:hover:text-violet-200'"
                    >
                      {{ group.project_name }}
                    </router-link>

                    <span v-if="!group.fk_project_parent" class="text-[10px] font-geist font-bold text-amber-700 dark:text-amber-300 ml-2 px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/40 uppercase tracking-wider">
                      Parent
                    </span>
                    <span v-else class="text-[10px] font-geist font-semibold text-violet-700 dark:text-violet-300 ml-2 px-1.5 py-0.5 rounded bg-violet-100 dark:bg-violet-900/40 uppercase tracking-wider">
                      Clone
                    </span>

                    <span v-if="group.project_version_label" class="text-[10px] font-geist text-violet-700 dark:text-violet-300 ml-2 px-1.5 py-0.5 rounded bg-violet-100 dark:bg-violet-900/40">
                      {{ group.project_version_label }}
                    </span>
                    <span v-if="group.project_is_locked" class="text-[10px] font-geist text-rose-600 dark:text-rose-300 ml-2" title="Locked">🔒</span>
                    <span class="text-[10px] font-geist text-slate-500 dark:text-slate-400 ml-2">{{ group.modules.length }} module{{ group.modules.length !== 1 ? 's' : '' }}</span>
                  </td>
                </tr>
                <!-- Module rows — colored left border so within an expanded cluster
                     it's obvious which clone each module belongs to. -->
                <tr
                  v-for="mod in group.modules"
                  :key="mod.pk_module"
                  class="border-b border-slate-50 dark:border-slate-800 hover:bg-slate-50/50 dark:hover:bg-slate-800/50"
                >
                  <td
                    class="sticky left-0 z-10 bg-white dark:bg-slate-900 px-3 py-1 border-r border-slate-200 dark:border-slate-700"
                    :class="!group.fk_project_parent ? 'border-l-4 border-l-amber-200 dark:border-l-amber-700/50' : 'border-l-4 border-l-violet-200 dark:border-l-violet-800/50'"
                  >
                    <div :class="!group.fk_project_parent ? 'pl-3' : 'pl-6'">
                      <div class="flex items-center gap-2">
                        <span class="text-xs font-geist text-slate-600 dark:text-slate-300 truncate max-w-[160px] cursor-pointer hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors" @click.stop="openModuleDetail(mod)">{{ mod.module_name }}</span>
                        <span v-if="(mod.metrics as any)?.velocity_score" class="text-[9px] font-jakarta font-bold px-1.5 py-0.5 rounded bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400" :title="`Score: ${(mod.metrics as any).velocity_score} | Bonus: +${(mod.metrics as any).velocity_bonus || 0} | Penalty: -${(mod.metrics as any).velocity_penalty || 0}`">
                          <Target class="w-2.5 h-2.5 inline -mt-0.5" /> {{ (mod.metrics as any).velocity_score }}
                        </span>
                      </div>
                      <div v-if="mod.metrics" class="flex items-center gap-2 mt-0.5">
                        <span v-if="mod.metrics.total_turns > 0" class="text-[9px] font-geist text-slate-400 dark:text-slate-500" title="Total turns">{{ mod.metrics.total_turns }} turns</span>
                        <span v-if="mod.metrics.loopback_count > 0" class="text-[9px] font-geist text-amber-500 dark:text-amber-400 font-medium" title="Module-level loopbacks">{{ mod.metrics.loopback_count }} loopback{{ mod.metrics.loopback_count !== 1 ? 's' : '' }}</span>
                        <span v-if="mod.metrics.ai_time_seconds > 0" class="text-[9px] font-geist text-violet-500 dark:text-violet-400" title="AI time"><Bot class="w-2.5 h-2.5 inline" /> {{ formatDuration(mod.metrics.ai_time_seconds) }}</span>
                        <span v-if="mod.metrics.human_time_seconds > 0" class="text-[9px] font-geist text-blue-500 dark:text-blue-400" title="Human time"><User class="w-2.5 h-2.5 inline" /> {{ formatDuration(mod.metrics.human_time_seconds) }}</span>
                      </div>
                    </div>
                  </td>
                  <td
                    v-for="col in STEP_KEYS"
                    :key="col"
                    class="text-center p-0.5 border-r border-slate-50 dark:border-slate-800"
                  >
                    <div
                      class="h-9 rounded-sm flex items-center justify-center gap-0.5 transition-colors cursor-pointer hover:ring-2 hover:ring-indigo-300 dark:hover:ring-indigo-600"
                      :class="[
                        statusColor(getStepForColumn(mod.steps, col)?.status).bg,
                        statusColor(getStepForColumn(mod.steps, col)?.status).text,
                        statusColor(getStepForColumn(mod.steps, col)?.status).ring || '',
                        isActiveStatus(getStepForColumn(mod.steps, col)?.status) ? 'animate-pulse-soft' : '',
                      ]"
                      @click="getStepForColumn(mod.steps, col) && openCellDetail(mod, getStepForColumn(mod.steps, col)!)"
                    >
                      <!-- Lock icon -->
                      <svg v-if="getStepForColumn(mod.steps, col)?.is_locked" class="w-2.5 h-2.5 flex-shrink-0 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" /></svg>
                      <!-- Actor / Hand icon -->
                      <Hand v-if="getStepForColumn(mod.steps, col)?.status === 'hand_raised'" class="w-3 h-3 flex-shrink-0 text-yellow-700 dark:text-yellow-300" />
                      <Bot v-else-if="actorIcon(getStepForColumn(mod.steps, col)) === 'ai'" class="w-3 h-3 flex-shrink-0" />
                      <User v-else-if="actorIcon(getStepForColumn(mod.steps, col)) === 'human'" class="w-3 h-3 flex-shrink-0" />

                      <!-- Status abbreviation -->
                      <span class="text-[9px] font-geist font-medium leading-none">
                        {{ statusAbbrev(getStepForColumn(mod.steps, col)?.status) }}
                      </span>

                      <!-- Turn count (iterations) -->
                      <span
                        v-if="getStepForColumn(mod.steps, col) && getStepForColumn(mod.steps, col)!.turn_count > 0"
                        class="text-[8px] font-geist bg-white/50 rounded px-0.5 flex-shrink-0 leading-none"
                        :title="`${getStepForColumn(mod.steps, col)!.turn_count} turn(s), ${getStepForColumn(mod.steps, col)!.loop_count} review loop(s)`"
                      >
                        {{ getStepForColumn(mod.steps, col)!.turn_count }}<span v-if="getStepForColumn(mod.steps, col)!.loop_count > 0" class="text-amber-600">↺{{ getStepForColumn(mod.steps, col)!.loop_count }}</span>
                      </span>
                    </div>
                  </td>
                </tr>
                </template><!-- /v-if: cluster expanded -->
              </template><!-- /v-for: group in cluster.versions -->
              </template><!-- /v-for: cluster in projectClusters -->
            </tbody>
          </table>
        </div>

        <!-- Legend -->
        <div class="flex flex-wrap gap-3 px-4 py-3 border-t border-slate-100 dark:border-slate-700 bg-slate-50 dark:bg-slate-800">
          <div
            v-for="(colors, status) in STATUS_COLORS"
            :key="status"
            class="flex items-center gap-1.5 text-[10px] font-geist text-slate-500 dark:text-slate-400"
          >
            <div class="w-3 h-3 rounded-sm" :class="colors.bg"></div>
            {{ STATUS_LABELS[status] || status }}
          </div>
        </div>
      </div>

      <!-- Detail Dialog -->
      <Dialog
        v-model:visible="dialogVisible"
        :header="selectedCell ? `${selectedCell.row.module_name} — ${STEP_LABELS[selectedCell.step.step_name] || selectedCell.step.step_name}` : ''"
        modal
        :style="{ width: 'calc(100vw - 50px)', height: 'calc(100vh - 50px)' }"
        :breakpoints="{ '768px': '100vw' }"
        class="velocity-dialog"
        :contentStyle="{ overflow: 'auto', maxHeight: 'calc(100vh - 140px)' }"
      >
        <template v-if="selectedCell">
          <div class="grid md:grid-cols-2 gap-6">
            <!-- ═══ LEFT COLUMN: Status + History ═══ -->
            <div>
          <!-- Step info -->
          <div class="grid grid-cols-3 gap-3 mb-4">
            <div class="bg-slate-50 dark:bg-slate-800 rounded-lg p-3">
              <div class="text-[10px] font-geist text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-1">Status</div>
              <span
                class="text-xs font-geist font-semibold px-2 py-0.5 rounded-full"
                :class="[statusColor(selectedCell.step.status).bg, statusColor(selectedCell.step.status).text]"
              >
                {{ STATUS_LABELS[selectedCell.step.status] || selectedCell.step.status }}
              </span>
            </div>
            <div class="bg-slate-50 dark:bg-slate-800 rounded-lg p-3">
              <div class="text-[10px] font-geist text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-1">Current Actor</div>
              <div class="flex items-center gap-1.5 text-xs font-geist text-slate-700 dark:text-slate-200">
                <Bot v-if="selectedCell.step.current_actor === 'ai'" class="w-3.5 h-3.5 text-violet-600 dark:text-violet-400" />
                <User v-else class="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />
                {{ selectedCell.step.current_actor === 'ai' ? 'AI' : 'Human' }}
              </div>
            </div>
            <div class="bg-slate-50 dark:bg-slate-800 rounded-lg p-3">
              <div class="text-[10px] font-geist text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-1">Project</div>
              <router-link
                :to="`/projects/${selectedCell.row.pk_project}`"
                class="text-xs font-geist font-semibold text-indigo-600 hover:text-indigo-800"
                @click="dialogVisible = false"
              >
                {{ selectedCell.row.project_name }}
              </router-link>
            </div>
          </div>

          <!-- Lock toggle -->
          <div class="flex items-center justify-between mb-4 px-1">
            <button
              @click="toggleStepLock"
              class="flex items-center gap-2 text-xs font-geist px-3 py-1.5 rounded-lg border transition-colors"
              :class="selectedCell.step.is_locked
                ? 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
                : 'border-slate-200 text-slate-500 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-400 dark:hover:bg-slate-800'"
            >
              <svg v-if="selectedCell.step.is_locked" class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" /></svg>
              <svg v-else class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 11V7a4 4 0 118 0m-4 8v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2z" /></svg>
              {{ selectedCell.step.is_locked ? 'Locked — Protected from send-back' : 'Unlocked — Click to lock this step' }}
            </button>
          </div>

          <!-- Step + Module metrics -->
          <div class="grid grid-cols-5 gap-2 mb-4">
            <div class="bg-slate-50 dark:bg-slate-800 rounded-lg p-2 text-center">
              <div class="text-[9px] font-geist text-slate-400 dark:text-slate-500 uppercase mb-0.5">Turns</div>
              <div class="text-sm font-jakarta font-bold text-slate-800 dark:text-slate-100">{{ selectedCell.step.turn_count }}</div>
            </div>
            <div class="bg-slate-50 dark:bg-slate-800 rounded-lg p-2 text-center">
              <div class="text-[9px] font-geist text-slate-400 dark:text-slate-500 uppercase mb-0.5">Review Loops</div>
              <div class="text-sm font-jakarta font-bold" :class="selectedCell.step.loop_count > 0 ? 'text-amber-600' : 'text-slate-800'">{{ selectedCell.step.loop_count }}</div>
            </div>
            <div class="bg-slate-50 dark:bg-slate-800 rounded-lg p-2 text-center" v-if="selectedCell.row.metrics">
              <div class="text-[9px] font-geist text-slate-400 dark:text-slate-500 uppercase mb-0.5">Module Loopbacks</div>
              <div class="text-sm font-jakarta font-bold" :class="selectedCell.row.metrics.loopback_count > 0 ? 'text-red-600' : 'text-slate-800'">{{ selectedCell.row.metrics.loopback_count }}</div>
            </div>
            <div class="bg-slate-50 dark:bg-slate-800 rounded-lg p-2 text-center" v-if="selectedCell.row.metrics">
              <div class="text-[9px] font-geist text-violet-400 uppercase mb-0.5 flex items-center justify-center gap-0.5"><Bot class="w-2.5 h-2.5" /> AI Time</div>
              <div class="text-sm font-jakarta font-bold text-violet-700">{{ formatDuration(selectedCell.row.metrics.ai_time_seconds) }}</div>
            </div>
            <div class="bg-slate-50 dark:bg-slate-800 rounded-lg p-2 text-center" v-if="selectedCell.row.metrics">
              <div class="text-[9px] font-geist text-blue-400 uppercase mb-0.5 flex items-center justify-center gap-0.5"><User class="w-2.5 h-2.5" /> Human Time</div>
              <div class="text-sm font-jakarta font-bold text-blue-700">{{ formatDuration(selectedCell.row.metrics.human_time_seconds) }}</div>
            </div>
          </div>

          <!-- Turn history -->
          <div class="mb-4">
            <h3 class="text-sm font-jakarta font-bold text-slate-700 dark:text-slate-200 mb-3 flex items-center gap-2">
              <Clock class="w-4 h-4 text-slate-400" />
              Turn History
            </h3>
            <div v-if="turnLoading" class="text-center py-6 text-xs font-geist text-slate-400">Loading history...</div>
            <div v-else-if="turnHistory.length === 0" class="text-center py-6 text-xs font-geist text-slate-400 dark:text-slate-500 border border-dashed border-slate-200 dark:border-slate-700 rounded-lg">
              No turns yet. Make the first move to start the collaboration.
            </div>
            <div v-else class="space-y-3 max-h-[300px] overflow-y-auto pr-1">
              <div
                v-for="(turn, idx) in turnHistory"
                :key="idx"
                class="flex gap-3"
                :class="turn.turn_actor === 'ai' ? 'flex-row' : 'flex-row-reverse'"
              >
                <div class="w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0"
                  :class="turn.turn_actor === 'ai' ? 'bg-violet-100 dark:bg-violet-900/40' : 'bg-blue-100 dark:bg-blue-900/40'">
                  <Bot v-if="turn.turn_actor === 'ai'" class="w-3.5 h-3.5 text-violet-600 dark:text-violet-400" />
                  <User v-else class="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />
                </div>
                <div class="flex-1 rounded-lg px-3 py-2 max-w-[80%]"
                  :class="turn.turn_actor === 'ai' ? 'bg-violet-50 dark:bg-violet-900/20' : 'bg-blue-50 dark:bg-blue-900/20'">
                  <div class="flex items-center gap-2 mb-1 flex-wrap">
                    <span class="text-[10px] font-geist font-semibold" :class="turn.turn_actor === 'ai' ? 'text-violet-700 dark:text-violet-300' : 'text-blue-700 dark:text-blue-300'">
                      {{ turnActorLabel(turn) }}
                    </span>
                    <span v-if="turn.turn_api_key_id" class="text-[9px] font-geist px-1 py-0.5 rounded bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300">API</span>
                    <span v-if="turn.turn_action" class="text-[10px] font-geist text-slate-400">&middot; {{ turn.turn_action }}</span>
                  </div>
                  <div v-if="turn.turn_from_status || turn.turn_to_status" class="flex items-center gap-1 mb-1">
                    <span class="text-[9px] font-geist px-1.5 py-0.5 rounded-full" :class="[statusColor(turn.turn_from_status).bg, statusColor(turn.turn_from_status).text]">{{ STATUS_LABELS[turn.turn_from_status] || turn.turn_from_status }}</span>
                    <ArrowRight class="w-3 h-3 text-slate-300 dark:text-slate-600" />
                    <span class="text-[9px] font-geist px-1.5 py-0.5 rounded-full" :class="[statusColor(turn.turn_to_status).bg, statusColor(turn.turn_to_status).text]">{{ STATUS_LABELS[turn.turn_to_status] || turn.turn_to_status }}</span>
                  </div>
                  <p v-if="turn.turn_content" class="text-xs font-geist text-slate-600 dark:text-slate-300 whitespace-pre-wrap">{{ turn.turn_content }}</p>
                  <div v-if="turn.turn_attachments && turn.turn_attachments.length > 0" class="mt-1.5 space-y-1">
                    <a v-for="(att, ai) in turn.turn_attachments" :key="ai" :href="att.url" target="_blank" rel="noopener"
                      class="flex items-center gap-1.5 text-[10px] font-geist text-indigo-600 dark:text-indigo-400 hover:underline bg-indigo-50 dark:bg-indigo-900/20 px-2 py-1 rounded">
                      <svg class="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" /></svg>
                      {{ att.filename }}
                    </a>
                  </div>
                  <div class="text-[9px] font-geist text-slate-400 dark:text-slate-500 mt-1">{{ formatTimestamp(turn.created_at) }}</div>
                </div>
              </div>
            </div>
          </div>

            </div>
            <!-- ═══ RIGHT COLUMN: Actions ═══ -->
            <div>
          <!-- ── Quick Actions: Raise Hand & Block ──── -->
          <div v-if="selectedCell && (VALID_TRANSITIONS[selectedCell.step.status] || []).includes('hand_raised') || (VALID_TRANSITIONS[selectedCell?.step.status || ''] || []).includes('blocked')" class="mb-4">
            <h3 class="text-sm font-jakarta font-bold text-slate-700 dark:text-slate-200 mb-3 flex items-center gap-2">
              <Hand class="w-4 h-4 text-yellow-500" /> Signal Status
            </h3>
            <div class="flex gap-2">
              <button
                v-if="selectedCell && (VALID_TRANSITIONS[selectedCell.step.status] || []).includes('hand_raised')"
                @click="moveStatus = 'hand_raised'; submitMove()"
                class="flex-1 flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg border-2 border-yellow-300 dark:border-yellow-600 bg-yellow-50 dark:bg-yellow-900/20 text-yellow-800 dark:text-yellow-200 text-xs font-geist font-medium hover:bg-yellow-100 dark:hover:bg-yellow-900/40 transition-colors"
              >
                <Hand class="w-4 h-4" /> Raise Hand
              </button>
              <button
                v-if="selectedCell && (VALID_TRANSITIONS[selectedCell.step.status] || []).includes('blocked')"
                @click="moveStatus = 'blocked'; submitMove()"
                class="flex-1 flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg border-2 border-red-300 dark:border-red-600 bg-red-50 dark:bg-red-900/20 text-red-800 dark:text-red-200 text-xs font-geist font-medium hover:bg-red-100 dark:hover:bg-red-900/40 transition-colors"
              >
                <AlertTriangle class="w-4 h-4" /> Flag Blocked
              </button>
            </div>
            <p v-if="selectedCell?.step.status === 'hand_raised'" class="text-[10px] font-geist text-yellow-600 dark:text-yellow-400 mt-2">Hand is currently raised. Use "Make Move" below to resume work.</p>
          </div>

          <!-- ── Action: Make Move ──────────────────────── -->
          <div v-if="validTransitions.length > 0" class="mb-4">
            <h3 class="text-sm font-jakarta font-bold text-slate-700 dark:text-slate-200 mb-3 flex items-center gap-2">
              <ArrowRight class="w-4 h-4 text-slate-400" /> Make Move
            </h3>
            <div class="space-y-3">
              <div class="flex items-center gap-3">
                <div class="flex-1">
                  <label class="text-[10px] font-geist text-slate-400 dark:text-slate-500 uppercase tracking-wider block mb-1">New Status</label>
                  <Select v-model="moveStatus" :options="validTransitions" option-label="label" option-value="value" placeholder="Select transition..." class="w-full" />
                </div>
                <div class="w-36">
                  <label class="text-[10px] font-geist text-slate-400 dark:text-slate-500 uppercase tracking-wider block mb-1">Actor</label>
                  <div class="flex rounded-lg border border-slate-200 dark:border-slate-600 overflow-hidden">
                    <button class="flex-1 px-3 py-2 text-xs font-geist font-medium transition-colors flex items-center justify-center gap-1"
                      :class="moveActor === 'ai' ? 'bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300' : 'bg-white dark:bg-slate-800 text-slate-500 hover:bg-slate-50'"
                      @click="moveActor = 'ai'"><Bot class="w-3 h-3" /> AI</button>
                    <button class="flex-1 px-3 py-2 text-xs font-geist font-medium transition-colors flex items-center justify-center gap-1"
                      :class="moveActor === 'human' ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300' : 'bg-white dark:bg-slate-800 text-slate-500 hover:bg-slate-50'"
                      @click="moveActor = 'human'"><User class="w-3 h-3" /> Human</button>
                  </div>
                </div>
              </div>
              <div>
                <label class="text-[10px] font-geist text-slate-400 dark:text-slate-500 uppercase tracking-wider block mb-1">Notes / Instructions</label>
                <Textarea v-model="moveNotes" rows="2" class="w-full" placeholder="Add context, instructions for the next actor..." />
              </div>
              <!-- Attachments -->
              <div>
                <label class="text-[10px] font-geist text-slate-400 dark:text-slate-500 uppercase tracking-wider block mb-1">Evidence / Resource Links</label>
                <div v-if="moveAttachments.length > 0" class="space-y-1 mb-2">
                  <div v-for="(att, i) in moveAttachments" :key="i" class="flex items-center gap-2 text-xs font-geist bg-slate-50 dark:bg-slate-800 rounded px-2 py-1">
                    <svg class="w-3 h-3 text-indigo-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" /></svg>
                    <span class="text-slate-600 dark:text-slate-300 truncate flex-1" :title="att.url">{{ att.filename }}</span>
                    <button @click="removeAttachment(i)" class="text-slate-400 hover:text-red-500"><X class="w-3 h-3" /></button>
                  </div>
                </div>
                <div class="flex gap-2">
                  <InputText v-model="newAttachmentUrl" class="flex-1" placeholder="https://..." size="small" />
                  <InputText v-model="newAttachmentLabel" class="w-32" placeholder="Label" size="small" />
                  <Button size="small" severity="secondary" outlined @click="addAttachment" :disabled="!newAttachmentUrl">+</Button>
                </div>
              </div>
              <Button label="Make Move" :loading="moveSubmitting" :disabled="!moveStatus" @click="submitMove" class="w-full" />
            </div>
          </div>

          <!-- ── Action: Send Back ──────────────────────── -->
          <div v-if="sendBackOptions.length > 0 && selectedCell.step.status !== 'not_started'" class="border-t border-slate-200 dark:border-slate-700 pt-4 mt-2">
            <h3 class="text-sm font-jakarta font-bold text-amber-700 dark:text-amber-400 mb-3 flex items-center gap-2">
              <AlertTriangle class="w-4 h-4" /> Send Back to Earlier Step
            </h3>
            <p class="text-[11px] font-geist text-slate-500 dark:text-slate-400 mb-3">Send this module back to an earlier step. All steps after the target will be reset to "Not Started".</p>
            <div class="space-y-3">
              <Select v-model="sendBackStep" :options="sendBackOptions" option-label="label" option-value="value" placeholder="Select step to return to..." class="w-full" />
              <Textarea v-model="sendBackNotes" rows="2" class="w-full" placeholder="Reason for sending back..." />
              <Button label="Send Back" severity="warning" :loading="sendingBack" :disabled="!sendBackStep" @click="executeSendBack" class="w-full" />
            </div>
          </div>

          <!-- Completed state -->
          <div v-if="selectedCell.step.status === 'completed' && validTransitions.length === 0" class="border-t border-slate-100 dark:border-slate-700 pt-4">
            <div class="flex items-center gap-2 text-xs font-geist text-emerald-600 dark:text-emerald-400 justify-center py-2">
              <CheckCircle class="w-4 h-4" /> This step is completed and signed off.
            </div>
          </div>
            </div>
          </div>
        </template>
      </Dialog>

      <!-- ── Module Detail Dialog ──────────────────────── -->
      <ModuleDetailDialog
        v-if="moduleDialogRow"
        v-model:visible="moduleDialogVisible"
        :module-id="moduleDialogRow.pk_module"
        :project-id="moduleDialogRow.pk_project"
        :project-name="moduleDialogRow.project_name"
        :module-name="moduleDialogRow.module_name"
        :module-data="moduleDialogData"
        :can-edit="false"
        :velocity-steps="moduleDialogRow.steps"
        :velocity-metrics="(moduleDialogRow.metrics as any) || null"
        @refresh="onModuleDialogRefresh"
      />

      <!-- ── Quick Start Guide (visual) ──────────────────── -->
      <QuickStartGuide />

      <!-- ── Gameplay Guide (detailed reference) ─────────── -->
      <div class="mt-10 mb-8 bg-gradient-to-br from-slate-50 to-indigo-50/30 dark:from-slate-800 dark:to-indigo-950/20 rounded-2xl border border-slate-200 dark:border-slate-700 p-6 md:p-8">
        <div class="flex items-center justify-between mb-2">
          <h2 class="text-xl font-jakarta font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
            <Play class="w-6 h-6 text-indigo-600 dark:text-indigo-400" /> The Velocity Framework — Complete Guide
          </h2>
          <a
            :href="`${apiBase}/velocity/guide`"
            download="velocity-gameplay-guide.md"
            class="flex items-center gap-2 px-3 py-2 text-xs font-geist font-medium rounded-lg border border-slate-200 dark:border-slate-600 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors flex-shrink-0"
          >
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
            Download Guide + API Spec (.md)
          </a>
          <a
            :href="`${apiBase}/velocity/claude-md`"
            download="CLAUDE.md"
            class="flex items-center gap-2 px-3 py-2 text-xs font-geist font-medium rounded-lg border border-violet-200 dark:border-violet-600 text-violet-600 dark:text-violet-300 hover:bg-violet-50 dark:hover:bg-violet-900/20 transition-colors flex-shrink-0"
          >
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" /></svg>
            Download CLAUDE.md (AI Agent)
          </a>
        </div>
        <p class="text-sm font-geist text-slate-500 dark:text-slate-400 mb-8">Everything you need to know about tracking AI projects through an 8-step, turn-based human-AI collaboration system.</p>

        <!-- ═══ Section 1: What is Velocity ═══ -->
        <div class="mb-8">
          <h3 class="text-base font-jakarta font-bold text-slate-900 dark:text-slate-100 mb-3 flex items-center gap-2 border-b border-slate-200 dark:border-slate-700 pb-2">
            <svg class="w-5 h-5 text-indigo-500 dark:text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
            What is Velocity?
          </h3>
          <div class="text-sm font-geist text-slate-600 dark:text-slate-300 space-y-3">
            <p>Velocity is a <strong class="text-slate-800 dark:text-slate-100">Snakes &amp; Ladders board game</strong> for human-AI collaboration. Each module is its own board with 8 sequential squares. <span class="font-semibold text-blue-600 dark:text-blue-400">Humans</span> and <span class="font-semibold text-violet-600 dark:text-violet-400">AI agents</span> take turns moving forward — one square at a time, one actor at a time. You cannot jump ahead.</p>
            <p><strong class="text-slate-800 dark:text-slate-100">Snakes</strong> pull you back: rejections loop you on the current square (-30 pts), send-backs slide you down multiple squares (-50 pts). <strong class="text-slate-800 dark:text-slate-100">Ladders</strong> push you forward: a perfect completion (zero loops, both actors aligned) auto-advances the next square (+15 bonus). The score measures <em>collaboration quality</em> — a perfect run means the human and AI understood each other at every handoff.</p>
            <div class="grid md:grid-cols-3 gap-3 mt-4">
              <div class="p-3 bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700">
                <div class="text-xs font-jakarta font-bold text-indigo-600 dark:text-indigo-400 mb-1">Sequential</div>
                <p class="text-[11px] text-slate-500 dark:text-slate-400">One square at a time. You can't start square 5 until square 4 is done. One actor holds the clock — no concurrent edits, no ambiguity.</p>
              </div>
              <div class="p-3 bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700">
                <div class="text-xs font-jakarta font-bold text-emerald-600 dark:text-emerald-400 mb-1">Evidence-Based</div>
                <p class="text-[11px] text-slate-500 dark:text-slate-400">Every move can include notes, links, and attachments. Reviewers assess evidence, not promises. Approvals are earned by showing work.</p>
              </div>
              <div class="p-3 bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700">
                <div class="text-xs font-jakarta font-bold text-amber-600 dark:text-amber-400 mb-1">Fully Auditable</div>
                <p class="text-[11px] text-slate-500 dark:text-slate-400">Every turn records who, what, when, and why. Human moves show email. AI moves show API key. Full traceability from start to deploy.</p>
              </div>
            </div>
          </div>
        </div>

        <!-- ═══ Section 2: The 8 Steps ═══ -->
        <div class="mb-8">
          <h3 class="text-base font-jakarta font-bold text-slate-900 dark:text-slate-100 mb-3 flex items-center gap-2 border-b border-slate-200 dark:border-slate-700 pb-2">
            <svg class="w-5 h-5 text-sky-500 dark:text-sky-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" /></svg>
            The 8 Steps
          </h3>
          <p class="text-sm font-geist text-slate-500 dark:text-slate-400 mb-4">Every module progresses through these steps in order. Each step must be completed and approved before the next one can begin.</p>
          <div class="grid md:grid-cols-2 gap-3">
            <div class="p-3 bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700">
              <div class="flex items-center gap-2 mb-1">
                <span class="w-5 h-5 rounded-full bg-indigo-100 dark:bg-indigo-900/40 text-indigo-600 dark:text-indigo-400 flex items-center justify-center text-[10px] font-bold font-jakarta">1</span>
                <span class="text-xs font-jakarta font-bold text-slate-800 dark:text-slate-200">Requirements</span>
              </div>
              <p class="text-[11px] font-geist text-slate-500 dark:text-slate-400">Define what needs to be built. Evidence: user stories, acceptance criteria, scope documents, stakeholder sign-off notes.</p>
            </div>
            <div class="p-3 bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700">
              <div class="flex items-center gap-2 mb-1">
                <span class="w-5 h-5 rounded-full bg-indigo-100 dark:bg-indigo-900/40 text-indigo-600 dark:text-indigo-400 flex items-center justify-center text-[10px] font-bold font-jakarta">2</span>
                <span class="text-xs font-jakarta font-bold text-slate-800 dark:text-slate-200">Planning</span>
              </div>
              <p class="text-[11px] font-geist text-slate-500 dark:text-slate-400">Break work into tasks and estimate effort. Evidence: task breakdowns, timelines, risk assessments, dependency maps.</p>
            </div>
            <div class="p-3 bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700">
              <div class="flex items-center gap-2 mb-1">
                <span class="w-5 h-5 rounded-full bg-indigo-100 dark:bg-indigo-900/40 text-indigo-600 dark:text-indigo-400 flex items-center justify-center text-[10px] font-bold font-jakarta">3</span>
                <span class="text-xs font-jakarta font-bold text-slate-800 dark:text-slate-200">Architecture</span>
              </div>
              <p class="text-[11px] font-geist text-slate-500 dark:text-slate-400">Design the technical solution. Evidence: system diagrams, data models, API contracts, technology choices with rationale.</p>
            </div>
            <div class="p-3 bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700">
              <div class="flex items-center gap-2 mb-1">
                <span class="w-5 h-5 rounded-full bg-indigo-100 dark:bg-indigo-900/40 text-indigo-600 dark:text-indigo-400 flex items-center justify-center text-[10px] font-bold font-jakarta">4</span>
                <span class="text-xs font-jakarta font-bold text-slate-800 dark:text-slate-200">Prototyping</span>
              </div>
              <p class="text-[11px] font-geist text-slate-500 dark:text-slate-400">Build a proof-of-concept or wireframes. Evidence: clickable prototype links, mockup screenshots, feasibility test results.</p>
            </div>
            <div class="p-3 bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700">
              <div class="flex items-center gap-2 mb-1">
                <span class="w-5 h-5 rounded-full bg-indigo-100 dark:bg-indigo-900/40 text-indigo-600 dark:text-indigo-400 flex items-center justify-center text-[10px] font-bold font-jakarta">5</span>
                <span class="text-xs font-jakarta font-bold text-slate-800 dark:text-slate-200">Development</span>
              </div>
              <p class="text-[11px] font-geist text-slate-500 dark:text-slate-400">Write the production code. Evidence: pull request links, test results, code review approvals, deployment configs.</p>
            </div>
            <div class="p-3 bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700">
              <div class="flex items-center gap-2 mb-1">
                <span class="w-5 h-5 rounded-full bg-indigo-100 dark:bg-indigo-900/40 text-indigo-600 dark:text-indigo-400 flex items-center justify-center text-[10px] font-bold font-jakarta">6</span>
                <span class="text-xs font-jakarta font-bold text-slate-800 dark:text-slate-200">User Testing</span>
              </div>
              <p class="text-[11px] font-geist text-slate-500 dark:text-slate-400">Validate with real users. Evidence: testing session recordings, feedback summaries, bug reports, usability scores.</p>
            </div>
            <div class="p-3 bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700">
              <div class="flex items-center gap-2 mb-1">
                <span class="w-5 h-5 rounded-full bg-indigo-100 dark:bg-indigo-900/40 text-indigo-600 dark:text-indigo-400 flex items-center justify-center text-[10px] font-bold font-jakarta">7</span>
                <span class="text-xs font-jakarta font-bold text-slate-800 dark:text-slate-200">User Acceptance</span>
              </div>
              <p class="text-[11px] font-geist text-slate-500 dark:text-slate-400">Formal sign-off from stakeholders. Evidence: UAT sign-off documents, acceptance criteria checklist, stakeholder approval emails.</p>
            </div>
            <div class="p-3 bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700">
              <div class="flex items-center gap-2 mb-1">
                <span class="w-5 h-5 rounded-full bg-indigo-100 dark:bg-indigo-900/40 text-indigo-600 dark:text-indigo-400 flex items-center justify-center text-[10px] font-bold font-jakarta">8</span>
                <span class="text-xs font-jakarta font-bold text-slate-800 dark:text-slate-200">Deployment</span>
              </div>
              <p class="text-[11px] font-geist text-slate-500 dark:text-slate-400">Ship to production. Evidence: deployment logs, monitoring dashboards, rollback plan, go-live confirmation.</p>
            </div>
          </div>
        </div>

        <!-- ═══ Section 3: Turn-Based Collaboration ═══ -->
        <div class="mb-8">
          <h3 class="text-base font-jakarta font-bold text-slate-900 dark:text-slate-100 mb-3 flex items-center gap-2 border-b border-slate-200 dark:border-slate-700 pb-2">
            <Clock class="w-5 h-5 text-amber-500 dark:text-amber-400" />
            Snakes &amp; Ladders with a Chess Clock
          </h3>
          <div class="grid md:grid-cols-2 gap-4 text-sm font-geist text-slate-600 dark:text-slate-300">
            <div>
              <p class="mb-3">The game is <strong class="text-slate-800 dark:text-slate-100">Snakes &amp; Ladders</strong> — one square at a time, snakes pull you back, ladders push you forward. But unlike the board game, there's a <strong class="text-slate-800 dark:text-slate-100">chess clock</strong> running. Every second that a square is in someone's hands is tracked.</p>
              <p class="mb-3">When the AI picks up a square, the <span class="font-semibold text-violet-600 dark:text-violet-400">AI clock</span> starts ticking. When it passes to a human for review, the <span class="font-semibold text-blue-600 dark:text-blue-400">Human clock</span> starts. The module sidebar shows cumulative time for each actor — so you can see at a glance if one side is bottlenecking.</p>
              <p class="mb-3">This creates <strong class="text-slate-800 dark:text-slate-100">clear accountability</strong>. There is never ambiguity about whose turn it is or how long they've had it. If a square has been in "Human Review" for 3 days, the board shows it. If the AI is averaging 20 minutes per square while the human averages 2 days, the imbalance is visible.</p>
              <div class="p-3 bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700">
                <p class="text-[11px] text-slate-500 dark:text-slate-400"><strong class="text-slate-700 dark:text-slate-200">Why the clock matters:</strong> In traditional project management, tasks get stuck in limbo — owned by nobody, waiting on unclear dependencies. The chess clock eliminates this. If a cell is pulsing purple, AI has the clock right now. If pulsing blue, a human has it. The timer shows how long. No more "I thought you were handling it."</p>
              </div>
            </div>
            <div>
              <div class="space-y-2 text-xs">
                <div class="flex items-center gap-2"><div class="w-6 h-4 rounded-sm bg-slate-100 dark:bg-slate-700"></div> <strong class="text-slate-700 dark:text-slate-200">Grey</strong> <span class="text-slate-500 dark:text-slate-400">— Not started yet</span></div>
                <div class="flex items-center gap-2"><div class="w-6 h-4 rounded-sm bg-sky-100 dark:bg-sky-900/40"></div> <strong class="text-slate-700 dark:text-slate-200">Light Blue</strong> <span class="text-slate-500 dark:text-slate-400">— Ready to start, waiting for pickup</span></div>
                <div class="flex items-center gap-2"><div class="w-6 h-4 rounded-sm bg-violet-200 dark:bg-violet-800/50 animate-pulse"></div> <strong class="text-slate-700 dark:text-slate-200">Purple (pulsing)</strong> <span class="text-slate-500 dark:text-slate-400">— AI is actively working</span></div>
                <div class="flex items-center gap-2"><div class="w-6 h-4 rounded-sm bg-blue-200 dark:bg-blue-800/50 animate-pulse"></div> <strong class="text-slate-700 dark:text-slate-200">Blue (pulsing)</strong> <span class="text-slate-500 dark:text-slate-400">— Human is actively working</span></div>
                <div class="flex items-center gap-2"><div class="w-6 h-4 rounded-sm bg-violet-100 dark:bg-violet-900/40"></div> <strong class="text-slate-700 dark:text-slate-200">Light Purple</strong> <span class="text-slate-500 dark:text-slate-400">— Awaiting AI review</span></div>
                <div class="flex items-center gap-2"><div class="w-6 h-4 rounded-sm bg-blue-100 dark:bg-blue-900/40"></div> <strong class="text-slate-700 dark:text-slate-200">Light Blue</strong> <span class="text-slate-500 dark:text-slate-400">— Awaiting Human review</span></div>
                <div class="flex items-center gap-2"><div class="w-6 h-4 rounded-sm bg-emerald-100 dark:bg-emerald-900/40"></div> <strong class="text-slate-700 dark:text-slate-200">Green</strong> <span class="text-slate-500 dark:text-slate-400">— Completed and signed off</span></div>
                <div class="flex items-center gap-2"><div class="w-6 h-4 rounded-sm bg-yellow-100 dark:bg-yellow-900/40 ring-2 ring-yellow-400 animate-pulse"></div> <strong class="text-slate-700 dark:text-slate-200">Yellow (pulsing, yellow ring)</strong> <span class="text-slate-500 dark:text-slate-400">— Hand Raised (needs help, no penalty)</span></div>
                <div class="flex items-center gap-2"><div class="w-6 h-4 rounded-sm bg-red-100 dark:bg-red-900/40 ring-2 ring-red-400"></div> <strong class="text-slate-700 dark:text-slate-200">Red (red ring)</strong> <span class="text-slate-500 dark:text-slate-400">— Blocked (stalled, -10 pts penalty)</span></div>
              </div>
              <div class="mt-3 p-2 bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700">
                <p class="text-[11px] text-slate-500 dark:text-slate-400"><strong class="text-slate-700 dark:text-slate-200">Cell numbers:</strong> The first number shows <strong>turns taken</strong>. The <span class="text-amber-600 dark:text-amber-400">↺</span> symbol shows <strong>review loops</strong> (reject-rework cycles). High loop counts signal rework — a sign that earlier evidence was insufficient.</p>
              </div>
            </div>
          </div>
        </div>

        <!-- ═══ Section 4: Making Moves ═══ -->
        <div class="mb-8">
          <h3 class="text-base font-jakarta font-bold text-slate-900 dark:text-slate-100 mb-3 flex items-center gap-2 border-b border-slate-200 dark:border-slate-700 pb-2">
            <ArrowRight class="w-5 h-5 text-emerald-500 dark:text-emerald-400" />
            Making Moves
          </h3>
          <div class="text-sm font-geist text-slate-600 dark:text-slate-300">
            <ol class="space-y-3 text-xs list-decimal list-inside text-slate-500 dark:text-slate-400">
              <li><strong class="text-slate-700 dark:text-slate-200">Click a cell on the heatmap</strong> to open the step detail dialog. You will see the current status, actor, turn history, and all available actions.</li>
              <li><strong class="text-slate-700 dark:text-slate-200">Choose a transition</strong> from the "New Status" dropdown. Only valid transitions are shown — you cannot skip ahead or make illegal moves.</li>
              <li><strong class="text-slate-700 dark:text-slate-200">Select the actor</strong> (AI or Human) who will own the next turn. This determines who the clock transfers to.</li>
              <li><strong class="text-slate-700 dark:text-slate-200">Add notes</strong> with context, instructions, or rationale. Good notes reduce review loops and prevent misunderstandings.</li>
              <li><strong class="text-slate-700 dark:text-slate-200">Attach evidence links</strong> — URLs to documents, pull requests, design files, test results, or any artifact that supports the move. Click "+" to add multiple links.</li>
              <li><strong class="text-slate-700 dark:text-slate-200">Click "Make Move"</strong> to submit. The board updates in real-time for all connected users.</li>
            </ol>
            <div class="mt-4 p-3 bg-amber-50 dark:bg-amber-900/20 rounded-lg border border-amber-200 dark:border-amber-800">
              <p class="text-[11px] text-amber-800 dark:text-amber-300"><strong>Pro tip:</strong> The best moves include evidence. A move from "AI Working" to "Human Review" should include a link to the deliverable. A move from "Human Review" to "Completed" should reference what was checked. Evidence-rich projects complete faster because reviewers can approve with confidence.</p>
            </div>
          </div>
        </div>

        <!-- ═══ Section 5: Reviewing & Approving ═══ -->
        <div class="mb-8">
          <h3 class="text-base font-jakarta font-bold text-slate-900 dark:text-slate-100 mb-3 flex items-center gap-2 border-b border-slate-200 dark:border-slate-700 pb-2">
            <CheckCircle class="w-5 h-5 text-emerald-500 dark:text-emerald-400" />
            Reviewing and Approving
          </h3>
          <div class="grid md:grid-cols-2 gap-4 text-sm font-geist text-slate-600 dark:text-slate-300">
            <div>
              <h4 class="text-xs font-jakarta font-bold text-slate-800 dark:text-slate-200 mb-2">When to Approve</h4>
              <ul class="space-y-1.5 text-[11px] text-slate-500 dark:text-slate-400">
                <li class="flex items-start gap-1.5"><span class="text-emerald-500 mt-0.5">&#10003;</span> The deliverable meets the acceptance criteria defined in the Requirements step</li>
                <li class="flex items-start gap-1.5"><span class="text-emerald-500 mt-0.5">&#10003;</span> Evidence links are provided and the artifacts are accessible and complete</li>
                <li class="flex items-start gap-1.5"><span class="text-emerald-500 mt-0.5">&#10003;</span> Quality standards are met (no critical bugs, follows conventions, passes tests)</li>
                <li class="flex items-start gap-1.5"><span class="text-emerald-500 mt-0.5">&#10003;</span> The notes explain what was done and any decisions made</li>
              </ul>
              <p class="text-[11px] text-slate-500 dark:text-slate-400 mt-2">Approving transitions the step to <span class="px-1.5 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300 text-[10px]">Completed</span> and automatically advances the next step to <span class="px-1.5 py-0.5 rounded-full bg-sky-100 dark:bg-sky-900/40 text-sky-700 dark:text-sky-300 text-[10px]">Ready to Start</span>.</p>
            </div>
            <div>
              <h4 class="text-xs font-jakarta font-bold text-slate-800 dark:text-slate-200 mb-2">When to Reject</h4>
              <ul class="space-y-1.5 text-[11px] text-slate-500 dark:text-slate-400">
                <li class="flex items-start gap-1.5"><span class="text-red-500 mt-0.5">&#10007;</span> The deliverable does not meet acceptance criteria</li>
                <li class="flex items-start gap-1.5"><span class="text-red-500 mt-0.5">&#10007;</span> Evidence is missing, incomplete, or inaccessible</li>
                <li class="flex items-start gap-1.5"><span class="text-red-500 mt-0.5">&#10007;</span> Critical bugs, security issues, or quality gaps exist</li>
                <li class="flex items-start gap-1.5"><span class="text-red-500 mt-0.5">&#10007;</span> The work does not address feedback from previous review loops</li>
              </ul>
              <p class="text-[11px] text-slate-500 dark:text-slate-400 mt-2">Rejecting sends the step back to <span class="px-1.5 py-0.5 rounded-full bg-violet-200 dark:bg-violet-800/40 text-violet-800 dark:text-violet-300 text-[10px]">AI Working</span> or <span class="px-1.5 py-0.5 rounded-full bg-blue-200 dark:bg-blue-800/40 text-blue-800 dark:text-blue-300 text-[10px]">Human Working</span>. The <strong>loop count increments</strong>, signaling rework.</p>
            </div>
          </div>
        </div>

        <!-- ═══ Section 6: Loopbacks & Send-Backs ═══ -->
        <div class="mb-8">
          <h3 class="text-base font-jakarta font-bold text-slate-900 dark:text-slate-100 mb-3 flex items-center gap-2 border-b border-slate-200 dark:border-slate-700 pb-2">
            <AlertTriangle class="w-5 h-5 text-amber-500 dark:text-amber-400" />
            Loopbacks and Send-Backs
          </h3>
          <div class="grid md:grid-cols-2 gap-4 text-sm font-geist text-slate-600 dark:text-slate-300">
            <div>
              <h4 class="text-xs font-jakarta font-bold text-amber-700 dark:text-amber-400 mb-2">Review Loops (Within a Step)</h4>
              <p class="text-[11px] text-slate-500 dark:text-slate-400 mb-2">When a reviewer rejects work, the step goes back to "working" status and the <strong>step-level loop count</strong> increments. The ↺ number in the cell shows how many reject-rework cycles have occurred.</p>
              <p class="text-[11px] text-slate-500 dark:text-slate-400">Loop counts are a health signal. A step with 0-1 loops is healthy. A step with 3+ loops indicates a systemic issue — unclear requirements, mismatched expectations, or insufficient evidence.</p>
            </div>
            <div>
              <h4 class="text-xs font-jakarta font-bold text-red-700 dark:text-red-400 mb-2">Send-Backs (Across Steps)</h4>
              <p class="text-[11px] text-slate-500 dark:text-slate-400 mb-2">A send-back is more severe than a review loop. It sends the entire module back to an earlier step. <strong>All intermediate steps are reset to "Not Started".</strong> The <strong>module-level loopback count</strong> increments.</p>
              <p class="text-[11px] text-slate-500 dark:text-slate-400 mb-2">Example: User Testing reveals a fundamental requirements gap. Send back to Requirements. Planning, Architecture, Prototyping, and Development all reset. This is expensive but sometimes necessary.</p>
              <div class="p-2 bg-red-50 dark:bg-red-900/20 rounded-lg border border-red-200 dark:border-red-800">
                <p class="text-[11px] text-red-700 dark:text-red-300"><strong>Locked steps are protected.</strong> If a step is locked, it cannot be reset by a send-back. Use locking to protect completed work you are confident about.</p>
              </div>
            </div>
          </div>
        </div>

        <!-- ═══ Section 7: Velocity Scoring ═══ -->
        <div class="mb-8">
          <h3 class="text-base font-jakarta font-bold text-slate-900 dark:text-slate-100 mb-3 flex items-center gap-2 border-b border-slate-200 dark:border-slate-700 pb-2">
            <svg class="w-5 h-5 text-yellow-500 dark:text-yellow-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" /></svg>
            Velocity Scoring
          </h3>
          <p class="text-sm font-geist text-slate-500 dark:text-slate-400 mb-4">Points are awarded for forward progress and penalized for rework and delays. Higher scores indicate efficient, evidence-driven collaboration.</p>
          <div class="overflow-x-auto">
            <table class="w-full text-xs font-geist border-collapse">
              <thead>
                <tr class="bg-slate-100 dark:bg-slate-800">
                  <th class="text-left px-3 py-2 text-slate-600 dark:text-slate-300 font-semibold border-b border-slate-200 dark:border-slate-700">Action</th>
                  <th class="text-center px-3 py-2 text-slate-600 dark:text-slate-300 font-semibold border-b border-slate-200 dark:border-slate-700">Points</th>
                  <th class="text-left px-3 py-2 text-slate-600 dark:text-slate-300 font-semibold border-b border-slate-200 dark:border-slate-700">Description</th>
                </tr>
              </thead>
              <tbody class="text-slate-600 dark:text-slate-400">
                <tr class="border-b border-slate-100 dark:border-slate-800">
                  <td class="px-3 py-2 font-medium text-slate-700 dark:text-slate-200">Complete Step (first time)</td>
                  <td class="px-3 py-2 text-center"><span class="px-2 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300 font-bold">+100</span></td>
                  <td class="px-3 py-2">Step reaches "Completed" for the first time. Full reward for getting it right.</td>
                </tr>
                <tr class="border-b border-slate-100 dark:border-slate-800 bg-amber-50/30 dark:bg-amber-900/5">
                  <td class="px-3 py-2 font-medium text-amber-700 dark:text-amber-400">Re-complete (rework)</td>
                  <td class="px-3 py-2 text-center"><span class="px-2 py-0.5 rounded-full bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 font-bold">+10</span></td>
                  <td class="px-3 py-2">Step re-completed after a send-back or rejection loop. Recovery credit only — no worker bonus, no alignment bonus. Rework always costs net points.</td>
                </tr>
                <tr class="border-b border-slate-100 dark:border-slate-800">
                  <td class="px-3 py-2 font-medium text-slate-700 dark:text-slate-200">Worker Contribution</td>
                  <td class="px-3 py-2 text-center"><span class="px-2 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300 font-bold">+50</span></td>
                  <td class="px-3 py-2">Other humans who contributed to the step (started work or submitted for review). First time only.</td>
                </tr>
                <tr class="border-b border-slate-100 dark:border-slate-800">
                  <td class="px-3 py-2 font-medium text-slate-700 dark:text-slate-200">Review Submitted (first time)</td>
                  <td class="px-3 py-2 text-center"><span class="px-2 py-0.5 rounded-full bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 font-bold">+20</span></td>
                  <td class="px-3 py-2">Submitting work for review on the first pass. No points on rework submissions.</td>
                </tr>
                <tr class="border-b border-slate-100 dark:border-slate-800">
                  <td class="px-3 py-2 font-medium text-slate-700 dark:text-slate-200">Step Started</td>
                  <td class="px-3 py-2 text-center"><span class="px-2 py-0.5 rounded-full bg-sky-100 dark:bg-sky-900/40 text-sky-700 dark:text-sky-300 font-bold">+10</span></td>
                  <td class="px-3 py-2">Picking up a step and starting work on it</td>
                </tr>
                <tr class="border-b border-slate-100 dark:border-slate-800">
                  <td class="px-3 py-2 font-medium text-slate-700 dark:text-slate-200">Reject / Rework</td>
                  <td class="px-3 py-2 text-center"><span class="px-2 py-0.5 rounded-full bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 font-bold">-30</span></td>
                  <td class="px-3 py-2">Step rejected during review and sent back for rework</td>
                </tr>
                <tr class="border-b border-slate-100 dark:border-slate-800">
                  <td class="px-3 py-2 font-medium text-slate-700 dark:text-slate-200">Send-Back</td>
                  <td class="px-3 py-2 text-center"><span class="px-2 py-0.5 rounded-full bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300 font-bold">-50/step</span></td>
                  <td class="px-3 py-2">Penalty scales with distance: 1 step back = -50, 3 steps back = -150. Resets intermediate steps.</td>
                </tr>
                <tr class="border-b border-slate-100 dark:border-slate-800">
                  <td class="px-3 py-2 font-medium text-slate-700 dark:text-slate-200">Blocked</td>
                  <td class="px-3 py-2 text-center"><span class="px-2 py-0.5 rounded-full bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300 font-bold">-10</span></td>
                  <td class="px-3 py-2">Step marked as blocked — a real impediment that prevents progress. Red ring + red background.</td>
                </tr>
                <tr class="border-b border-slate-100 dark:border-slate-800">
                  <td class="px-3 py-2 font-medium text-slate-700 dark:text-slate-200">Raise Hand ✋</td>
                  <td class="px-3 py-2 text-center"><span class="px-2 py-0.5 rounded-full bg-yellow-100 dark:bg-yellow-900/40 text-yellow-700 dark:text-yellow-300 font-bold">0</span></td>
                  <td class="px-3 py-2">Signal that help is needed without declaring a blocker. No penalty. Yellow pulsing ring. Lower hand to resume.</td>
                </tr>
                <tr>
                  <td class="px-3 py-2 font-medium text-slate-700 dark:text-slate-200">Module Loopback</td>
                  <td class="px-3 py-2 text-center"><span class="px-2 py-0.5 rounded-full bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300 font-bold">-50</span></td>
                  <td class="px-3 py-2">Reopening a completed step (completed → ready_to_start). The most expensive penalty.</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- ═══ Section 8: Locking Steps ═══ -->
        <div class="mb-8">
          <h3 class="text-base font-jakarta font-bold text-slate-900 dark:text-slate-100 mb-3 flex items-center gap-2 border-b border-slate-200 dark:border-slate-700 pb-2">
            <svg class="w-5 h-5 text-amber-500 dark:text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" /></svg>
            Locking Steps
          </h3>
          <div class="text-sm font-geist text-slate-600 dark:text-slate-300">
            <p class="mb-3">Once a step is completed and you are confident the work is solid, you can <strong class="text-slate-800 dark:text-slate-100">lock it</strong>. A locked step is protected from being reset by send-backs. This is useful when:</p>
            <ul class="space-y-1.5 text-[11px] text-slate-500 dark:text-slate-400 mb-3">
              <li class="flex items-start gap-1.5"><span class="text-amber-500">&#9670;</span> Requirements have been formally signed off and should not change</li>
              <li class="flex items-start gap-1.5"><span class="text-amber-500">&#9670;</span> Architecture decisions are foundational and reverting would be catastrophic</li>
              <li class="flex items-start gap-1.5"><span class="text-amber-500">&#9670;</span> Development is complete, tested, and deployed — you want to protect it from a late-stage send-back</li>
            </ul>
            <p class="text-[11px] text-slate-500 dark:text-slate-400">To lock or unlock: click a cell, then use the lock toggle button in the detail dialog. Locked steps show a lock icon on the heatmap.</p>
          </div>
        </div>

        <!-- ═══ Section 9: AI Agent Playbook (dynamic from openapi.yaml) ═══ -->
        <ApiPlaybook />

        <!-- AI Strategy Guidance -->
        <div class="mb-8 p-4 bg-violet-50 dark:bg-violet-900/20 rounded-xl border border-violet-200 dark:border-violet-800">
          <h4 class="text-xs font-jakarta font-bold text-violet-800 dark:text-violet-300 mb-2">AI Agent Strategy Guide</h4>
          <div class="space-y-2 text-[11px] font-geist text-violet-700 dark:text-violet-300">
            <p><strong>1. Read before you write.</strong> Always call GET on the turn history before making a move. Understand what the human asked for, what evidence was provided, and what previous reviewers flagged.</p>
            <p><strong>2. Evidence wins approvals.</strong> Every move should include attachments — links to documents, code, diagrams, test results. Moves without evidence get rejected, costing loop points.</p>
            <p><strong>3. Post progress updates.</strong> For long tasks, use the POST turns endpoint to share intermediate progress. This keeps the human informed and prevents premature send-backs.</p>
            <p><strong>4. Respect the state machine.</strong> Only valid transitions are allowed. <code class="text-[10px]">hand_raised</code> and <code class="text-[10px]">blocked</code> are universally available from every state for help/impediment signalling.</p>
            <p><strong>5. Send-backs are nuclear.</strong> Only use send-back when the issue is fundamental (wrong requirements, flawed architecture). For minor issues, reject and loop within the current step instead.</p>
            <p><strong>6. Check membership.</strong> Velocity writes require project membership on claimed projects. Hit <code class="text-[10px]">GET /projects/&#123;id&#125;/permissions</code> — <code class="text-[10px]">canMakeVelocityMoves</code> tells you if you can act before you waste a move.</p>
            <p><strong>7. Use If-Match + Idempotency-Key on every write.</strong> See the full chess-clock recipe in the downloadable CLAUDE.md.</p>
          </div>
        </div>

        <!-- ═══ Section 10: Multiplayer / SSE ═══ -->
        <div>
          <h3 class="text-base font-jakarta font-bold text-slate-900 dark:text-slate-100 mb-3 flex items-center gap-2 border-b border-slate-200 dark:border-slate-700 pb-2">
            <svg class="w-5 h-5 text-emerald-500 dark:text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" /></svg>
            Multiplayer — Real-Time Collaboration
          </h3>
          <div class="grid md:grid-cols-2 gap-4 text-sm font-geist text-slate-600 dark:text-slate-300">
            <div>
              <p class="mb-3">Velocity supports <strong class="text-slate-800 dark:text-slate-100">real-time multiplayer</strong> via Server-Sent Events (SSE). When any user or AI agent makes a move, all connected clients see the board update instantly — no page refresh needed.</p>
              <p class="mb-3 text-[11px] text-slate-500 dark:text-slate-400">The green "live" indicator in the header shows how many clients are connected. When a move, note, send-back, or lock event occurs, the board patches locally in real-time.</p>
              <div class="p-3 bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700">
                <h4 class="text-[11px] font-jakarta font-bold text-slate-700 dark:text-slate-200 mb-1">Event Types</h4>
                <ul class="space-y-1 text-[11px] text-slate-500 dark:text-slate-400">
                  <li><code class="text-indigo-600 dark:text-indigo-400">connected</code> — Sent once on initial connection with <code class="text-[10px]">{ clients: N }</code></li>
                  <li><code class="text-indigo-600 dark:text-indigo-400">clients</code> — Broadcast when any client joins/leaves with <code class="text-[10px]">{ count: N }</code></li>
                  <li><code class="text-indigo-600 dark:text-indigo-400">move</code> — Step status changed (includes moduleId, stepName, fromStatus, toStatus, action, actor, updatedStep, turn)</li>
                  <li><code class="text-indigo-600 dark:text-indigo-400">note</code> — Note added to a step (includes moduleId, stepName, turn)</li>
                  <li><code class="text-indigo-600 dark:text-indigo-400">send_back</code> — Module sent back to earlier step (includes moduleId, targetStepName, actor)</li>
                  <li><code class="text-indigo-600 dark:text-indigo-400">lock</code> — Step lock state changed (includes moduleId, stepName, locked)</li>
                </ul>
              </div>
            </div>
            <div>
              <p class="mb-3">Multiple humans and AI agents can work on <strong class="text-slate-800 dark:text-slate-100">different modules simultaneously</strong>. One human might be reviewing Architecture on Module A while an AI agent is working Development on Module B. The board shows all activity in real-time.</p>
              <div class="p-3 bg-emerald-50 dark:bg-emerald-900/20 rounded-lg border border-emerald-200 dark:border-emerald-800">
                <h4 class="text-[11px] font-jakarta font-bold text-emerald-700 dark:text-emerald-300 mb-1">SSE Endpoint for AI Agents</h4>
                <p class="text-[11px] text-emerald-600 dark:text-emerald-400 mb-2">AI agents can also subscribe to the SSE stream to react to events in real-time:</p>
                <div class="p-2 bg-white dark:bg-slate-900/40 rounded text-[11px] font-mono text-slate-600 dark:text-slate-400 overflow-x-auto">
                  <pre>curl -N -H "X-API-Key: velo_xxx" \
  https://velo.example.com/api/velocity/stream</pre>
                </div>
                <p class="text-[10px] text-emerald-500 dark:text-emerald-500 mt-1">The connection auto-reconnects after 5 seconds if dropped. Events are JSON-encoded with moduleId, stepName, and relevant data.</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
@keyframes pulse-soft {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.7; }
}
.animate-pulse-soft {
  animation: pulse-soft 2s ease-in-out infinite;
}
</style>
