<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import api from '@/lib/api'
import Dialog from 'primevue/dialog'
import Button from 'primevue/button'
import Select from 'primevue/select'
import Textarea from 'primevue/textarea'
import InputText from 'primevue/inputtext'
import {
  Bot, User, Clock, CheckCircle, AlertTriangle, ArrowRight, Play,
  FolderOpen, Target, Shield, X, Search, Hand,
} from 'lucide-vue-next'
import SharePointStepArtifacts from '@/components/sharepoint/SharePointStepArtifacts.vue'

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

interface VelocityMetrics {
  velocity_score: number
  velocity_bonus: number
  velocity_penalty: number
  loopback_count: number
  total_turns: number
  ai_time_seconds: number
  human_time_seconds: number
  alignment_count: number
  misalignment_count: number
}

// ---------------------------------------------------------------------------
// Props & Emits
// ---------------------------------------------------------------------------
const props = defineProps<{
  visible: boolean
  moduleId: string
  projectId: string
  projectName: string
  moduleName: string
  moduleData: Record<string, any> | null
  canEdit: boolean
  velocitySteps: StepData[] | null
  velocityMetrics: VelocityMetrics | null
}>()

const emit = defineEmits<{
  'update:visible': [value: boolean]
  'refresh': []
  'edit-module': []
}>()

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

