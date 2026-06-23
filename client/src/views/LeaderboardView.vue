<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Trophy, Skull, AlertTriangle, Heart } from 'lucide-vue-next'
import Dialog from 'primevue/dialog'
import api from '@/lib/api'
import { fetchCsrfToken } from '@/lib/api'
import { useAuthStore } from '@/stores/auth'

interface LeaderboardEntry {
  userId: string
  name: string
  email: string
  totalPoints: number
  velocityPoints: number
  challengePoints: number
  bonusPoints: number
  penaltyPoints: number
  modulesCompleted: number
  challengesCompleted: number
  violations: number
}

interface ViolationSummaryRow {
  type: string
  count: number
  total_inverted: number
}

interface ViolationExampleRow {
  type: string
  original_points: number
  inverted_points: number
  evidence: Record<string, unknown> | null
  detected_at: string
  project_id: string | null
  project_name: string | null
  module_id: string | null
  module_name: string | null
  step_name: string | null
}

interface UserViolationsResponse {
  summary: ViolationSummaryRow[]
  examples: ViolationExampleRow[]
}

const RULE_DESCRIPTIONS: Record<string, string> = {
  speed_run: 'Step completed faster than humanly plausible — flagged by minimum-time threshold.',
  no_artifact: 'Step completed but produced no attachments, no code, no document — pure point grab.',
  no_collaboration: 'Step completed entirely by one actor — the chess-clock model requires hand-offs.',
  blank_module: 'Module with completed steps but virtually no content: <5 turns AND <100 chars of metadata.',
  project_module_overflow: 'Project has ≥10 modules (including soft-deleted ones). Real projects have narrow scope; bulk-spawning inflates points.',
  empty_content: '≥80% of the user\'s turns on this step were <50 chars — farming via blank turn spam.',
  burst_turns: 'User submitted ≥3 turns within 5 seconds on the same step — bot-like click pattern.',
  self_approval: 'AI agent both submitted AND approved its own work using the same API key — defeats peer-review.',
}

interface ReaperReport {
  scannedProjects: number
  scannedModules: number
  scannedSteps: number
  violationsCreated: number
  pointsInverted: number
  breakdown: Record<string, number>
  perUser: Array<{ userId: string; userDisplayName: string; violations: number; pointsInverted: number }>
}

interface LeaderboardResponse {
  entries: LeaderboardEntry[]
  totalParticipants: number
  totalPointsAwarded: number
}

const auth = useAuthStore()
const route = useRoute()
const router = useRouter()

const loading = ref(false)
const error = ref('')
const data = ref<LeaderboardResponse | null>(null)

type Period = 'month' | 'year' | 'all'
// Default to 'all' so the materialized-view path (which includes
// violations_count and post-Reaper negative totals) is used. The
// month/year live-query paths also surface violations + negatives, but
// "All Time" is the canonical view of who's earned and who's been
// caught.
const period = computed<Period>(() => {
  const p = route.query.period as string
  if (p === 'month' || p === 'year') return p
  return 'all'
})

const periodOptions: { label: string; value: Period }[] = [
  { label: 'This Month', value: 'month' },
  { label: 'This Year', value: 'year' },
  { label: 'All Time', value: 'all' },
]

function setPeriod(value: Period) {
  router.replace({ query: { ...route.query, period: value } })
}

async function fetchLeaderboard() {
  loading.value = true
  error.value = ''
  try {
    // Pass an explicit high limit so the client doesn't rely on the
    // server's default cap — we want every user including those whose
    // post-Reaper totals are deeply negative.
    const res = await api.get('/leaderboard', {
      params: { period: period.value, limit: 10000 },
    })
    const raw = res.data?.data ?? res.data ?? []
    const entries: LeaderboardEntry[] = (Array.isArray(raw) ? raw : []).map((e: any) => ({
      rank: parseInt(e.rank, 10) || 0,
      userId: e.user_id,
      name: e.user_display_name || '',
      email: e.user_email_address || '',
      totalPoints: parseInt(e.total_points, 10) || 0,
      velocityPoints: parseInt(e.velocity_points, 10) || 0,
      challengePoints: parseInt(e.challenge_points, 10) || 0,
      bonusPoints: parseInt(e.bonus_points, 10) || 0,
      penaltyPoints: parseInt(e.penalty_points, 10) || 0,
      modulesCompleted: parseInt(e.modules_completed, 10) || 0,
      challengesCompleted: parseInt(e.challenges_completed, 10) || 0,
      violations: parseInt(e.violations_count, 10) || 0,
    }))
    data.value = {
      entries,
      totalParticipants: entries.length,
      totalPointsAwarded: entries.reduce((sum, e) => sum + e.totalPoints, 0),
    }
  } catch (err: unknown) {
    error.value = 'Failed to load leaderboard data.'
    console.error(err)
  } finally {
    loading.value = false
  }
}

