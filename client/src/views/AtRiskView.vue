<script setup lang="ts">
import { computed, ref } from 'vue'
import { useProjectStore, assessRisk, RISK_COLORS, RISK_LABELS, PHASE_LABELS } from '@/stores/projects'
import type { ProjectRecord, RiskLevel, RiskInfo } from '@/stores/projects'
import { useTheme } from '@/composables/useTheme'
import MultiSelect from 'primevue/multiselect'
import { ShieldAlert, AlertTriangle, TrendingDown, CheckCircle, Gauge, HelpCircle, Calendar, Search, X } from 'lucide-vue-next'
import InputText from 'primevue/inputtext'
import Button from 'primevue/button'

const store = useProjectStore()
const { chartColors } = useTheme()

const searchQuery = ref('')
const selectedMinistries = ref<string[]>([])
const selectedRiskLevels = ref<RiskLevel[]>([])

const ministryOptions = store.uniqueMinistries.map(m => ({
  label: `${m.code} - ${m.name}`,
  value: m.code,
}))

const riskOptions: { label: string; value: RiskLevel }[] = [
  { label: 'Critical', value: 'critical' },
  { label: 'Past Due', value: 'past-due' },
  { label: 'Behind', value: 'behind' },
  { label: 'At Risk', value: 'at-risk' },
  { label: 'On Track', value: 'on-track' },
  { label: 'No Data', value: 'no-data' },
]

// Compute risk for all non-completed, non-cancelled projects
interface ProjectWithRisk {
  project: ProjectRecord
  risk: RiskInfo
}

const allProjectsWithRisk = computed((): ProjectWithRisk[] => {
  return store.allProjects
    .filter(p => p.phase !== 'cancelled' && !p.isDuplicate)
    .map(p => ({ project: p, risk: assessRisk(p) }))
})

const filteredProjectsWithRisk = computed(() => {
  let result = allProjectsWithRisk.value

  if (searchQuery.value) {
    const q = searchQuery.value.toLowerCase()
    result = result.filter(({ project: p }) =>
      p.name.toLowerCase().includes(q) ||
      p.ministryCode.toLowerCase().includes(q) ||
      p.projectLead.toLowerCase().includes(q)
    )
  }

  if (selectedMinistries.value.length > 0) {
    result = result.filter(({ project: p }) => selectedMinistries.value.includes(p.ministryCode))
  }

  if (selectedRiskLevels.value.length > 0) {
    result = result.filter(({ risk }) => selectedRiskLevels.value.includes(risk.level))
  }

  return result
})

function clearFilters() {
  searchQuery.value = ''
  selectedMinistries.value = []
  selectedRiskLevels.value = []
}

// -----------------------------------------------------------------------
// 9-box grid: Ministry × Risk Level
// -----------------------------------------------------------------------
const RISK_ORDER: RiskLevel[] = ['critical', 'past-due', 'behind', 'at-risk', 'on-track', 'completed', 'no-data']

interface NineBoxCell {
  ministryCode: string
  riskLevel: RiskLevel
  projects: ProjectWithRisk[]
}

const nineBoxMinistries = computed(() => {
  // Only ministries that have projects passing the filter
  const codes = new Set(filteredProjectsWithRisk.value.map(({ project }) => project.ministryCode))
  return store.uniqueMinistries
    .filter(m => codes.has(m.code))
    .sort((a, b) => {
      // Sort by worst risk level
      const worstA = worstRiskForMinistry(a.code)
      const worstB = worstRiskForMinistry(b.code)
      return RISK_ORDER.indexOf(worstA) - RISK_ORDER.indexOf(worstB)
    })
})

function worstRiskForMinistry(code: string): RiskLevel {
  const projects = filteredProjectsWithRisk.value.filter(({ project }) => project.ministryCode === code)
  let worst: RiskLevel = 'no-data'
  for (const { risk } of projects) {
    if (RISK_ORDER.indexOf(risk.level) < RISK_ORDER.indexOf(worst)) {
      worst = risk.level
    }
  }
  return worst
}

const activeRiskLevels = computed(() => {
  const set = new Set(filteredProjectsWithRisk.value.map(({ risk }) => risk.level))
  return RISK_ORDER.filter(r => set.has(r))
})

const nineBoxCells = computed((): Map<string, NineBoxCell> => {
  const map = new Map<string, NineBoxCell>()
  for (const { project, risk } of filteredProjectsWithRisk.value) {
    const key = `${project.ministryCode}::${risk.level}`
    if (!map.has(key)) {
      map.set(key, { ministryCode: project.ministryCode, riskLevel: risk.level, projects: [] })
    }
    map.get(key)!.projects.push({ project, risk })
  }
  return map
})