const TRANSITION_LABELS: Record<string, string> = {
  'ready_to_start': 'Set Ready to Start',
  'ai_working': 'Task to AI',
  'human_working': 'Task to Human',
  'ai_review': 'Send to AI for Review',
  'human_review': 'Send to Human for Review',
  'completed': 'Approve & Complete',
  'blocked': 'Mark as Blocked',
  'hand_raised': 'Raise Hand ✋',
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
// Dialog visibility
// ---------------------------------------------------------------------------
const dialogOpen = computed({
  get: () => props.visible,
  set: (val: boolean) => emit('update:visible', val),
})

// ---------------------------------------------------------------------------
// Velocity step selection
// ---------------------------------------------------------------------------
const selectedStepName = ref<string | null>(null)
const selectedStep = computed(() => {
  if (!selectedStepName.value || !props.velocitySteps) return null
  return props.velocitySteps.find(s => s.step_name === selectedStepName.value) || null
})

// Turn history
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

// Reset state when dialog opens/closes
watch(() => props.visible, (val) => {
  if (!val) {
    selectedStepName.value = null
    turnHistory.value = []
    resetActionForm()
  }
})

function resetActionForm() {
  moveStatus.value = ''
  moveActor.value = 'human'
  moveNotes.value = ''
  moveAttachments.value = []
  newAttachmentUrl.value = ''
  newAttachmentLabel.value = ''
  sendBackStep.value = ''
  sendBackNotes.value = ''
}

// ---------------------------------------------------------------------------
// Computed helpers
// ---------------------------------------------------------------------------
const sortedSteps = computed(() => {
  if (!props.velocitySteps) return []
  return [...props.velocitySteps].sort((a, b) => a.step_order - b.step_order)
})

const completedStepsCount = computed(() => {
  if (!props.velocitySteps) return 0
  return props.velocitySteps.filter(s => s.status === 'completed').length
})

const moduleStatus = computed(() => {
  return props.moduleData?.module_status?.replace(/_/g, ' ') || 'Unknown'
})

const validTransitions = computed(() => {
  if (!selectedStep.value) return []
  const current = selectedStep.value.status
  return (VALID_TRANSITIONS[current] || []).map(s => ({
    label: TRANSITION_LABELS[s] || STATUS_LABELS[s] || s,
    value: s,
  }))
})

const sendBackOptions = computed(() => {
  if (!selectedStep.value || !props.velocitySteps) return []
  const currentOrder = selectedStep.value.step_order
  const earlierSteps = sortedSteps.value.filter(s => s.step_order < currentOrder)
  const earliestLocked = sortedSteps.value.find(s => s.is_locked && s.step_order >= 1)
  return earlierSteps
    .filter(s => !earliestLocked || s.step_order >= earliestLocked.step_order)
    .map(s => ({
      label: `${STEP_LABELS[s.step_name] || s.step_name}${s.is_locked ? ' (Locked)' : ''}`,
      value: s.step_name,
    }))
})

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------
function statusColor(status: string | undefined): { bg: string; text: string; pulse?: boolean; ring?: string } {
  return STATUS_COLORS[status || 'not_started'] || STATUS_COLORS['not_started']
}

function isActiveStatus(status: string | undefined): boolean {
  return STATUS_COLORS[status || 'not_started']?.pulse === true
}

function getStepForColumn(stepKey: string): StepData | null {
  if (!props.velocitySteps) return null
  return props.velocitySteps.find(s => s.step_name === stepKey) || null
}

function actorIcon(step: StepData | null): 'ai' | 'human' | null {
  if (!step) return null
  if (step.status === 'ai_working' || step.status === 'ai_review') return 'ai'
  if (step.status === 'human_working' || step.status === 'human_review') return 'human'
  return null
}

function formatTimestamp(ts: string): string {
  if (!ts) return ''
  const d = new Date(ts)
  return d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function formatDate(d: string | null | undefined): string {
  if (!d) return '--'
  return new Date(d).toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' })
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

function turnActorLabel(turn: TurnEntry): string {
  if (turn.turn_actor === 'ai') {
    return turn.turn_api_key_id ? 'AI (API)' : 'AI'
  }
  if (turn.turn_user_email) return turn.turn_user_name || turn.turn_user_email
  if (turn.turn_user_name) return turn.turn_user_name
  return 'Human'
}

function scoreColor(score: number): string {
  if (score >= 80) return 'text-emerald-600 dark:text-emerald-400'
  if (score >= 60) return 'text-sky-600 dark:text-sky-400'
  if (score >= 40) return 'text-amber-600 dark:text-amber-400'
  return 'text-red-600 dark:text-red-400'
}

// ---------------------------------------------------------------------------
// Step selection & turn history
// ---------------------------------------------------------------------------
async function selectStep(stepName: string) {
  const step = getStepForColumn(stepName)
  if (!step) return

  selectedStepName.value = stepName
  resetActionForm()
  moveActor.value = 'human' // Always default to human — the person clicking is the actor

  // Fetch turn history
  turnLoading.value = true
  turnHistory.value = []
  try {
    const res = await api.get(`/velocity/modules/${props.moduleId}/steps/${stepName}/turns`)
    turnHistory.value = res.data?.data || []
  } catch {
    turnHistory.value = []
  } finally {
    turnLoading.value = false
  }
}

async function refreshTurnHistory() {
  if (!selectedStepName.value) return
  try {
    const res = await api.get(`/velocity/modules/${props.moduleId}/steps/${selectedStepName.value}/turns`)
    turnHistory.value = res.data?.data || []
  } catch { /* silent */ }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
async function submitMove() {
  if (!selectedStep.value || !moveStatus.value) return
  moveSubmitting.value = true
  try {
    const res = await api.put(`/velocity/modules/${props.moduleId}/steps/${selectedStep.value.step_name}`, {
      status: moveStatus.value,
      actor: moveActor.value,
      content: moveNotes.value || undefined,
      attachments: moveAttachments.value.length > 0 ? moveAttachments.value : undefined,
    })

    // Update local state from response
    const updated = res.data?.data?.step || res.data?.data
    if (updated && selectedStep.value) {
      selectedStep.value.status = updated.status || moveStatus.value
      selectedStep.value.current_actor = updated.current_actor || moveActor.value
      selectedStep.value.loop_count = updated.loop_count ?? selectedStep.value.loop_count
      selectedStep.value.turn_count = (selectedStep.value.turn_count || 0) + 1
    }

    await refreshTurnHistory()
    moveStatus.value = ''
    moveNotes.value = ''
    moveAttachments.value = []
    emit('refresh')
  } catch {
    // Error handling would go here
  } finally {
    moveSubmitting.value = false
  }
}

async function executeSendBack() {
  if (!selectedStep.value || !sendBackStep.value) return
  sendingBack.value = true
  try {
    await api.post(`/velocity/modules/${props.moduleId}/send-back`, {
      targetStep: sendBackStep.value,
      content: sendBackNotes.value || `Sent back to ${STEP_LABELS[sendBackStep.value] || sendBackStep.value}`,
      actor: 'human',
    })
    emit('refresh')
    // Re-select to refresh the view
    selectedStepName.value = null
  } catch { /* ignore */ }
  sendingBack.value = false
}

async function toggleStepLock() {
  if (!selectedStep.value) return
  try {
    await api.put(`/velocity/modules/${props.moduleId}/steps/${selectedStep.value.step_name}/lock`, {
      locked: !selectedStep.value.is_locked,
    })
    selectedStep.value.is_locked = !selectedStep.value.is_locked
  } catch { /* ignore */ }
}

function addAttachment() {
  if (!newAttachmentUrl.value) return
  moveAttachments.value.push({
    filename: newAttachmentLabel.value || newAttachmentUrl.value,
    url: newAttachmentUrl.value,
  })
  newAttachmentUrl.value = ''
  newAttachmentLabel.value = ''
}

function removeAttachment(idx: number) {
  moveAttachments.value.splice(idx, 1)
}
</script>

<template>
  <Dialog
    v-model:visible="dialogOpen"
    modal
    :style="{ width: 'calc(100vw - 40px)', height: 'calc(100vh - 40px)' }"
    :breakpoints="{ '768px': '100vw' }"
    class="module-detail-dialog"
    :contentStyle="{ overflow: 'auto', maxHeight: 'calc(100vh - 120px)', padding: 0 }"
    :showHeader="false"
  >
    <div class="flex flex-col h-full">
      <!-- ═══════════════════ Custom Header ═══════════════════ -->
      <div class="flex items-center justify-between px-6 py-4 border-b border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 sticky top-0 z-20">
        <div class="flex items-center gap-3 min-w-0">
          <div class="w-10 h-10 rounded-xl bg-indigo-100 dark:bg-indigo-900/40 flex items-center justify-center flex-shrink-0">
            <FolderOpen class="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
          </div>
          <div class="min-w-0">
            <h2 class="text-lg font-jakarta font-bold text-slate-900 dark:text-white truncate">{{ moduleName }}</h2>
            <p class="text-xs font-geist text-slate-400 dark:text-slate-500 truncate">{{ projectName }}</p>
          </div>
          <!-- Velocity score badge -->
          <div v-if="velocityMetrics" class="ml-4 flex items-center gap-2">
            <div class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700">
              <Target class="w-4 h-4 text-indigo-500 dark:text-indigo-400" />
              <span class="text-lg font-jakarta font-bold" :class="scoreColor(velocityMetrics.velocity_score)">
                {{ velocityMetrics.velocity_score }}
              </span>
              <span class="text-[10px] font-geist text-slate-400 dark:text-slate-500 uppercase">score</span>
            </div>
          </div>
        </div>
        <div class="flex items-center gap-2 flex-shrink-0">
          <Button
            v-if="canEdit"
            severity="secondary"
            size="small"
            outlined
            @click="emit('edit-module')"
          >
            Edit Module
          </Button>
          <button
            @click="dialogOpen = false"
            class="w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
          >
            <X class="w-5 h-5" />
          </button>
        </div>
      </div>

      <!-- ═══════════════════ Body ═══════════════════ -->
      <div class="flex-1 overflow-y-auto bg-slate-50 dark:bg-slate-950">
        <div class="grid lg:grid-cols-5 gap-0 min-h-full">

          <!-- ═══ LEFT COLUMN (3/5 width) ═══ -->
          <div class="lg:col-span-3 p-6 space-y-6 border-r border-slate-200 dark:border-slate-700">

            <!-- ── Module Info Card ── -->
            <div class="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-700 p-5">
              <div class="flex items-start justify-between mb-4">
                <h3 class="text-sm font-jakarta font-bold text-slate-800 dark:text-slate-200 flex items-center gap-2">
                  <FolderOpen class="w-4 h-4 text-slate-400" />
                  Module Information
                </h3>
                <div class="flex items-center gap-2 flex-wrap">
                  <!-- Status badge -->
                  <span class="text-[10px] font-geist font-semibold px-2 py-0.5 rounded-full capitalize"
                    :class="moduleData?.module_status === 'delivered' || moduleData?.module_status === 'closed'
                      ? 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300'
                      : moduleData?.module_status === 'building'
                        ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300'
                        : 'bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-400'"
                  >
                    {{ moduleStatus }}
                  </span>
                  <!-- Complexity badge -->
                  <span
                    v-if="moduleData?.module_complexity && moduleData.module_complexity !== 1"
                    class="text-[10px] font-geist font-semibold px-2 py-0.5 rounded-full bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400"
                  >
                    &times;{{ moduleData.module_complexity }}
                  </span>
                  <!-- Mission critical badge -->
                  <span
                    v-if="moduleData?.module_is_mission_critical"
                    class="text-[10px] font-geist font-semibold px-2 py-0.5 rounded-full bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400 flex items-center gap-1"
                  >
                    <Shield class="w-3 h-3" /> Critical
                  </span>
                </div>
              </div>

              <!-- Description -->
              <p v-if="moduleData?.module_description" class="text-sm font-geist text-slate-600 dark:text-slate-300 mb-4">
                {{ moduleData.module_description }}
              </p>

              <!-- Percent complete bar -->
              <div v-if="moduleData?.module_percent_complete != null" class="mb-4">
                <div class="flex items-center justify-between mb-1">
                  <span class="text-[10px] font-geist text-slate-400 dark:text-slate-500 uppercase tracking-wider">Progress</span>
                  <span class="text-xs font-jakarta font-bold text-slate-700 dark:text-slate-200">{{ moduleData.module_percent_complete }}%</span>
                </div>
                <div class="h-2 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
                  <div
                    class="h-full rounded-full transition-all duration-500"
                    :class="moduleData.module_percent_complete >= 100 ? 'bg-emerald-500' : 'bg-indigo-500'"
                    :style="{ width: `${Math.min(moduleData.module_percent_complete, 100)}%` }"
                  ></div>
                </div>
              </div>

              <!-- Dates -->
              <div class="grid grid-cols-2 gap-3 mb-4">
                <div class="bg-slate-50 dark:bg-slate-800 rounded-lg p-3">
                  <div class="text-[10px] font-geist text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-1">Start Date</div>
                  <div class="text-xs font-geist font-medium text-slate-700 dark:text-slate-200">{{ formatDate(moduleData?.module_start_date) }}</div>
                </div>
                <div class="bg-slate-50 dark:bg-slate-800 rounded-lg p-3">
                  <div class="text-[10px] font-geist text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-1">End Date</div>
                  <div class="text-xs font-geist font-medium text-slate-700 dark:text-slate-200">{{ formatDate(moduleData?.module_end_date) }}</div>
                </div>
              </div>

              <!-- Plan / Progress / Blockers -->
              <div class="space-y-3">
                <div v-if="moduleData?.module_plan">
                  <div class="text-[10px] font-geist text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-1">Plan</div>
                  <p class="text-xs font-geist text-slate-600 dark:text-slate-300 whitespace-pre-wrap bg-slate-50 dark:bg-slate-800 rounded-lg p-3">{{ moduleData.module_plan }}</p>
                </div>
                <div v-if="moduleData?.module_progress">
                  <div class="text-[10px] font-geist text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-1">Progress</div>
                  <p class="text-xs font-geist text-slate-600 dark:text-slate-300 whitespace-pre-wrap bg-slate-50 dark:bg-slate-800 rounded-lg p-3">{{ moduleData.module_progress }}</p>
                </div>
                <div v-if="moduleData?.module_blockers">
                  <div class="text-[10px] font-geist text-red-400 dark:text-red-500 uppercase tracking-wider mb-1 flex items-center gap-1">
                    <AlertTriangle class="w-3 h-3" /> Blockers
                  </div>
                  <p class="text-xs font-geist text-slate-600 dark:text-slate-300 whitespace-pre-wrap bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3">{{ moduleData.module_blockers }}</p>
                </div>
              </div>
            </div>

            <!-- ── Velocity Board ── -->
            <div v-if="velocitySteps && velocitySteps.length > 0" class="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-700 p-5">
              <h3 class="text-sm font-jakarta font-bold text-slate-800 dark:text-slate-200 mb-4 flex items-center gap-2">
                <Play class="w-4 h-4 text-indigo-500 dark:text-indigo-400" />
                Velocity Board
                <span class="text-[10px] font-geist text-slate-400 dark:text-slate-500 font-normal ml-auto">
                  {{ completedStepsCount }}/8 steps completed
                </span>
              </h3>

              <!-- Progress bar -->
              <div class="h-1.5 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden mb-4">
                <div
                  class="h-full rounded-full bg-emerald-500 transition-all duration-500"
                  :style="{ width: `${(completedStepsCount / 8) * 100}%` }"
                ></div>
              </div>

              <!-- Heatmap bar -->
              <div class="grid grid-cols-8 gap-1.5">
                <div
                  v-for="stepKey in STEP_KEYS"
                  :key="stepKey"
                  class="flex flex-col items-center cursor-pointer group"
                  @click="selectStep(stepKey)"
                >
                  <div
                    class="w-full h-14 rounded-lg flex flex-col items-center justify-center gap-0.5 transition-all border-2"
                    :class="[
                      statusColor(getStepForColumn(stepKey)?.status).bg,
                      statusColor(getStepForColumn(stepKey)?.status).text,
                      isActiveStatus(getStepForColumn(stepKey)?.status) ? 'animate-pulse' : '',
                      selectedStepName === stepKey
                        ? 'border-indigo-500 dark:border-indigo-400 ring-2 ring-indigo-200 dark:ring-indigo-800'
                        : statusColor(getStepForColumn(stepKey)?.status).ring || 'border-transparent group-hover:border-indigo-300 dark:group-hover:border-indigo-600',
                    ]"
                  >
                    <!-- Lock icon -->
                    <svg v-if="getStepForColumn(stepKey)?.is_locked" class="w-3 h-3 text-amber-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" /></svg>
                    <!-- Actor icon -->
                    <Bot v-if="actorIcon(getStepForColumn(stepKey)) === 'ai'" class="w-4 h-4 flex-shrink-0" />
                    <User v-else-if="actorIcon(getStepForColumn(stepKey)) === 'human'" class="w-4 h-4 flex-shrink-0" />
                    <!-- Turn count -->
                    <span
                      v-if="getStepForColumn(stepKey) && getStepForColumn(stepKey)!.turn_count > 0"
                      class="text-[9px] font-geist font-medium leading-none"
                    >
                      {{ getStepForColumn(stepKey)!.turn_count }}t
                      <span v-if="getStepForColumn(stepKey)!.loop_count > 0" class="text-amber-600 dark:text-amber-400">
                        {{ getStepForColumn(stepKey)!.loop_count }}L
                      </span>
                    </span>
                    <!-- Completed check -->
                    <CheckCircle v-if="getStepForColumn(stepKey)?.status === 'completed'" class="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                  </div>
                  <span class="text-[9px] font-geist text-slate-400 dark:text-slate-500 mt-1 text-center leading-tight truncate w-full">
                    {{ STEP_LABELS[stepKey] }}
                  </span>
                </div>
              </div>

              <!-- Legend -->
              <div class="flex flex-wrap gap-3 mt-4 pt-3 border-t border-slate-100 dark:border-slate-800">
                <div
                  v-for="(colors, status) in STATUS_COLORS"
                  :key="status"
                  class="flex items-center gap-1 text-[9px] font-geist text-slate-400 dark:text-slate-500"
                >
                  <div class="w-2.5 h-2.5 rounded-sm" :class="colors.bg"></div>
                  {{ STATUS_LABELS[status] || status }}
                </div>
              </div>
            </div>

            <!-- ── Velocity Score Card ── -->
            <div v-if="velocityMetrics" class="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-700 p-5">
              <h3 class="text-sm font-jakarta font-bold text-slate-800 dark:text-slate-200 mb-4 flex items-center gap-2">
                <Target class="w-4 h-4 text-indigo-500 dark:text-indigo-400" />
                Velocity Metrics
              </h3>

              <!-- Score display -->
              <div class="flex items-center gap-6 mb-5">
                <div class="text-center">
                  <div class="text-4xl font-jakarta font-bold" :class="scoreColor(velocityMetrics.velocity_score)">
                    {{ velocityMetrics.velocity_score }}
                  </div>
                  <div class="text-[10px] font-geist text-slate-400 dark:text-slate-500 uppercase tracking-wider mt-1">Velocity Score</div>
                </div>
                <div class="flex-1 space-y-2">
                  <!-- Bonus -->
                  <div class="flex items-center justify-between text-xs font-geist">
                    <span class="text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
                      <CheckCircle class="w-3 h-3" /> Bonus
                    </span>
                    <span class="font-medium text-emerald-700 dark:text-emerald-300">+{{ velocityMetrics.velocity_bonus }}</span>
                  </div>
                  <!-- Penalty -->
                  <div class="flex items-center justify-between text-xs font-geist">
                    <span class="text-red-600 dark:text-red-400 flex items-center gap-1">
                      <AlertTriangle class="w-3 h-3" /> Penalty
                    </span>
                    <span class="font-medium text-red-700 dark:text-red-300">-{{ velocityMetrics.velocity_penalty }}</span>
                  </div>
                  <!-- Loopbacks -->
                  <div class="flex items-center justify-between text-xs font-geist">
                    <span class="text-amber-600 dark:text-amber-400">Loopbacks</span>
                    <span class="font-medium text-amber-700 dark:text-amber-300">{{ velocityMetrics.loopback_count }}</span>
                  </div>
                </div>
              </div>

              <!-- Metrics grid -->
              <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div class="bg-slate-50 dark:bg-slate-800 rounded-lg p-3 text-center">
                  <div class="text-[9px] font-geist text-slate-400 dark:text-slate-500 uppercase mb-1">Total Turns</div>
                  <div class="text-sm font-jakarta font-bold text-slate-800 dark:text-slate-100">{{ velocityMetrics.total_turns }}</div>
                </div>
                <div class="bg-slate-50 dark:bg-slate-800 rounded-lg p-3 text-center">
                  <div class="text-[9px] font-geist text-violet-400 uppercase mb-1 flex items-center justify-center gap-0.5">
                    <Bot class="w-2.5 h-2.5" /> AI Time
                  </div>
                  <div class="text-sm font-jakarta font-bold text-violet-700 dark:text-violet-300">{{ formatDuration(velocityMetrics.ai_time_seconds) }}</div>
                </div>
                <div class="bg-slate-50 dark:bg-slate-800 rounded-lg p-3 text-center">
                  <div class="text-[9px] font-geist text-blue-400 uppercase mb-1 flex items-center justify-center gap-0.5">
                    <User class="w-2.5 h-2.5" /> Human Time
                  </div>
                  <div class="text-sm font-jakarta font-bold text-blue-700 dark:text-blue-300">{{ formatDuration(velocityMetrics.human_time_seconds) }}</div>
                </div>
                <div class="bg-slate-50 dark:bg-slate-800 rounded-lg p-3 text-center">
                  <div class="text-[9px] font-geist text-slate-400 dark:text-slate-500 uppercase mb-1">Steps Done</div>
                  <div class="text-sm font-jakarta font-bold text-slate-800 dark:text-slate-100">{{ completedStepsCount }}/8</div>
                </div>
              </div>

              <!-- Alignment -->
              <div v-if="velocityMetrics.alignment_count > 0 || velocityMetrics.misalignment_count > 0" class="mt-4 pt-4 border-t border-slate-100 dark:border-slate-800">
                <div class="flex items-center gap-4">
                  <div class="flex-1">
                    <div class="flex items-center justify-between text-xs font-geist mb-1">
                      <span class="text-emerald-600 dark:text-emerald-400">Aligned</span>
                      <span class="font-medium text-emerald-700 dark:text-emerald-300">{{ velocityMetrics.alignment_count }}</span>
                    </div>
                    <div class="h-1.5 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
                      <div
                        class="h-full rounded-full bg-emerald-500"
                        :style="{ width: `${(velocityMetrics.alignment_count / Math.max(velocityMetrics.alignment_count + velocityMetrics.misalignment_count, 1)) * 100}%` }"
                      ></div>
                    </div>
                  </div>
                  <div class="flex-1">
                    <div class="flex items-center justify-between text-xs font-geist mb-1">
                      <span class="text-red-600 dark:text-red-400">Misaligned</span>
                      <span class="font-medium text-red-700 dark:text-red-300">{{ velocityMetrics.misalignment_count }}</span>
                    </div>
                    <div class="h-1.5 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
                      <div
                        class="h-full rounded-full bg-red-500"
                        :style="{ width: `${(velocityMetrics.misalignment_count / Math.max(velocityMetrics.alignment_count + velocityMetrics.misalignment_count, 1)) * 100}%` }"
                      ></div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <!-- No velocity data message -->
            <div v-if="!velocitySteps || velocitySteps.length === 0" class="bg-white dark:bg-slate-900 rounded-xl border border-dashed border-slate-300 dark:border-slate-600 p-8 text-center">
              <Play class="w-8 h-8 text-slate-300 dark:text-slate-600 mx-auto mb-2" />
              <p class="text-sm font-geist text-slate-400 dark:text-slate-500">No velocity data available for this module.</p>
              <p class="text-xs font-geist text-slate-400 dark:text-slate-500 mt-1">Velocity steps have not been initialized yet.</p>
            </div>
          </div>

          <!-- ═══ RIGHT COLUMN (2/5 width): Velocity Step Detail ═══ -->
          <div class="lg:col-span-2 p-6 bg-white dark:bg-slate-900 overflow-y-auto">

            <!-- No step selected -->
            <div v-if="!selectedStep" class="flex flex-col items-center justify-center h-full text-center py-20">
              <div class="w-16 h-16 rounded-2xl bg-slate-100 dark:bg-slate-800 flex items-center justify-center mb-4">
                <ArrowRight class="w-8 h-8 text-slate-300 dark:text-slate-600" />
              </div>
              <h3 class="text-sm font-jakarta font-bold text-slate-500 dark:text-slate-400 mb-1">Select a Step</h3>
              <p class="text-xs font-geist text-slate-400 dark:text-slate-500 max-w-xs">
                Click on a step in the Velocity Board to view its details, turn history, and make moves.
              </p>
            </div>

            <!-- Step detail -->
            <template v-else>
              <!-- Step header -->
              <div class="mb-5">
                <h3 class="text-base font-jakarta font-bold text-slate-900 dark:text-white mb-1 flex items-center gap-2">
                  <span
                    class="w-7 h-7 rounded-lg flex items-center justify-center text-xs font-bold"
                    :class="[statusColor(selectedStep.status).bg, statusColor(selectedStep.status).text]"
                  >
                    {{ selectedStep.step_order }}
                  </span>
                  {{ STEP_LABELS[selectedStep.step_name] || selectedStep.step_name }}
                </h3>
                <p class="text-xs font-geist text-slate-400 dark:text-slate-500">
                  Step {{ selectedStep.step_order }} of 8
                </p>
              </div>

              <!-- Step info cards -->
              <div class="grid grid-cols-3 gap-2 mb-4">
                <div class="bg-slate-50 dark:bg-slate-800 rounded-lg p-3">
                  <div class="text-[10px] font-geist text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-1">Status</div>
                  <span
                    class="text-[10px] font-geist font-semibold px-2 py-0.5 rounded-full"
                    :class="[statusColor(selectedStep.status).bg, statusColor(selectedStep.status).text]"
                  >
                    {{ STATUS_LABELS[selectedStep.status] || selectedStep.status }}
                  </span>
                </div>
                <div class="bg-slate-50 dark:bg-slate-800 rounded-lg p-3">
                  <div class="text-[10px] font-geist text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-1">Actor</div>
                  <div class="flex items-center gap-1.5 text-xs font-geist text-slate-700 dark:text-slate-200">
                    <Bot v-if="selectedStep.current_actor === 'ai'" class="w-3.5 h-3.5 text-violet-600 dark:text-violet-400" />
                    <User v-else class="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />
                    {{ selectedStep.current_actor === 'ai' ? 'AI' : 'Human' }}
                  </div>
                </div>
                <div class="bg-slate-50 dark:bg-slate-800 rounded-lg p-3">
                  <div class="text-[10px] font-geist text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-1">Turns / Loops</div>
                  <div class="text-xs font-geist text-slate-700 dark:text-slate-200">
                    {{ selectedStep.turn_count }}
                    <span v-if="selectedStep.loop_count > 0" class="text-amber-600 dark:text-amber-400 ml-1">
                      ({{ selectedStep.loop_count }} loops)
                    </span>
                  </div>
                </div>
              </div>

              <!-- Lock toggle -->
              <div class="flex items-center justify-between mb-4 px-1">
                <button
                  @click="toggleStepLock"
                  class="flex items-center gap-2 text-xs font-geist px-3 py-1.5 rounded-lg border transition-colors"
                  :class="selectedStep.is_locked
                    ? 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
                    : 'border-slate-200 text-slate-500 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-400 dark:hover:bg-slate-800'"
                >
                  <svg v-if="selectedStep.is_locked" class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" /></svg>
                  <svg v-else class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 11V7a4 4 0 118 0m-4 8v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2z" /></svg>
                  {{ selectedStep.is_locked ? 'Locked' : 'Unlocked' }}
                </button>
              </div>

              <!-- ── Turn History ── -->
              <div class="mb-5">
                <h4 class="text-sm font-jakarta font-bold text-slate-700 dark:text-slate-200 mb-3 flex items-center gap-2">
                  <Clock class="w-4 h-4 text-slate-400" />
                  Turn History
                </h4>
                <div v-if="turnLoading" class="text-center py-6 text-xs font-geist text-slate-400 dark:text-slate-500">
                  Loading history...
                </div>
                <div v-else-if="turnHistory.length === 0" class="text-center py-6 text-xs font-geist text-slate-400 dark:text-slate-500 border border-dashed border-slate-200 dark:border-slate-700 rounded-lg">
                  No turns yet. Make the first move to start.
                </div>
                <div v-else class="space-y-3 max-h-[350px] overflow-y-auto pr-1">
                  <div
                    v-for="(turn, idx) in turnHistory"
                    :key="idx"
                    class="flex gap-3"
                    :class="turn.turn_actor === 'ai' ? 'flex-row' : 'flex-row-reverse'"
                  >
                    <div
                      class="w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0"
                      :class="turn.turn_actor === 'ai' ? 'bg-violet-100 dark:bg-violet-900/40' : 'bg-blue-100 dark:bg-blue-900/40'"
                    >
                      <Bot v-if="turn.turn_actor === 'ai'" class="w-3.5 h-3.5 text-violet-600 dark:text-violet-400" />
                      <User v-else class="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />
                    </div>
                    <div
                      class="flex-1 rounded-lg px-3 py-2 max-w-[85%]"
                      :class="turn.turn_actor === 'ai' ? 'bg-violet-50 dark:bg-violet-900/20' : 'bg-blue-50 dark:bg-blue-900/20'"
                    >
                      <div class="flex items-center gap-2 mb-1 flex-wrap">
                        <span
                          class="text-[10px] font-geist font-semibold"
                          :class="turn.turn_actor === 'ai' ? 'text-violet-700 dark:text-violet-300' : 'text-blue-700 dark:text-blue-300'"
                        >
                          {{ turnActorLabel(turn) }}
                        </span>
                        <span
                          v-if="turn.turn_api_key_id"
                          class="text-[9px] font-geist px-1 py-0.5 rounded bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300"
                        >
                          API
                        </span>
                        <span v-if="turn.turn_action" class="text-[10px] font-geist text-slate-400 dark:text-slate-500">
                          &middot; {{ turn.turn_action }}
                        </span>
                      </div>
                      <!-- Status transition -->
                      <div v-if="turn.turn_from_status || turn.turn_to_status" class="flex items-center gap-1 mb-1">
                        <span
                          class="text-[9px] font-geist px-1.5 py-0.5 rounded-full"
                          :class="[statusColor(turn.turn_from_status).bg, statusColor(turn.turn_from_status).text]"
                        >
                          {{ STATUS_LABELS[turn.turn_from_status] || turn.turn_from_status }}
                        </span>
                        <ArrowRight class="w-3 h-3 text-slate-300 dark:text-slate-600" />
                        <span
                          class="text-[9px] font-geist px-1.5 py-0.5 rounded-full"
                          :class="[statusColor(turn.turn_to_status).bg, statusColor(turn.turn_to_status).text]"
                        >
                          {{ STATUS_LABELS[turn.turn_to_status] || turn.turn_to_status }}
                        </span>
                      </div>
                      <p v-if="turn.turn_content" class="text-xs font-geist text-slate-600 dark:text-slate-300 whitespace-pre-wrap">
                        {{ turn.turn_content }}
                      </p>
                      <!-- Attachments -->
                      <div v-if="turn.turn_attachments && turn.turn_attachments.length > 0" class="mt-1.5 space-y-1">
                        <a
                          v-for="(att, ai) in turn.turn_attachments"
                          :key="ai"
                          :href="att.url"
                          target="_blank"
                          rel="noopener"
                          class="flex items-center gap-1.5 text-[10px] font-geist text-indigo-600 dark:text-indigo-400 hover:underline bg-indigo-50 dark:bg-indigo-900/20 px-2 py-1 rounded"
                        >
                          <svg class="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" /></svg>
                          {{ att.filename }}
                        </a>
                      </div>
                      <div class="text-[9px] font-geist text-slate-400 dark:text-slate-500 mt-1">
                        {{ formatTimestamp(turn.created_at) }}
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <!-- ── SharePoint Step Artifacts ── -->
              <SharePointStepArtifacts
                v-if="selectedStep"
                :module-id="moduleId"
                :step-name="selectedStep.step_name"
                :can-edit="canEdit"
                class="mb-5"
              />

              <!-- ── Quick Actions: Raise Hand & Block ── -->
              <div v-if="selectedStep && ((VALID_TRANSITIONS[selectedStep.status] || []).includes('hand_raised') || (VALID_TRANSITIONS[selectedStep.status] || []).includes('blocked'))" class="mb-5">
                <h4 class="text-sm font-jakarta font-bold text-slate-700 dark:text-slate-200 mb-3 flex items-center gap-2">
                  <Hand class="w-4 h-4 text-yellow-500" /> Signal Status
                </h4>
                <div class="flex gap-2">
                  <button
                    v-if="(VALID_TRANSITIONS[selectedStep.status] || []).includes('hand_raised')"
                    @click="moveStatus = 'hand_raised'; submitMove()"
                    class="flex-1 flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg border-2 border-yellow-300 dark:border-yellow-600 bg-yellow-50 dark:bg-yellow-900/20 text-yellow-800 dark:text-yellow-200 text-xs font-geist font-medium hover:bg-yellow-100 dark:hover:bg-yellow-900/40 transition-colors"
                  >
                    <Hand class="w-4 h-4" /> Raise Hand
                  </button>
                  <button
                    v-if="(VALID_TRANSITIONS[selectedStep.status] || []).includes('blocked')"
                    @click="moveStatus = 'blocked'; submitMove()"
                    class="flex-1 flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg border-2 border-red-300 dark:border-red-600 bg-red-50 dark:bg-red-900/20 text-red-800 dark:text-red-200 text-xs font-geist font-medium hover:bg-red-100 dark:hover:bg-red-900/40 transition-colors"
                  >
                    <AlertTriangle class="w-4 h-4" /> Flag Blocked
                  </button>
                </div>
                <p v-if="selectedStep.status === 'hand_raised'" class="text-[10px] font-geist text-yellow-600 dark:text-yellow-400 mt-2">Hand is currently raised. Use "Make Move" below to resume work.</p>
              </div>

              <!-- ── Make Move Action ── -->
              <div v-if="validTransitions.length > 0" class="mb-5">
                <h4 class="text-sm font-jakarta font-bold text-slate-700 dark:text-slate-200 mb-3 flex items-center gap-2">
                  <ArrowRight class="w-4 h-4 text-slate-400" /> Make Move
                </h4>
                <div class="space-y-3">
                  <div class="flex items-center gap-3">
                    <div class="flex-1">
                      <label class="text-[10px] font-geist text-slate-400 dark:text-slate-500 uppercase tracking-wider block mb-1">New Status</label>
                      <Select
                        v-model="moveStatus"
                        :options="validTransitions"
                        option-label="label"
                        option-value="value"
                        placeholder="Select transition..."
                        class="w-full"
                      />
                    </div>
                    <div class="w-36">
                      <label class="text-[10px] font-geist text-slate-400 dark:text-slate-500 uppercase tracking-wider block mb-1">Actor</label>
                      <div class="flex rounded-lg border border-slate-200 dark:border-slate-600 overflow-hidden">
                        <button
                          class="flex-1 px-3 py-2 text-xs font-geist font-medium transition-colors flex items-center justify-center gap-1"
                          :class="moveActor === 'ai'
                            ? 'bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300'
                            : 'bg-white dark:bg-slate-800 text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-700'"
                          @click="moveActor = 'ai'"
                        >
                          <Bot class="w-3 h-3" /> AI
                        </button>
                        <button
                          class="flex-1 px-3 py-2 text-xs font-geist font-medium transition-colors flex items-center justify-center gap-1"
                          :class="moveActor === 'human'
                            ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300'
                            : 'bg-white dark:bg-slate-800 text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-700'"
                          @click="moveActor = 'human'"
                        >
                          <User class="w-3 h-3" /> Human
                        </button>
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
                      <div
                        v-for="(att, i) in moveAttachments"
                        :key="i"
                        class="flex items-center gap-2 text-xs font-geist bg-slate-50 dark:bg-slate-800 rounded px-2 py-1"
                      >
                        <svg class="w-3 h-3 text-indigo-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" /></svg>
                        <span class="text-slate-600 dark:text-slate-300 truncate flex-1" :title="att.url">{{ att.filename }}</span>
                        <button @click="removeAttachment(i)" class="text-slate-400 hover:text-red-500 dark:hover:text-red-400">
                          <X class="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                    <div class="flex gap-2">
                      <InputText v-model="newAttachmentUrl" class="flex-1" placeholder="https://..." size="small" />
                      <InputText v-model="newAttachmentLabel" class="w-28" placeholder="Label" size="small" />
                      <Button size="small" severity="secondary" outlined @click="addAttachment" :disabled="!newAttachmentUrl">+</Button>
                    </div>
                  </div>

                  <Button
                    label="Make Move"
                    :loading="moveSubmitting"
                    :disabled="!moveStatus"
                    @click="submitMove"
                    class="w-full"
                  />
                </div>
              </div>

              <!-- ── Send Back Action ── -->
              <div
                v-if="sendBackOptions.length > 0 && selectedStep.status !== 'not_started'"
                class="border-t border-slate-200 dark:border-slate-700 pt-4 mb-5"
              >
                <h4 class="text-sm font-jakarta font-bold text-amber-700 dark:text-amber-400 mb-3 flex items-center gap-2">
                  <AlertTriangle class="w-4 h-4" /> Send Back to Earlier Step
                </h4>
                <p class="text-[11px] font-geist text-slate-500 dark:text-slate-400 mb-3">
                  Send this module back to an earlier step. All steps after the target will be reset.
                </p>
                <div class="space-y-3">
                  <Select
                    v-model="sendBackStep"
                    :options="sendBackOptions"
                    option-label="label"
                    option-value="value"
                    placeholder="Select step to return to..."
                    class="w-full"
                  />
                  <Textarea v-model="sendBackNotes" rows="2" class="w-full" placeholder="Reason for sending back..." />
                  <Button
                    label="Send Back"
                    severity="warning"
                    :loading="sendingBack"
                    :disabled="!sendBackStep"
                    @click="executeSendBack"
                    class="w-full"
                  />
                </div>
              </div>

              <!-- Completed state -->
              <div
                v-if="selectedStep.status === 'completed' && validTransitions.length === 0"
                class="border-t border-slate-100 dark:border-slate-700 pt-4"
              >
                <div class="flex items-center gap-2 text-xs font-geist text-emerald-600 dark:text-emerald-400 justify-center py-2">
                  <CheckCircle class="w-4 h-4" /> This step is completed and signed off.
                </div>
              </div>
            </template>
          </div>
        </div>
      </div>
    </div>
  </Dialog>
</template>

<style scoped>
:deep(.module-detail-dialog .p-dialog-content) {
  padding: 0 !important;
}

:deep(.module-detail-dialog .p-dialog-header) {
  display: none;
}

/* Smooth pulse for active steps */
@keyframes pulse-soft {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.7; }
}

.animate-pulse-soft {
  animation: pulse-soft 2s ease-in-out infinite;
}
</style>
