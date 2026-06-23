<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Flame, Check, Clock, Users, Trophy, Lock, Settings as SettingsIcon, GitFork, X as XIcon } from 'lucide-vue-next'
import api, { fetchCsrfToken } from '@/lib/api'
import { useAuthStore } from '@/stores/auth'
import Dialog from 'primevue/dialog'
import Button from 'primevue/button'
import Textarea from 'primevue/textarea'

// ─── Types ────────────────────────────────────────────────────────────
interface Challenge {
  id: string
  title: string
  description: string
  difficulty: 'easy' | 'medium' | 'hard' | 'expert'
  points: number
  maxDays: number
  // v5.1
  acceptanceCount: number
  maxAcceptances: number | null   // null = unlimited
  spotsRemaining: number | null   // null when unlimited
  isFull: boolean
  closedAt: string | null
  winnerProjectId: string | null
  winnerNarrative: string | null
  winnerName: string | null
  cloneDisabled: boolean
  createdBy: string | null
  createdByName: string | null
}

interface Acceptance {
  pk_project: string
  project_name: string
  project_version_label: string | null
  project_status: string
  project_percent_complete: number | null
  project_is_locked: boolean
  challenge_completed_at: string | null
  primary_owner_name: string | null
  primary_owner_email: string | null
}

const auth = useAuthStore()
const route = useRoute()
const router = useRouter()

const loading = ref(false)
const actionLoading = ref<string | null>(null)
const error = ref('')
const challenges = ref<Challenge[]>([])

// ─── Filters ───────────────────────────────────────────────────────────
type StatusFilter = 'open' | 'claimed' | 'closed' | 'completed' | 'all'
type DifficultyFilter = 'easy' | 'medium' | 'hard' | 'expert' | 'all'

const statusFilter = computed<StatusFilter>(() => {
  const s = route.query.status as string
  if (s === 'open' || s === 'claimed' || s === 'closed' || s === 'completed') return s
  return 'all'
})
const difficultyFilter = computed<DifficultyFilter>(() => {
  const d = route.query.difficulty as string
  if (d === 'easy' || d === 'medium' || d === 'hard' || d === 'expert') return d
  return 'all'
})

const statusOptions: { label: string; value: StatusFilter }[] = [
  { label: 'All', value: 'all' },
  { label: 'Open', value: 'open' },
  { label: 'In progress', value: 'claimed' },
  { label: 'Closed', value: 'closed' },
  { label: 'Completed', value: 'completed' },
]