watch(period, () => fetchLeaderboard())
onMounted(() => fetchLeaderboard())

function rankClass(rank: number): string {
  if (rank === 1) return 'text-amber-500 font-bold'
  if (rank === 2) return 'text-slate-400 font-bold'
  if (rank === 3) return 'text-orange-600 font-bold'
  return 'text-slate-500'
}

function rankIcon(rank: number): string {
  if (rank === 1) return '🥇'
  if (rank === 2) return '🥈'
  if (rank === 3) return '🥉'
  return ''
}

function pointsClass(value: number): string {
  if (value > 0) return 'text-emerald-600 dark:text-emerald-400'
  if (value < 0) return 'text-red-600 dark:text-red-400'
  return 'text-slate-500 dark:text-slate-400'
}

function isCurrentUser(entry: LeaderboardEntry): boolean {
  return auth.user?.id === entry.userId || auth.user?.email === entry.email
}

function initial(name: string): string {
  return name?.charAt(0)?.toUpperCase() || '?'
}

// ─── The Reaper ────────────────────────────────────────────────────────
// Admin-only cheat audit. Visible to everyone (deterrent / transparency)
// but only runnable by admins.
const isAdmin = computed(() => {
  const roles = auth.user?.roles || (auth.user?.role ? [auth.user.role] : [])
  return roles.includes('admin')
})

// The single user with the most violations gets a 💀 badge ("biggest cheater").
// Ties broken by who appears first in the leaderboard. Returns null if nobody
// has any violations.
const biggestCheaterId = computed<string | null>(() => {
  const entries = data.value?.entries || []
  let best: LeaderboardEntry | null = null
  for (const e of entries) {
    if (e.violations <= 0) continue
    if (!best || e.violations > best.violations) best = e
  }
  return best?.userId ?? null
})

const reaperRunning = ref(false)
const reaperReport = ref<ReaperReport | null>(null)
const reaperError = ref('')
const showReaperDialog = ref(false)
const showConfirmDialog = ref(false)

async function runReaper() {
  showConfirmDialog.value = false
  reaperRunning.value = true
  reaperError.value = ''
  reaperReport.value = null
  showReaperDialog.value = true
  try {
    await fetchCsrfToken()
    const res = await api.post('/leaderboard/reaper/run')
    reaperReport.value = (res.data?.data || res.data) as ReaperReport
    // Re-fetch leaderboard so violations counts + inverted scores show.
    await fetchLeaderboard()
  } catch (err: any) {
    reaperError.value =
      err?.response?.data?.error?.message ||
      err?.response?.data?.message ||
      err?.message ||
      'Reaper failed'
  } finally {
    reaperRunning.value = false
  }
}

// ─── Redemption ────────────────────────────────────────────────────────
// Inverse of the Reaper: any user with a currently-negative total is
// bumped up to exactly 0 by writing a positive `redemption` user_points
// row. Violation history (the public Skull badge + Violations count)
// is preserved as a permanent audit record.
interface RedemptionReport {
  redeemedUsers: number
  pointsForgiven: number
  details: Array<{
    userId: string
    userDisplayName: string
    priorTotal: number
    redemptionPoints: number
  }>
}

const redemptionRunning = ref(false)
const redemptionReport = ref<RedemptionReport | null>(null)
const redemptionError = ref('')
const showRedemptionDialog = ref(false)
const showRedemptionConfirm = ref(false)

async function runRedemption() {
  showRedemptionConfirm.value = false
  redemptionRunning.value = true
  redemptionError.value = ''
  redemptionReport.value = null
  showRedemptionDialog.value = true
  try {
    await fetchCsrfToken()
    const res = await api.post('/leaderboard/redemption/run')
    redemptionReport.value = (res.data?.data || res.data) as RedemptionReport
    // Refresh leaderboard so the forgiven zeros show up.
    await fetchLeaderboard()
  } catch (err: any) {
    redemptionError.value =
      err?.response?.data?.error?.message ||
      err?.response?.data?.message ||
      err?.message ||
      'Redemption failed'
  } finally {
    redemptionRunning.value = false
  }
}