function getCellCount(ministryCode: string, riskLevel: RiskLevel): number {
  return nineBoxCells.value.get(`${ministryCode}::${riskLevel}`)?.projects.length || 0
}

function cellBgColor(count: number, riskLevel: RiskLevel): string {
  if (count === 0) return 'transparent'
  const base = RISK_COLORS[riskLevel]
  const intensity = Math.min(count / 8, 1)
  const alpha = 0.15 + intensity * 0.6
  return hexToRgba(base, alpha)
}

function cellTextColor(count: number, riskLevel: RiskLevel): string {
  if (count === 0) return 'transparent'
  const intensity = Math.min(count / 8, 1)
  return intensity > 0.4 ? '#ffffff' : RISK_COLORS[riskLevel]
}

function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '')
  const r = parseInt(h.substring(0, 2), 16)
  const g = parseInt(h.substring(2, 4), 16)
  const b = parseInt(h.substring(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

// -----------------------------------------------------------------------
// Summary stats
// -----------------------------------------------------------------------
const riskSummary = computed(() => {
  const counts: Record<RiskLevel, number> = {
    'completed': 0, 'on-track': 0, 'at-risk': 0, 'behind': 0, 'critical': 0, 'past-due': 0, 'no-data': 0,
  }
  for (const { risk } of filteredProjectsWithRisk.value) {
    counts[risk.level]++
  }
  return counts
})

const riskIcon = (level: RiskLevel) => {
  switch (level) {
    case 'critical': case 'past-due': return ShieldAlert
    case 'behind': return TrendingDown
    case 'at-risk': return AlertTriangle
    case 'on-track': case 'completed': return CheckCircle
    default: return HelpCircle
  }
}

// Modal
const modal = ref<{ show: boolean; ministryCode: string; riskLevel: RiskLevel; projects: ProjectWithRisk[] }>({ show: false, ministryCode: '', riskLevel: 'no-data', projects: [] })

function openCell(ministryCode: string, riskLevel: RiskLevel) {
  const cell = nineBoxCells.value.get(`${ministryCode}::${riskLevel}`)
  if (!cell || cell.projects.length === 0) return
  modal.value = { show: true, ministryCode, riskLevel, projects: cell.projects }
}

function closeModal() {
  modal.value.show = false
}
</script>

<template>
  <div class="min-h-screen pt-8 px-4 md:px-8">
    <div class="max-w-screen-2xl mx-auto">
      <div class="mb-8">
        <h1 class="text-3xl font-jakarta font-bold text-slate-900 mb-2 flex items-center gap-3">
          <ShieldAlert class="w-8 h-8 text-red-600" />
          Projects at Risk
        </h1>
        <p class="text-slate-500 font-geist">
          Delivery risk assessment based on timeline progress vs actual completion.
          Future: AI analysis of GitHub velocity, Confluence/Jira/SharePoint completeness.
        </p>
      </div>

      <!-- Filters -->
      <div class="flex flex-wrap items-center gap-3 mb-6">
        <div class="relative flex-1 min-w-[200px] max-w-md">
          <Search class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
          <InputText v-model="searchQuery" placeholder="Search projects, ministries..." class="w-full !pl-9" />
        </div>
        <MultiSelect
          v-model="selectedMinistries"
          :options="ministryOptions"
          option-label="label"
          option-value="value"
          placeholder="Ministry"
          :max-selected-labels="2"
          class="w-48"
        />
        <MultiSelect
          v-model="selectedRiskLevels"
          :options="riskOptions"
          option-label="label"
          option-value="value"
          placeholder="Risk Level"
          :max-selected-labels="2"
          class="w-44"
        />
        <Button
          v-if="searchQuery || selectedMinistries.length || selectedRiskLevels.length"
          severity="secondary"
          size="small"
          outlined
          @click="clearFilters()"
        >
          <template #icon><X class="w-3.5 h-3.5 mr-1" /></template>
          Clear
        </Button>
        <div class="text-xs font-geist text-slate-400 ml-auto">
          {{ filteredProjectsWithRisk.length }} projects
        </div>
      </div>

      <!-- Risk summary cards -->
      <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-7 gap-3 mb-8">
        <div
          v-for="level in (['critical', 'past-due', 'behind', 'at-risk', 'on-track', 'completed', 'no-data'] as RiskLevel[])"
          :key="level"
          class="rounded-2xl border p-4 text-center cursor-pointer hover:shadow-md transition-shadow"
          :style="{ borderColor: RISK_COLORS[level] + '40', backgroundColor: riskSummary[level] > 0 ? RISK_COLORS[level] + '08' : 'white' }"
          @click="selectedRiskLevels = selectedRiskLevels.includes(level) ? selectedRiskLevels.filter(l => l !== level) : [level]"
        >
          <component :is="riskIcon(level)" class="w-5 h-5 mx-auto mb-2" :style="{ color: RISK_COLORS[level] }" />
          <div class="text-xl font-jakarta font-bold" :style="{ color: RISK_COLORS[level] }">{{ riskSummary[level] }}</div>
          <div class="text-[10px] font-geist text-slate-500">{{ RISK_LABELS[level] }}</div>
        </div>
      </div>

      <!-- 9-box grid: Ministry × Risk Level -->
      <div class="bg-white rounded-2xl border border-slate-200 overflow-hidden mb-8">
        <div class="px-4 py-3 border-b border-slate-100 bg-slate-50">
          <h2 class="text-sm font-jakarta font-bold text-slate-700">Ministry × Risk Level Grid</h2>
          <p class="text-[10px] font-geist text-slate-400">Click a cell to see projects. Rows sorted by worst risk.</p>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full border-collapse" style="min-width: 700px">
            <thead>
              <tr class="bg-slate-50 border-b border-slate-200">
                <th class="sticky left-0 z-10 bg-slate-50 px-3 py-2 text-left text-[10px] font-geist font-semibold text-slate-600 uppercase tracking-wider border-r border-slate-200 w-44 min-w-44">
                  Ministry
                </th>
                <th
                  v-for="level in activeRiskLevels"
                  :key="level"
                  class="px-2 py-2 text-center text-[10px] font-geist font-semibold uppercase tracking-wider border-r border-slate-100 min-w-16"
                  :style="{ color: RISK_COLORS[level] }"
                >
                  {{ RISK_LABELS[level] }}
                </th>
                <th class="px-2 py-2 text-center text-[10px] font-geist font-semibold text-slate-500 uppercase tracking-wider w-14">Total</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="m in nineBoxMinistries"
                :key="m.code"
                class="border-b border-slate-50 hover:bg-slate-50/50"
              >
                <td class="sticky left-0 z-10 bg-white px-3 py-1.5 border-r border-slate-200">
                  <router-link :to="`/heatmap/${m.code}`" class="text-xs font-geist text-slate-700 hover:text-indigo-600 transition-colors">
                    <span class="font-semibold">{{ m.code }}</span>
                    <span class="text-slate-400 ml-1 hidden sm:inline">{{ m.name }}</span>
                  </router-link>
                </td>
                <td
                  v-for="level in activeRiskLevels"
                  :key="level"
                  class="text-center p-0.5 border-r border-slate-50"
                >
                  <div
                    class="h-8 rounded-sm flex items-center justify-center text-xs font-geist font-semibold transition-colors"
                    :class="getCellCount(m.code, level) > 0 ? 'cursor-pointer hover:ring-2 hover:ring-offset-1' : 'cursor-default'"
                    :style="{
                      backgroundColor: cellBgColor(getCellCount(m.code, level), level),
                      color: cellTextColor(getCellCount(m.code, level), level),
                      '--tw-ring-color': RISK_COLORS[level],
                    }"
                    @click="openCell(m.code, level)"
                  >
                    {{ getCellCount(m.code, level) || '' }}
                  </div>
                </td>
                <td class="text-center text-xs font-geist font-semibold text-slate-500 bg-slate-50/50">
                  {{ filteredProjectsWithRisk.filter(({ project }) => project.ministryCode === m.code).length }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- Legend -->
        <div class="flex flex-wrap gap-3 px-4 py-3 border-t border-slate-100 bg-slate-50">
          <div
            v-for="level in RISK_ORDER"
            :key="level"
            class="flex items-center gap-1.5 text-[10px] font-geist text-slate-500"
          >
            <div class="w-3 h-3 rounded-sm" :style="{ backgroundColor: RISK_COLORS[level] }"></div>
            {{ RISK_LABELS[level] }}
          </div>
        </div>
      </div>

      <!-- Flat project list sorted by risk severity -->
      <div class="bg-white rounded-2xl border border-slate-200 overflow-hidden">
        <div class="px-4 py-3 border-b border-slate-100 bg-slate-50">
          <h2 class="text-sm font-jakarta font-bold text-slate-700">All Projects by Risk Severity</h2>
        </div>
        <div class="divide-y divide-slate-50">
          <router-link
            v-for="{ project: p, risk } in filteredProjectsWithRisk
              .filter(({ risk }) => risk.level !== 'completed')
              .sort((a, b) => RISK_ORDER.indexOf(a.risk.level) - RISK_ORDER.indexOf(b.risk.level))"
            :key="p.id"
            :to="`/projects/${p.id}`"
            class="flex items-center gap-4 px-5 py-3 hover:bg-slate-50 transition-colors group"
          >
            <!-- Risk dot -->
            <div class="w-3 h-3 rounded-full flex-shrink-0" :style="{ backgroundColor: RISK_COLORS[risk.level] }"></div>
            <!-- Info -->
            <div class="flex-1 min-w-0">
              <div class="text-sm font-geist font-medium text-slate-900 truncate group-hover:text-indigo-600">{{ p.name }}</div>
              <div class="text-[10px] font-geist text-slate-400">
                {{ p.ministryCode }} &middot; {{ PHASE_LABELS[p.phase] || p.phase }}
                <span v-if="risk.daysRemaining !== null"> &middot;
                  <span :class="risk.daysRemaining < 0 ? 'text-red-500' : ''">
                    {{ risk.daysRemaining > 0 ? `${risk.daysRemaining}d left` : `${Math.abs(risk.daysRemaining)}d overdue` }}
                  </span>
                </span>
              </div>
            </div>
            <!-- Risk badge -->
            <span
              class="text-[10px] font-geist font-semibold px-2 py-0.5 rounded-full flex-shrink-0"
              :style="{ backgroundColor: RISK_COLORS[risk.level] + '18', color: RISK_COLORS[risk.level] }"
            >
              {{ risk.label }}
            </span>
            <!-- Progress comparison -->
            <div v-if="risk.actualPct !== null && risk.expectedPct !== null" class="hidden sm:flex items-center gap-2 flex-shrink-0 w-36">
              <div class="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden relative">
                <div class="absolute top-0 bottom-0 border-r border-dashed border-slate-400" :style="{ left: `${risk.expectedPct}%` }"></div>
                <div class="h-full rounded-full" :style="{ width: `${risk.actualPct}%`, backgroundColor: RISK_COLORS[risk.level] }"></div>
              </div>
              <span class="text-[10px] font-geist text-slate-500 w-8 text-right">{{ risk.actualPct }}%</span>
            </div>
            <!-- End date -->
            <div class="hidden md:flex items-center gap-1 text-[10px] font-geist text-slate-400 flex-shrink-0 w-24">
              <Calendar class="w-3 h-3" />
              {{ p.endDate || 'TBD' }}
            </div>
          </router-link>
        </div>
      </div>

      <!-- Cell detail modal -->
      <Teleport to="body">
        <Transition
          enter-active-class="transition ease-out duration-200"
          enter-from-class="opacity-0"
          enter-to-class="opacity-100"
          leave-active-class="transition ease-in duration-150"
          leave-from-class="opacity-100"
          leave-to-class="opacity-0"
        >
          <div v-if="modal.show" class="fixed inset-0 z-50 flex items-center justify-center p-4" @click.self="closeModal">
            <div class="absolute inset-0 bg-black/40" @click="closeModal"></div>
            <div class="relative bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[80vh] flex flex-col z-10 overflow-hidden">
              <div class="flex items-center justify-between px-6 py-4 border-b border-slate-200 bg-slate-50 flex-shrink-0">
                <div>
                  <h2 class="text-lg font-jakarta font-bold text-slate-900">
                    {{ modal.ministryCode }} — <span :style="{ color: RISK_COLORS[modal.riskLevel] }">{{ RISK_LABELS[modal.riskLevel] }}</span>
                  </h2>
                  <p class="text-xs font-geist text-slate-500">{{ modal.projects.length }} project{{ modal.projects.length !== 1 ? 's' : '' }}</p>
                </div>
                <button @click="closeModal" class="p-2 rounded-lg hover:bg-slate-200 transition-colors" aria-label="Close">
                  <svg class="w-5 h-5 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              </div>
              <div class="overflow-y-auto flex-1 divide-y divide-slate-100">
                <router-link
                  v-for="{ project: p, risk } in modal.projects"
                  :key="p.id"
                  :to="`/projects/${p.id}`"
                  class="flex items-center gap-4 px-6 py-3 hover:bg-slate-50 transition-colors group"
                  @click="closeModal"
                >
                  <div class="w-2.5 h-2.5 rounded-full flex-shrink-0" :style="{ backgroundColor: RISK_COLORS[risk.level] }"></div>
                  <div class="flex-1 min-w-0">
                    <div class="text-sm font-geist font-medium text-slate-900 truncate group-hover:text-indigo-600">{{ p.name }}</div>
                    <div class="text-[10px] font-geist text-slate-400">{{ risk.reason }}</div>
                  </div>
                  <div class="text-[10px] font-geist text-slate-400 flex-shrink-0">{{ p.endDate || 'TBD' }}</div>
                </router-link>
              </div>
            </div>
          </div>
        </Transition>
      </Teleport>
    </div>
  </div>
</template>