const difficultyOptions: { label: string; value: DifficultyFilter; color: string }[] = [
  { label: 'All', value: 'all', color: 'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300' },
  { label: 'Easy', value: 'easy', color: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400' },
  { label: 'Medium', value: 'medium', color: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400' },
  { label: 'Hard', value: 'hard', color: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400' },
  { label: 'Expert', value: 'expert', color: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400' },
]

function setFilter(key: 'status' | 'difficulty', value: string) {
  const query = { ...route.query }
  if (value === 'all') delete query[key]
  else query[key] = value
  router.replace({ query })
}

// ─── Fetch ─────────────────────────────────────────────────────────────
async function fetchChallenges() {
  loading.value = true
  error.value = ''
  try {
    const params: Record<string, string> = {}
    if (statusFilter.value !== 'all') params.status = statusFilter.value
    if (difficultyFilter.value !== 'all') params.difficulty = difficultyFilter.value
    const res = await api.get('/challenges', { params })
    const raw = res.data?.data ?? res.data ?? []
    challenges.value = (Array.isArray(raw) ? raw : []).map(mapChallenge)
  } catch (err: unknown) {
    error.value = 'Failed to load challenges.'
    console.error(err)
  } finally {
    loading.value = false
  }
}

function mapChallenge(c: any): Challenge {
  return {
    id: c.pk_project,
    title: c.project_name || '',
    description: c.project_description || '',
    difficulty: c.challenge_difficulty || 'medium',
    points: c.challenge_points || 0,
    maxDays: c.challenge_max_days || 5,
    acceptanceCount: c.acceptance_count || 0,
    maxAcceptances: c.challenge_max_acceptances ?? null,
    spotsRemaining: c.spots_remaining ?? null,
    isFull: !!c.is_full,
    closedAt: c.challenge_closed_at,
    winnerProjectId: c.challenge_winner_project,
    winnerNarrative: c.challenge_winner_narrative,
    winnerName: c.winner_name,
    cloneDisabled: !!c.project_clone_disabled,
    createdBy: c.created_by,
    createdByName: c.created_by_name,
  }
}

// ─── Accept (clone) ────────────────────────────────────────────────────
async function acceptChallenge(challenge: Challenge) {
  actionLoading.value = challenge.id
  error.value = ''
  try {
    await fetchCsrfToken()
    const res = await api.post(`/challenges/${challenge.id}/accept`)
    const newId = res.data?.data?.pk_project
    if (newId) router.push(`/projects/${newId}`)
    else await fetchChallenges()
  } catch (err: any) {
    const code = err?.response?.data?.error?.code
    if (code === 'CHALLENGE_FULL')      error.value = 'This challenge is full — no more acceptances.'
    else if (code === 'CHALLENGE_CLOSED') error.value = 'This challenge has been closed.'
    else if (code === 'CHALLENGE_COMPLETED') error.value = 'This challenge has already been won.'
    else error.value = err?.response?.data?.error?.message || 'Failed to accept challenge.'
  } finally {
    actionLoading.value = null
  }
}

// ─── Manage panel (creator/admin only) ─────────────────────────────────
const manageDialog = ref(false)
const manageTarget = ref<Challenge | null>(null)
const manageAcceptances = ref<Acceptance[]>([])
const manageLoading = ref(false)
const winnerProjectId = ref<string>('')
const winnerNarrative = ref('')
const closingChallenge = ref(false)
const pickingWinner = ref(false)

function isMyChallenge(c: Challenge): boolean {
  return c.createdBy === auth.user?.id
}
function isAdmin(): boolean {
  return (auth.user?.roles || [auth.user?.role || '']).includes('admin')
}
function canManage(c: Challenge): boolean {
  return isMyChallenge(c) || isAdmin()
}

async function openManageDialog(c: Challenge) {
  manageTarget.value = c
  manageDialog.value = true
  winnerProjectId.value = c.winnerProjectId || ''
  winnerNarrative.value = c.winnerNarrative || ''
  manageLoading.value = true
  try {
    const res = await api.get(`/challenges/${c.id}`)
    manageAcceptances.value = res.data?.data?.acceptances || []
  } catch (err) {
    console.error(err)
    manageAcceptances.value = []
  } finally {
    manageLoading.value = false
  }
}

async function closeChallenge() {
  if (!manageTarget.value) return
  if (!confirm('Close this challenge? No further acceptances will be allowed (existing clones can still complete).')) return
  closingChallenge.value = true
  try {
    await fetchCsrfToken()
    await api.post(`/challenges/${manageTarget.value.id}/close`)
    await fetchChallenges()
    manageTarget.value = challenges.value.find(c => c.id === manageTarget.value!.id) || null
  } catch (err: any) {
    alert(err?.response?.data?.error?.message || 'Failed to close challenge.')
  } finally {
    closingChallenge.value = false
  }
}

async function pickWinner() {
  if (!manageTarget.value || !winnerProjectId.value) return
  pickingWinner.value = true
  try {
    await fetchCsrfToken()
    await api.post(`/challenges/${manageTarget.value.id}/pick-winner`, {
      winnerProjectId: winnerProjectId.value,
      narrative: winnerNarrative.value.trim() || null,
    })
    manageDialog.value = false
    await fetchChallenges()
  } catch (err: any) {
    alert(err?.response?.data?.error?.message || 'Failed to pick winner.')
  } finally {
    pickingWinner.value = false
  }
}

watch([statusFilter, difficultyFilter], () => fetchChallenges())
onMounted(() => fetchChallenges())

// ─── Helpers ───────────────────────────────────────────────────────────
function difficultyBadgeClass(d: Challenge['difficulty']): string {
  return ({
    easy: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400',
    medium: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400',
    hard: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400',
    expert: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400',
  } as Record<string, string>)[d] || 'bg-slate-100 text-slate-600'
}

function challengeStatus(c: Challenge): 'open' | 'claimed' | 'closed' | 'completed' {
  if (c.winnerProjectId) return 'completed'
  if (c.closedAt) return 'closed'
  if (c.acceptanceCount > 0) return 'claimed'
  return 'open'
}

function truncate(text: string, maxLen: number): string {
  if (!text || text.length <= maxLen) return text
  return text.slice(0, maxLen).trimEnd() + '…'
}
</script>

<template>
  <div class="max-w-screen-2xl mx-auto px-4 md:px-8 py-8">
    <!-- Header -->
    <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
      <div class="flex items-center gap-3">
        <div class="w-10 h-10 rounded-xl bg-orange-100 dark:bg-orange-900/40 flex items-center justify-center">
          <Flame :size="22" class="text-orange-600 dark:text-orange-400" />
        </div>
        <h1 class="font-jakarta text-2xl font-bold text-slate-900 dark:text-white">Challenges</h1>
      </div>
    </div>

    <!-- Filters -->
    <div class="flex flex-col sm:flex-row gap-4 mb-6 flex-wrap">
      <div class="flex items-center gap-1 bg-slate-100 dark:bg-slate-800 rounded-lg p-1 flex-wrap">
        <button
          v-for="opt in statusOptions"
          :key="opt.value"
          @click="setFilter('status', opt.value)"
          class="px-4 py-1.5 rounded-md text-sm font-geist transition-colors"
          :class="statusFilter === opt.value
            ? 'bg-white dark:bg-slate-700 text-indigo-600 dark:text-indigo-400 shadow-sm font-medium'
            : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'"
        >
          {{ opt.label }}
        </button>
      </div>
      <div class="flex items-center gap-2 flex-wrap">
        <span class="text-xs font-geist text-slate-500 dark:text-slate-400 uppercase tracking-wider mr-1">Difficulty:</span>
        <button
          v-for="opt in difficultyOptions"
          :key="opt.value"
          @click="setFilter('difficulty', opt.value)"
          class="px-3 py-1 rounded-full text-xs font-geist font-medium transition-all"
          :class="difficultyFilter === opt.value
            ? opt.color + ' ring-2 ring-offset-1 ring-indigo-400 dark:ring-offset-slate-900'
            : opt.color + ' opacity-60 hover:opacity-100'"
        >
          {{ opt.label }}
        </button>
      </div>
    </div>

    <div v-if="error" class="mb-6 p-4 rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 text-sm font-geist">
      {{ error }}
    </div>

    <div v-if="loading" class="flex items-center justify-center py-20">
      <div class="w-8 h-8 border-4 border-indigo-200 border-t-indigo-600 rounded-full animate-spin"></div>
    </div>

    <!-- Challenge grid -->
    <template v-else>
      <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
        <div
          v-for="c in challenges"
          :key="c.id"
          class="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 p-5 flex flex-col hover:shadow-md transition-shadow relative"
        >
          <!-- Top: difficulty + points -->
          <div class="flex items-start justify-between mb-3">
            <span class="inline-block px-2.5 py-0.5 rounded-full text-xs font-geist font-semibold capitalize"
                  :class="difficultyBadgeClass(c.difficulty)">
              {{ c.difficulty }}
            </span>
            <div class="text-right">
              <div class="font-jakarta text-2xl font-bold text-indigo-600 dark:text-indigo-400 leading-none">{{ c.points }}</div>
              <div class="text-[10px] font-geist text-slate-400 uppercase tracking-wider">pts</div>
            </div>
          </div>

          <!-- Title (clickable to detail) -->
          <h3 class="font-jakarta font-semibold text-lg text-slate-900 dark:text-white mb-2 leading-snug cursor-pointer hover:text-indigo-600 dark:hover:text-indigo-400"
              @click="router.push(`/projects/${c.id}`)">
            {{ c.title }}
          </h3>

          <p class="text-sm font-geist text-slate-500 dark:text-slate-400 mb-4 leading-relaxed flex-1">
            {{ truncate(c.description, 150) }}
          </p>

          <!-- Acceptance progress -->
          <div class="mb-3 px-3 py-2 rounded-lg bg-slate-50 dark:bg-slate-900/50">
            <div class="flex items-center justify-between text-xs font-geist">
              <span class="flex items-center gap-1.5 text-slate-600 dark:text-slate-300">
                <Users :size="14" />
                <strong>{{ c.acceptanceCount }}</strong>
                <span v-if="c.maxAcceptances != null">/ {{ c.maxAcceptances }} accepted</span>
                <span v-else>accepted</span>
              </span>
              <span v-if="c.maxAcceptances == null" class="text-emerald-600 dark:text-emerald-400">∞ unlimited</span>
              <span v-else-if="c.isFull" class="text-rose-600 dark:text-rose-400 font-semibold">FULL</span>
              <span v-else class="text-emerald-600 dark:text-emerald-400">{{ c.spotsRemaining }} spot{{ c.spotsRemaining === 1 ? '' : 's' }} left</span>
            </div>
            <div v-if="c.maxAcceptances != null" class="mt-2 h-1 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
              <div class="h-full bg-indigo-500" :style="{ width: `${Math.min(100, (c.acceptanceCount / c.maxAcceptances) * 100)}%` }"></div>
            </div>
          </div>

          <!-- Deadline -->
          <div class="flex items-center gap-1.5 text-xs font-geist text-slate-400 dark:text-slate-500 mb-4">
            <Clock :size="14" />
            <span>{{ c.maxDays }} day{{ c.maxDays !== 1 ? 's' : '' }} target</span>
            <span v-if="c.createdByName" class="ml-auto">by {{ c.createdByName }}</span>
          </div>

          <!-- Winner / closed banner -->
          <div v-if="c.winnerProjectId" class="mb-3 px-3 py-2 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800">
            <div class="flex items-center gap-1.5 text-xs font-jakarta font-semibold text-amber-800 dark:text-amber-200">
              <Trophy :size="14" /> Winner: {{ c.winnerName || 'Unknown' }}
            </div>
            <p v-if="c.winnerNarrative" class="text-xs font-geist text-amber-700 dark:text-amber-300 mt-1 italic">
              "{{ c.winnerNarrative }}"
            </p>
          </div>
          <div v-else-if="c.closedAt" class="mb-3 px-3 py-2 rounded-lg bg-slate-100 dark:bg-slate-700/40 text-xs font-geist text-slate-600 dark:text-slate-300 flex items-center gap-1.5">
            <Lock :size="12" /> Closed to new acceptances
          </div>

          <!-- Status + Actions -->
          <div class="border-t border-slate-100 dark:border-slate-700 pt-4 mt-auto flex items-center justify-between gap-2">
            <!-- Status pill -->
            <span class="inline-flex items-center gap-1.5 text-xs font-geist font-medium"
                  :class="{
                    'text-emerald-600 dark:text-emerald-400': challengeStatus(c) === 'open',
                    'text-blue-600 dark:text-blue-400': challengeStatus(c) === 'claimed',
                    'text-slate-500 dark:text-slate-400': challengeStatus(c) === 'closed',
                    'text-amber-600 dark:text-amber-400': challengeStatus(c) === 'completed',
                  }">
              <span v-if="challengeStatus(c) === 'open'" class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
              {{ ({ open: 'Open', claimed: 'In progress', closed: 'Closed', completed: 'Completed' } as any)[challengeStatus(c)] }}
            </span>

            <div class="flex items-center gap-2">
              <button
                v-if="canManage(c)"
                @click="openManageDialog(c)"
                class="px-2.5 py-1 rounded-lg border border-slate-200 dark:border-slate-600 text-xs font-geist text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700 flex items-center gap-1"
                v-tooltip="'Manage challenge'"
              >
                <SettingsIcon :size="12" /> Manage
              </button>
              <button
                v-if="challengeStatus(c) === 'open' || challengeStatus(c) === 'claimed'"
                :disabled="actionLoading === c.id || c.isFull || !!c.closedAt || !!c.winnerProjectId"
                @click="acceptChallenge(c)"
                class="px-4 py-1.5 rounded-lg bg-indigo-600 text-white text-sm font-geist font-medium hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-1"
                v-tooltip="c.isFull ? 'No spots remaining' : 'Clone this challenge to take it on'"
              >
                <GitFork :size="12" />
                <template v-if="actionLoading === c.id">Accepting…</template>
                <template v-else-if="c.isFull">Full</template>
                <template v-else>Accept</template>
              </button>
            </div>
          </div>
        </div>
      </div>

      <div v-if="challenges.length === 0 && !loading" class="py-16 text-center">
        <Flame :size="40" class="mx-auto mb-3 text-slate-300 dark:text-slate-600" />
        <p class="text-slate-500 dark:text-slate-400 font-geist">No challenges match your filters.</p>
      </div>
    </template>

    <!-- ─── Manage dialog (creator/admin) ───────────────────────────── -->
    <Dialog
      v-model:visible="manageDialog"
      :header="manageTarget ? `Manage: ${manageTarget.title}` : 'Manage challenge'"
      :modal="true"
      :style="{ width: '640px' }"
      :breakpoints="{ '768px': '95vw' }"
    >
      <template v-if="manageTarget">
        <div v-if="manageLoading" class="text-center py-6 text-sm text-slate-500">Loading acceptances…</div>

        <div v-else>
          <!-- Summary -->
          <div class="grid grid-cols-3 gap-3 mb-4">
            <div class="p-3 rounded-lg bg-slate-50 dark:bg-slate-900/50 text-center">
              <div class="text-2xl font-jakarta font-bold text-indigo-600 dark:text-indigo-400">{{ manageTarget.acceptanceCount }}</div>
              <div class="text-[10px] uppercase font-geist text-slate-500">Acceptances</div>
            </div>
            <div class="p-3 rounded-lg bg-slate-50 dark:bg-slate-900/50 text-center">
              <div class="text-2xl font-jakarta font-bold text-slate-700 dark:text-slate-200">
                {{ manageTarget.maxAcceptances == null ? '∞' : manageTarget.maxAcceptances }}
              </div>
              <div class="text-[10px] uppercase font-geist text-slate-500">Max spots</div>
            </div>
            <div class="p-3 rounded-lg bg-slate-50 dark:bg-slate-900/50 text-center">
              <div class="text-2xl font-jakarta font-bold text-amber-600 dark:text-amber-400">{{ manageTarget.points }}</div>
              <div class="text-[10px] uppercase font-geist text-slate-500">Points</div>
            </div>
          </div>

          <!-- Status notes -->
          <div v-if="manageTarget.winnerProjectId" class="mb-4 p-3 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800">
            <div class="flex items-center gap-1.5 text-sm font-jakarta font-semibold text-amber-800 dark:text-amber-200">
              <Trophy :size="14" /> Winner: {{ manageTarget.winnerName || 'Unknown' }}
            </div>
            <p v-if="manageTarget.winnerNarrative" class="text-xs font-geist text-amber-700 dark:text-amber-300 mt-1 italic">
              "{{ manageTarget.winnerNarrative }}"
            </p>
          </div>
          <div v-else-if="manageTarget.closedAt" class="mb-4 p-3 rounded-lg bg-slate-100 dark:bg-slate-700/40 text-sm font-geist text-slate-600 dark:text-slate-300 flex items-center gap-1.5">
            <Lock :size="14" /> Closed to new acceptances. You can still pick a winner from existing clones.
          </div>

          <!-- Acceptances list -->
          <h4 class="text-xs font-geist font-semibold uppercase tracking-wider text-slate-500 mb-2">Acceptances</h4>
          <ul v-if="manageAcceptances.length" class="space-y-2 mb-4 max-h-48 overflow-y-auto">
            <li
              v-for="a in manageAcceptances"
              :key="a.pk_project"
              class="flex items-center gap-3 p-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800"
            >
              <input
                v-if="!manageTarget.winnerProjectId"
                type="radio"
                v-model="winnerProjectId"
                :value="a.pk_project"
                class="flex-shrink-0"
              />
              <div class="flex-1 min-w-0">
                <button
                  class="text-sm font-medium text-slate-900 dark:text-slate-100 truncate hover:text-indigo-600 text-left"
                  @click="router.push(`/projects/${a.pk_project}`)"
                >
                  {{ a.project_name }}
                  <span v-if="a.project_version_label" class="ml-1 text-[10px] text-violet-700 px-1.5 py-0.5 rounded bg-violet-100">{{ a.project_version_label }}</span>
                </button>
                <div class="text-xs text-slate-500 mt-0.5">
                  {{ a.primary_owner_name || 'no owner' }} · {{ a.project_status?.replace(/_/g, ' ') }} · {{ a.project_percent_complete ?? 0 }}%
                  <Lock v-if="a.project_is_locked" :size="10" class="inline text-rose-500 ml-1" />
                  <Check v-if="a.challenge_completed_at" :size="10" class="inline text-emerald-500 ml-1" />
                </div>
              </div>
            </li>
          </ul>
          <p v-else class="text-sm font-geist text-slate-500 italic mb-4">No acceptances yet.</p>

          <!-- Pick winner panel -->
          <template v-if="!manageTarget.winnerProjectId && manageAcceptances.length > 0">
            <label class="block text-xs font-geist text-slate-600 dark:text-slate-300 mb-1">
              Why did this entry win? <span class="text-slate-400">(optional)</span>
            </label>
            <Textarea
              v-model="winnerNarrative"
              rows="3"
              class="w-full mb-3"
              placeholder="e.g. cleanest implementation, finished within deadline, best test coverage…"
            />
          </template>
        </div>
      </template>

      <template #footer>
        <Button v-if="manageTarget" severity="secondary" outlined @click="manageDialog = false">Close</Button>
        <Button
          v-if="manageTarget && !manageTarget.closedAt && !manageTarget.winnerProjectId"
          severity="warning"
          :loading="closingChallenge"
          @click="closeChallenge"
        >
          <Lock class="w-3.5 h-3.5 mr-1" /> Close to new acceptances
        </Button>
        <Button
          v-if="manageTarget && !manageTarget.winnerProjectId && manageAcceptances.length > 0"
          severity="success"
          :disabled="!winnerProjectId"
          :loading="pickingWinner"
          @click="pickWinner"
        >
          <Trophy class="w-3.5 h-3.5 mr-1" /> Pick winner & award points
        </Button>
      </template>
    </Dialog>
  </div>
</template>