// ─── Per-user violation breakdown ──────────────────────────────────────
// Click the violation pill → fetch the breakdown for that user and open
// a dialog showing which rules fired, with example scopes.
const showViolationsDialog = ref(false)
const violationsLoading = ref(false)
const violationsError = ref('')
const violationsUser = ref<{ id: string; name: string; total: number } | null>(null)
const violationsData = ref<UserViolationsResponse | null>(null)

async function openViolations(entry: LeaderboardEntry) {
  violationsUser.value = { id: entry.userId, name: entry.name, total: entry.violations }
  violationsData.value = null
  violationsError.value = ''
  violationsLoading.value = true
  showViolationsDialog.value = true
  try {
    const res = await api.get(`/leaderboard/user/${entry.userId}/violations`)
    violationsData.value = (res.data?.data || res.data) as UserViolationsResponse
  } catch (err: any) {
    violationsError.value =
      err?.response?.data?.error?.message ||
      err?.response?.data?.message ||
      err?.message ||
      'Could not load violations'
  } finally {
    violationsLoading.value = false
  }
}

function ruleLabel(type: string): string {
  return type.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

function ruleDescription(type: string): string {
  return RULE_DESCRIPTIONS[type] || 'Cheating pattern detected by the Reaper.'
}

function scopeLabel(ex: ViolationExampleRow): string {
  if (ex.step_name && ex.module_name && ex.project_name)
    return `${ex.project_name} › ${ex.module_name} › ${ex.step_name}`
  if (ex.module_name && ex.project_name)
    return `${ex.project_name} › ${ex.module_name}`
  if (ex.project_name) return ex.project_name
  return '(project-wide)'
}
</script>

<template>
  <div class="max-w-screen-2xl mx-auto px-4 md:px-8 py-8">
    <!-- Header -->
    <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
      <div class="flex items-center gap-3">
        <div class="w-10 h-10 rounded-xl bg-amber-100 dark:bg-amber-900/40 flex items-center justify-center">
          <Trophy :size="22" class="text-amber-600 dark:text-amber-400" />
        </div>
        <h1 class="font-jakarta text-2xl font-bold text-slate-900 dark:text-white">Leaderboard</h1>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <!-- Run the Reaper: visible to all, only enabled for admins -->
        <button
          @click="isAdmin ? (showConfirmDialog = true) : null"
          :disabled="!isAdmin || reaperRunning"
          :title="isAdmin
            ? 'Audit for cheating: speed-running, no-artifact completions, blank modules, project-module overflow. Inverts offender points.'
            : 'Admin-only — only platform admins can invoke the Reaper.'"
          class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-geist font-medium border transition-colors"
          :class="isAdmin
            ? 'border-rose-300 dark:border-rose-700 text-rose-700 dark:text-rose-300 hover:bg-rose-50 dark:hover:bg-rose-900/20'
            : 'border-slate-200 dark:border-slate-700 text-slate-400 dark:text-slate-500 cursor-not-allowed opacity-70'"
        >
          <Skull class="w-4 h-4" />
          {{ reaperRunning ? 'Running…' : 'Run the Reaper' }}
        </button>

        <!-- Redemption: forgive negative balances. Visible to all, admin-only enabled. -->
        <button
          @click="isAdmin ? (showRedemptionConfirm = true) : null"
          :disabled="!isAdmin || redemptionRunning"
          :title="isAdmin
            ? 'Forgive everyone with a negative score: each is bumped up to exactly zero. Violation history is preserved.'
            : 'Admin-only — only platform admins can grant redemption.'"
          class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-geist font-medium border transition-colors"
          :class="isAdmin
            ? 'border-emerald-300 dark:border-emerald-700 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-50 dark:hover:bg-emerald-900/20'
            : 'border-slate-200 dark:border-slate-700 text-slate-400 dark:text-slate-500 cursor-not-allowed opacity-70'"
        >
          <Heart class="w-4 h-4" />
          {{ redemptionRunning ? 'Running…' : 'Redemption' }}
        </button>

        <!-- Period selector -->
        <div class="flex items-center gap-1 bg-slate-100 dark:bg-slate-800 rounded-lg p-1">
          <button
            v-for="opt in periodOptions"
            :key="opt.value"
            @click="setPeriod(opt.value)"
            class="px-4 py-1.5 rounded-md text-sm font-geist transition-colors"
            :class="period === opt.value
              ? 'bg-white dark:bg-slate-700 text-indigo-600 dark:text-indigo-400 shadow-sm font-medium'
              : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'"
          >
            {{ opt.label }}
          </button>
        </div>
      </div>
    </div>

    <!-- Error -->
    <div v-if="error" class="mb-6 p-4 rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 text-sm font-geist">
      {{ error }}
    </div>

    <!-- Loading -->
    <div v-if="loading" class="flex items-center justify-center py-20">
      <div class="w-8 h-8 border-4 border-indigo-200 border-t-indigo-600 rounded-full animate-spin"></div>
    </div>

    <template v-else-if="data">
      <!-- Stats bar -->
      <div class="grid grid-cols-2 gap-4 mb-6">
        <div class="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 p-4">
          <div class="text-xs font-geist text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1">Total Participants</div>
          <div class="font-jakarta text-2xl font-bold text-slate-900 dark:text-white">{{ data.totalParticipants.toLocaleString() }}</div>
        </div>
        <div class="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 p-4">
          <div class="text-xs font-geist text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1">Total Points Awarded</div>
          <div class="font-jakarta text-2xl font-bold text-indigo-600 dark:text-indigo-400">{{ data.totalPointsAwarded.toLocaleString() }}</div>
        </div>
      </div>

      <!-- Table -->
      <div class="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden">
        <div class="overflow-x-auto">
          <table class="w-full text-sm font-geist">
            <thead>
              <tr class="border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/80">
                <th class="text-left px-4 py-3 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider w-16">Rank</th>
                <th class="text-left px-4 py-3 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">User</th>
                <th class="text-right px-4 py-3 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">Total</th>
                <th class="text-right px-4 py-3 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider hidden md:table-cell">Velocity</th>
                <th class="text-right px-4 py-3 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider hidden md:table-cell">Challenge</th>
                <th class="text-right px-4 py-3 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider hidden lg:table-cell">Bonus</th>
                <th class="text-right px-4 py-3 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider hidden lg:table-cell">Penalty</th>
                <th
                  class="text-right px-4 py-3 text-xs font-semibold text-rose-500 dark:text-rose-400 uppercase tracking-wider"
                  title="Number of cheating violations detected by the Reaper. Each violation inverts the user's points for that scope."
                >Violations</th>
                <th class="text-right px-4 py-3 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider hidden xl:table-cell">Modules</th>
                <th class="text-right px-4 py-3 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider hidden xl:table-cell">Challenges</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="(entry, index) in data.entries"
                :key="entry.userId"
                class="border-b border-slate-100 dark:border-slate-700/50 transition-colors"
                :class="[
                  isCurrentUser(entry)
                    ? 'bg-indigo-50 dark:bg-indigo-900/20 ring-1 ring-indigo-200 dark:ring-indigo-800'
                    : index % 2 === 0
                      ? 'bg-white dark:bg-slate-800'
                      : 'bg-slate-50/50 dark:bg-slate-800/50',
                ]"
              >
                <!-- Rank -->
                <td class="px-4 py-3">
                  <span :class="rankClass(index + 1)" class="text-base">
                    <template v-if="index < 3">{{ rankIcon(index + 1) }}</template>
                    <template v-else>{{ index + 1 }}</template>
                  </span>
                </td>

                <!-- User -->
                <td class="px-4 py-3">
                  <div class="flex items-center gap-3">
                    <div
                      class="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold shrink-0"
                      :class="isCurrentUser(entry)
                        ? 'bg-indigo-200 dark:bg-indigo-800 text-indigo-700 dark:text-indigo-200'
                        : 'bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300'"
                    >
                      {{ initial(entry.name) }}
                    </div>
                    <div class="min-w-0">
                      <div class="font-medium text-slate-900 dark:text-white truncate flex items-center gap-1">
                        {{ entry.name }}
                        <span v-if="isCurrentUser(entry)" class="ml-1 text-[10px] bg-indigo-100 dark:bg-indigo-900 text-indigo-600 dark:text-indigo-300 px-1.5 py-0.5 rounded-full font-semibold">YOU</span>
                        <Skull
                          v-if="entry.userId === biggestCheaterId"
                          class="w-3.5 h-3.5 text-rose-600 dark:text-rose-400"
                          title="Biggest cheater — most cheating violations detected by the Reaper."
                        />
                      </div>
                      <div class="text-xs text-slate-400 dark:text-slate-500 truncate">{{ entry.email }}</div>
                    </div>
                  </div>
                </td>

                <!-- Total Points -->
                <td class="px-4 py-3 text-right">
                  <span class="font-jakarta font-bold text-base" :class="pointsClass(entry.totalPoints)">
                    {{ entry.totalPoints.toLocaleString() }}
                  </span>
                </td>

                <!-- Velocity Points -->
                <td class="px-4 py-3 text-right hidden md:table-cell">
                  <span :class="pointsClass(entry.velocityPoints)">{{ entry.velocityPoints.toLocaleString() }}</span>
                </td>

                <!-- Challenge Points -->
                <td class="px-4 py-3 text-right hidden md:table-cell">
                  <span :class="pointsClass(entry.challengePoints)">{{ entry.challengePoints.toLocaleString() }}</span>
                </td>

                <!-- Bonus -->
                <td class="px-4 py-3 text-right hidden lg:table-cell">
                  <span :class="pointsClass(entry.bonusPoints)">
                    {{ entry.bonusPoints > 0 ? '+' : '' }}{{ entry.bonusPoints.toLocaleString() }}
                  </span>
                </td>

                <!-- Penalty -->
                <td class="px-4 py-3 text-right hidden lg:table-cell">
                  <span :class="pointsClass(entry.penaltyPoints)">
                    {{ entry.penaltyPoints > 0 ? '+' : '' }}{{ entry.penaltyPoints.toLocaleString() }}
                  </span>
                </td>

                <!-- Violations -->
                <td class="px-4 py-3 text-right">
                  <button
                    v-if="entry.violations > 0"
                    type="button"
                    @click="openViolations(entry)"
                    class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold bg-rose-100 dark:bg-rose-900/30 text-rose-700 dark:text-rose-300 hover:bg-rose-200 dark:hover:bg-rose-900/50 focus:outline-none focus:ring-2 focus:ring-rose-400 cursor-pointer transition-colors"
                    title="Click to see which Reaper rules were violated"
                  >
                    <Skull class="w-3 h-3" />
                    {{ entry.violations }}
                  </button>
                  <span v-else class="text-slate-300 dark:text-slate-600">—</span>
                </td>

                <!-- Modules Completed -->
                <td class="px-4 py-3 text-right hidden xl:table-cell text-slate-600 dark:text-slate-300">
                  {{ entry.modulesCompleted }}
                </td>

                <!-- Challenges Completed -->
                <td class="px-4 py-3 text-right hidden xl:table-cell text-slate-600 dark:text-slate-300">
                  {{ entry.challengesCompleted }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- Empty state -->
        <div v-if="data.entries.length === 0" class="py-16 text-center">
          <Trophy :size="40" class="mx-auto mb-3 text-slate-300 dark:text-slate-600" />
          <p class="text-slate-500 dark:text-slate-400 font-geist">No leaderboard data for this period yet.</p>
        </div>
      </div>
    </template>

    <!-- Reaper confirm dialog -->
    <Dialog v-model:visible="showConfirmDialog" header="Run the Reaper?" :modal="true" :style="{ width: '520px' }" :breakpoints="{ '768px': '95vw' }">
      <div class="space-y-3 text-sm font-geist text-slate-700 dark:text-slate-300">
        <p class="flex items-start gap-2">
          <AlertTriangle class="w-5 h-5 text-rose-500 flex-shrink-0 mt-0.5" />
          <span>This audits every project, module, and step for cheating patterns and <strong>inverts the offender's points</strong> (a +N earned score becomes −N). Runs in-place and is idempotent — re-running only appends new findings.</span>
        </p>
        <p class="text-xs text-slate-500 dark:text-slate-400">Detection rules:</p>
        <ul class="text-xs text-slate-500 dark:text-slate-400 list-disc pl-5 space-y-1">
          <li><strong>Speed-run</strong> — step completed by solo AI (no human turns)</li>
          <li><strong>No artifact</strong> — completion with zero attachments anywhere</li>
          <li><strong>No collaboration</strong> — completion by a single distinct actor</li>
          <li><strong>Blank module</strong> — completed steps with empty content + minimal turns</li>
          <li><strong>Project overflow</strong> — projects with ≥10 modules (point-farming pattern)</li>
        </ul>
      </div>
      <template #footer>
        <button
          @click="showConfirmDialog = false"
          class="px-3 py-1.5 text-xs font-geist text-slate-500 hover:text-slate-700 dark:text-slate-400"
        >Cancel</button>
        <button
          @click="runReaper"
          class="px-3 py-1.5 text-xs font-geist font-medium bg-rose-600 text-white rounded-lg hover:bg-rose-700 inline-flex items-center gap-1.5"
        >
          <Skull class="w-3.5 h-3.5" /> Run Reaper
        </button>
      </template>
    </Dialog>

    <!-- Reaper result dialog -->
    <Dialog v-model:visible="showReaperDialog" header="Reaper Report" :modal="true" :style="{ width: '640px' }" :breakpoints="{ '768px': '95vw' }">
      <div v-if="reaperRunning" class="py-8 text-center">
        <div class="w-8 h-8 border-4 border-rose-200 border-t-rose-600 rounded-full animate-spin mx-auto"></div>
        <p class="mt-3 text-sm font-geist text-slate-500">Sweeping the corpus… inverting earned points where evidence of cheating is found.</p>
      </div>
      <div v-else-if="reaperError" class="p-3 rounded-lg bg-rose-50 dark:bg-rose-900/20 text-rose-700 dark:text-rose-300 text-sm">
        {{ reaperError }}
      </div>
      <div v-else-if="reaperReport" class="space-y-4 text-sm font-geist text-slate-700 dark:text-slate-300">
        <div class="grid grid-cols-3 gap-3">
          <div class="p-3 rounded-lg bg-slate-50 dark:bg-slate-900/40 border border-slate-200 dark:border-slate-700">
            <div class="text-[10px] uppercase text-slate-500">Violations</div>
            <div class="font-jakarta text-2xl font-bold text-rose-600 dark:text-rose-400">{{ reaperReport.violationsCreated }}</div>
          </div>
          <div class="p-3 rounded-lg bg-slate-50 dark:bg-slate-900/40 border border-slate-200 dark:border-slate-700">
            <div class="text-[10px] uppercase text-slate-500">Points inverted</div>
            <div class="font-jakarta text-2xl font-bold text-rose-600 dark:text-rose-400">−{{ reaperReport.pointsInverted.toLocaleString() }}</div>
          </div>
          <div class="p-3 rounded-lg bg-slate-50 dark:bg-slate-900/40 border border-slate-200 dark:border-slate-700">
            <div class="text-[10px] uppercase text-slate-500">Scanned</div>
            <div class="font-jakarta text-xs text-slate-600 dark:text-slate-300 mt-1">
              {{ reaperReport.scannedProjects }} projects<br>
              {{ reaperReport.scannedModules }} modules<br>
              {{ reaperReport.scannedSteps }} steps
            </div>
          </div>
        </div>

        <div>
          <div class="text-[10px] uppercase text-slate-500 mb-2">Breakdown by violation type</div>
          <ul class="space-y-1 text-xs">
            <li v-for="(count, type) in reaperReport.breakdown" :key="type" class="flex items-center justify-between">
              <code class="text-slate-600 dark:text-slate-300">{{ type }}</code>
              <span :class="count > 0 ? 'font-bold text-rose-600 dark:text-rose-400' : 'text-slate-400'">{{ count }}</span>
            </li>
          </ul>
        </div>

        <div v-if="reaperReport.perUser?.length">
          <div class="text-[10px] uppercase text-slate-500 mb-2">Per-user impact (descending)</div>
          <ul class="space-y-1 text-xs max-h-48 overflow-y-auto">
            <li v-for="u in reaperReport.perUser" :key="u.userId" class="flex items-center justify-between gap-2 px-2 py-1 rounded hover:bg-slate-50 dark:hover:bg-slate-700/30">
              <span class="text-slate-700 dark:text-slate-200 truncate">{{ u.userDisplayName }}</span>
              <span class="flex items-center gap-2 flex-shrink-0">
                <span class="text-rose-600 dark:text-rose-400">{{ u.violations }} violations</span>
                <span class="text-rose-700 dark:text-rose-300 font-bold">{{ u.pointsInverted.toLocaleString() }}</span>
              </span>
            </li>
          </ul>
        </div>

        <p v-if="reaperReport.violationsCreated === 0" class="text-center text-emerald-600 dark:text-emerald-400 text-sm">
          ✓ No new violations detected. Everyone played fair.
        </p>
      </div>
      <template #footer>
        <button
          @click="showReaperDialog = false"
          class="px-3 py-1.5 text-xs font-geist text-slate-500 hover:text-slate-700 dark:text-slate-400"
        >Close</button>
      </template>
    </Dialog>

    <!-- Redemption confirm dialog -->
    <Dialog v-model:visible="showRedemptionConfirm" header="Run Redemption?" :modal="true" :style="{ width: '520px' }" :breakpoints="{ '768px': '95vw' }">
      <div class="space-y-3 text-sm font-geist text-slate-700 dark:text-slate-300">
        <p class="flex items-start gap-2">
          <Heart class="w-5 h-5 text-emerald-500 flex-shrink-0 mt-0.5" />
          <span>For every user whose current total is <strong>negative</strong>, this writes a positive <code class="text-xs bg-slate-100 dark:bg-slate-800 px-1 rounded">redemption</code> entry that bumps them up to exactly zero. Anyone already at or above zero is unaffected.</span>
        </p>
        <p>The <strong>cheating violation history is preserved</strong> — the Skull badges and the Violations column remain populated as a permanent audit record. Only the score is forgiven.</p>
        <p>Idempotent: a second run with no remaining negatives is a no-op.</p>
      </div>
      <template #footer>
        <div class="flex justify-end gap-2">
          <button
            @click="showRedemptionConfirm = false"
            class="px-3 py-1.5 text-sm font-geist text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg"
          >Cancel</button>
          <button
            @click="runRedemption"
            class="px-3 py-1.5 text-sm font-geist font-medium text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg inline-flex items-center gap-1.5"
          >
            <Heart class="w-4 h-4" />
            Forgive the negatives
          </button>
        </div>
      </template>
    </Dialog>

    <!-- Redemption result dialog -->
    <Dialog v-model:visible="showRedemptionDialog" header="Redemption Report" :modal="true" :style="{ width: '640px' }" :breakpoints="{ '768px': '95vw' }">
      <div v-if="redemptionRunning" class="py-10 flex flex-col items-center gap-3">
        <div class="w-8 h-8 border-4 border-emerald-200 border-t-emerald-600 rounded-full animate-spin"></div>
        <p class="text-sm text-slate-500 font-geist">Granting redemption…</p>
      </div>
      <div v-else-if="redemptionError" class="p-3 rounded-lg bg-rose-50 dark:bg-rose-900/30 text-rose-700 dark:text-rose-300 text-sm font-geist">
        {{ redemptionError }}
      </div>
      <div v-else-if="redemptionReport" class="space-y-4 text-sm font-geist text-slate-700 dark:text-slate-300">
        <div class="grid grid-cols-2 gap-3">
          <div class="bg-emerald-50 dark:bg-emerald-900/20 rounded-lg p-3">
            <div class="text-xs uppercase tracking-wider text-emerald-700 dark:text-emerald-300">Users redeemed</div>
            <div class="font-jakarta text-2xl font-bold text-emerald-700 dark:text-emerald-300">{{ redemptionReport.redeemedUsers.toLocaleString() }}</div>
          </div>
          <div class="bg-emerald-50 dark:bg-emerald-900/20 rounded-lg p-3">
            <div class="text-xs uppercase tracking-wider text-emerald-700 dark:text-emerald-300">Points forgiven</div>
            <div class="font-jakarta text-2xl font-bold text-emerald-700 dark:text-emerald-300">+{{ redemptionReport.pointsForgiven.toLocaleString() }}</div>
          </div>
        </div>

        <div v-if="redemptionReport.details.length > 0" class="border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
          <div class="px-3 py-2 bg-slate-50 dark:bg-slate-800/80 text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">
            Per-user
          </div>
          <ul class="max-h-72 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-700/50">
            <li v-for="d in redemptionReport.details" :key="d.userId" class="px-3 py-2 flex items-center justify-between gap-3 text-xs">
              <span class="truncate text-slate-700 dark:text-slate-200">{{ d.userDisplayName }}</span>
              <span class="font-mono whitespace-nowrap">
                <span class="text-rose-600 dark:text-rose-400">{{ d.priorTotal.toLocaleString() }}</span>
                <span class="text-slate-400 mx-1">→</span>
                <span class="text-emerald-600 dark:text-emerald-400">0</span>
                <span class="text-slate-400 ml-1">(+{{ d.redemptionPoints.toLocaleString() }})</span>
              </span>
            </li>
          </ul>
        </div>
        <p v-else class="text-slate-500 italic">No users had negative totals — nothing to forgive.</p>
      </div>
      <template #footer>
        <button
          @click="showRedemptionDialog = false"
          class="px-3 py-1.5 text-xs font-geist text-slate-500 hover:text-slate-700 dark:text-slate-400"
        >Close</button>
      </template>
    </Dialog>

    <!-- Per-user violations dialog -->
    <Dialog
      v-model:visible="showViolationsDialog"
      :modal="true"
      :style="{ width: '720px' }"
      :breakpoints="{ '768px': '95vw' }"
    >
      <template #header>
        <div class="flex items-center gap-2">
          <Skull class="w-5 h-5 text-rose-500" />
          <span class="font-jakarta text-base">
            Violations — {{ violationsUser?.name || '' }}
            <span v-if="violationsUser" class="ml-2 text-xs text-slate-500 font-normal">({{ violationsUser.total }} total)</span>
          </span>
        </div>
      </template>

      <div v-if="violationsLoading" class="py-10 flex items-center justify-center">
        <div class="w-6 h-6 border-4 border-rose-200 border-t-rose-600 rounded-full animate-spin"></div>
      </div>

      <div v-else-if="violationsError" class="p-3 rounded-lg bg-rose-50 dark:bg-rose-900/30 text-rose-700 dark:text-rose-300 text-sm font-geist">
        {{ violationsError }}
      </div>

      <div v-else-if="violationsData" class="space-y-5 text-sm font-geist text-slate-700 dark:text-slate-300">
        <div v-if="violationsData.summary.length === 0" class="text-slate-500 italic">
          This user has no recorded violations.
        </div>

        <div v-for="row in violationsData.summary" :key="row.type" class="border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
          <!-- Summary header -->
          <div class="px-4 py-3 bg-rose-50 dark:bg-rose-900/20 border-b border-rose-200 dark:border-rose-800 flex items-start justify-between gap-3">
            <div class="min-w-0">
              <div class="font-jakarta font-bold text-rose-700 dark:text-rose-300 flex items-center gap-2">
                <Skull class="w-4 h-4" />
                {{ ruleLabel(row.type) }}
              </div>
              <div class="text-xs text-slate-600 dark:text-slate-400 mt-1">
                {{ ruleDescription(row.type) }}
              </div>
            </div>
            <div class="text-right shrink-0">
              <div class="text-xs uppercase text-slate-500 dark:text-slate-400 tracking-wider">Count</div>
              <div class="font-jakarta text-lg font-bold text-rose-600 dark:text-rose-400">{{ row.count }}</div>
              <div class="text-xs font-mono text-rose-500 dark:text-rose-400 mt-0.5">{{ row.total_inverted.toLocaleString() }} pts</div>
            </div>
          </div>

          <!-- Examples -->
          <div class="px-4 py-2 bg-white dark:bg-slate-800">
            <div class="text-[10px] uppercase tracking-wider text-slate-400 dark:text-slate-500 mb-1.5">Top examples</div>
            <ul class="space-y-1.5">
              <li
                v-for="(ex, exIdx) in violationsData.examples.filter((e) => e.type === row.type)"
                :key="`${row.type}-${exIdx}`"
                class="flex items-center justify-between gap-3 text-xs"
              >
                <span class="truncate text-slate-600 dark:text-slate-300">{{ scopeLabel(ex) }}</span>
                <span class="font-mono text-rose-600 dark:text-rose-400 whitespace-nowrap">
                  {{ ex.original_points.toLocaleString() }} → {{ ex.inverted_points.toLocaleString() }}
                </span>
              </li>
              <li
                v-if="violationsData.examples.filter((e) => e.type === row.type).length === 0"
                class="text-xs text-slate-400 italic"
              >
                (no example scopes)
              </li>
            </ul>
          </div>
        </div>

        <p class="text-xs text-slate-500 italic">
          Each violation inverts the user's original earnings by 2× (so a +N earned score becomes −N net).
          Re-running the Reaper is idempotent — it only appends new findings.
        </p>
      </div>

      <template #footer>
        <button
          @click="showViolationsDialog = false"
          class="px-3 py-1.5 text-xs font-geist text-slate-500 hover:text-slate-700 dark:text-slate-400"
        >Close</button>
      </template>
    </Dialog>
  </div>
</template>
