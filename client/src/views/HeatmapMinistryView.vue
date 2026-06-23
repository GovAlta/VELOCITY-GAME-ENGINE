<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useProjectStore, assessRisk, RISK_COLORS, RISK_LABELS, PHASE_LABELS } from '@/stores/projects'
import type { ProjectRecord, RiskInfo, RiskLevel } from '@/stores/projects'
import { useTheme } from '@/composables/useTheme'
import { ArrowLeft, Calendar } from 'lucide-vue-next'

const route = useRoute()
const router = useRouter()
const store = useProjectStore()
const { chartColors } = useTheme()

const ministryCode = computed(() => route.params.ministry as string)

const ministry = computed(() => {
  const m = store.uniqueMinistries.find(m => m.code === ministryCode.value)
  return m || { code: ministryCode.value, name: ministryCode.value, count: 0 }
})

const ministryProjects = computed(() => {
  return store.allProjects
    .filter(p => p.ministryCode === ministryCode.value && !p.isDuplicate && p.phase !== 'cancelled')
    .map(p => ({ project: p, risk: assessRisk(p) }))
    .sort((a, b) => {
      // Sort by end date, nulls last
      const aDate = a.project.endDate || '9999-99-99'
      const bDate = b.project.endDate || '9999-99-99'
      return aDate.localeCompare(bDate)
    })
})

// Generate months for timeline
const heatmapMonths = computed(() => {
  const result: string[] = []
  // Find min/max dates from this ministry's projects
  let minDate = '2025-01-01'
  let maxDate = '2027-12-01'
  for (const { project: p } of ministryProjects.value) {
    if (p.startDate && p.startDate < minDate) minDate = p.startDate
    if (p.endDate && p.endDate > maxDate) maxDate = p.endDate
  }
  const start = new Date(minDate.substring(0, 7) + '-01')
  const end = new Date(maxDate.substring(0, 7) + '-01')
  end.setMonth(end.getMonth() + 1)
  const cur = new Date(start)
  while (cur <= end) {
    result.push(`${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}`)
    cur.setMonth(cur.getMonth() + 1)
  }
  return result
})

function monthLabel(ym: string): string {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return months[parseInt(ym.split('-')[1]) - 1]
}

// Year groups
const yearGroups = computed(() => {
  const groups = new Map<string, number>()
  for (const ym of heatmapMonths.value) {
    const y = ym.split('-')[0]
    groups.set(y, (groups.get(y) || 0) + 1)
  }
  return [...groups.entries()].map(([year, span]) => ({ year, span }))
})

// For each project × month, compute how close to the deadline (danger ramp)
// Color logic: the closer to end date and the further behind schedule, the more red
interface CellInfo {
  month: string
  isActive: boolean       // Project spans this month
  dangerLevel: number     // 0-1 scale, 0 = safe, 1 = extreme danger
  riskLevel: RiskLevel
  daysToDeadline: number | null
  pctComplete: number | null
  expectedPct: number | null
}

function computeCells(project: ProjectRecord, risk: RiskInfo): CellInfo[] {
  const today = new Date().toISOString().split('T')[0]

  return heatmapMonths.value.map(ym => {
    const [y, m] = ym.split('-').map(Number)
    const monthStart = new Date(y, m - 1, 1)
    const monthEnd = new Date(y, m, 0)
    const msStr = `${y}-${String(m).padStart(2, '0')}-01`
    const meStr = `${y}-${String(m).padStart(2, '0')}-${String(monthEnd.getDate()).padStart(2, '0')}`

    const pStart = project.startDate || project.endDate
    const pEnd = project.endDate || project.startDate
    if (!pStart || !pEnd) {
      return { month: ym, isActive: false, dangerLevel: 0, riskLevel: 'no-data', daysToDeadline: null, pctComplete: project.percentComplete, expectedPct: null }
    }

    const isActive = pStart <= meStr && pEnd >= msStr
    if (!isActive) {
      return { month: ym, isActive: false, dangerLevel: 0, riskLevel: risk.level, daysToDeadline: null, pctComplete: project.percentComplete, expectedPct: null }
    }

    // Calculate danger: how behind is the project at this point in time
    const endMs = new Date(pEnd).getTime()
    const startMs = new Date(pStart).getTime()
    const midMonthMs = new Date(y, m - 1, 15).getTime()
    const totalDuration = endMs - startMs
    const elapsed = midMonthMs - startMs
    const timeRatio = totalDuration > 0 ? Math.max(0, Math.min(elapsed / totalDuration, 1)) : 1
    const expectedPct = Math.round(timeRatio * 100)
    const actualPct = project.percentComplete ?? 0

    // Days from mid-month to deadline
    const daysToDeadline = Math.ceil((endMs - midMonthMs) / (1000 * 60 * 60 * 24))

    // Is this month in the past?
    const monthIsPast = meStr < today

    // Danger calculation: combines gap + proximity to deadline
    let dangerLevel = 0
    if (risk.level === 'completed') {
      dangerLevel = 0
    } else if (monthIsPast && project.percentComplete !== null) {
      // For past months, use the gap
      const gap = expectedPct - actualPct
      dangerLevel = Math.max(0, Math.min(gap / 50, 1))
    } else if (!monthIsPast) {
      // For future months, ramp up danger as deadline approaches IF behind
      const gap = risk.gap ?? 0
      const proximityFactor = 1 - Math.max(0, Math.min(daysToDeadline / 180, 1)) // closer = higher
      dangerLevel = Math.max(0, Math.min((gap / 40) * (0.5 + proximityFactor * 0.5), 1))
    }

    return {
      month: ym,
      isActive: true,
      dangerLevel,
      riskLevel: risk.level,
      daysToDeadline,
      pctComplete: project.percentComplete,
      expectedPct,
    }
  })
}

// Danger color: green (safe) → yellow → orange → red (danger)
function dangerColor(cell: CellInfo): string {
  if (!cell.isActive) return 'transparent'

  if (cell.riskLevel === 'completed') {
    return hexToRgba('#059669', 0.3)
  }

  if (cell.dangerLevel <= 0) return hexToRgba('#10b981', 0.25)
  if (cell.dangerLevel <= 0.25) return hexToRgba('#f59e0b', 0.25 + cell.dangerLevel * 1.2)
  if (cell.dangerLevel <= 0.5) return hexToRgba('#f97316', 0.3 + cell.dangerLevel * 0.8)
  return hexToRgba('#dc2626', 0.3 + cell.dangerLevel * 0.6)
}

function dangerTextColor(cell: CellInfo): string {
  if (!cell.isActive) return 'transparent'
  if (cell.dangerLevel > 0.5) return '#ffffff'
  if (cell.dangerLevel > 0.3) return '#7c2d12'
  return '#065f46'
}

function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '')
  const r = parseInt(h.substring(0, 2), 16)
  const g = parseInt(h.substring(2, 4), 16)
  const b = parseInt(h.substring(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

// Today column highlight
const todayYM = computed(() => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
})

// Tooltip
const tooltip = ref<{ show: boolean; x: number; y: number; content: string }>({ show: false, x: 0, y: 0, content: '' })

function showTooltip(event: MouseEvent, cell: CellInfo, projectName: string) {
  if (!cell.isActive) return
  let lines = [projectName, cell.month]
  if (cell.pctComplete !== null) lines.push(`Actual: ${cell.pctComplete}%`)
  if (cell.expectedPct !== null) lines.push(`Expected: ${cell.expectedPct}%`)
  if (cell.daysToDeadline !== null) {
    lines.push(cell.daysToDeadline > 0 ? `${cell.daysToDeadline} days to deadline` : `${Math.abs(cell.daysToDeadline)} days past deadline`)
  }
  lines.push(`Danger: ${Math.round(cell.dangerLevel * 100)}%`)
  tooltip.value = { show: true, x: event.clientX, y: event.clientY, content: lines.join('\n') }
}

function hideTooltip() {
  tooltip.value.show = false
}
</script>

<template>
  <div class="min-h-screen pt-8 px-4 md:px-8">
    <div class="max-w-screen-2xl mx-auto">
      <!-- Back -->
      <button @click="router.back()" class="inline-flex items-center gap-1 text-sm font-geist text-slate-500 hover:text-indigo-600 mb-6 transition-colors">
        <ArrowLeft class="w-4 h-4" />
        Back to Heatmap
      </button>

      <div class="mb-8">
        <div class="flex items-center gap-3 mb-2">
          <span class="text-xs font-geist font-semibold uppercase px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-600">{{ ministry.code }}</span>
          <h1 class="text-3xl font-jakarta font-bold text-slate-900">{{ ministry.name }}</h1>
        </div>
        <p class="text-slate-500 font-geist">
          {{ ministryProjects.length }} projects — health heatmap showing delivery danger ramping toward deadlines.
        </p>
      </div>

      <!-- Risk summary for this ministry -->
      <div class="flex flex-wrap gap-3 mb-6">
        <div
          v-for="level in (['critical', 'past-due', 'behind', 'at-risk', 'on-track', 'completed', 'no-data'] as RiskLevel[])"
          :key="level"
          class="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-geist font-medium"
          :style="{ backgroundColor: RISK_COLORS[level] + '15', color: RISK_COLORS[level] }"
          v-show="ministryProjects.filter(({ risk }) => risk.level === level).length > 0"
        >
          <div class="w-2 h-2 rounded-full" :style="{ backgroundColor: RISK_COLORS[level] }"></div>
          {{ RISK_LABELS[level] }}: {{ ministryProjects.filter(({ risk }) => risk.level === level).length }}
        </div>
      </div>

      <div v-if="ministryProjects.length === 0" class="text-center py-20 text-slate-400 font-geist">
        No projects found for this ministry.
      </div>

      <div v-else class="bg-white rounded-2xl border border-slate-200 overflow-hidden">
        <div class="overflow-x-auto">
          <table class="w-full border-collapse" style="min-width: 900px">
            <thead>
              <!-- Year row -->
              <tr class="bg-slate-50">
                <th class="sticky left-0 z-10 bg-slate-50 w-64 min-w-64 border-r border-slate-200"></th>
                <th class="bg-slate-50 border-r border-slate-200 w-16 min-w-16"></th>
                <th
                  v-for="yg in yearGroups"
                  :key="yg.year"
                  :colspan="yg.span"
                  class="text-[10px] font-geist font-semibold text-slate-600 py-1 border-r border-slate-100 text-center"
                >
                  {{ yg.year }}
                </th>
              </tr>
              <!-- Month row -->
              <tr class="bg-slate-50 border-b border-slate-200">
                <th class="sticky left-0 z-10 bg-slate-50 px-3 py-2 text-left text-[10px] font-geist font-semibold text-slate-600 uppercase tracking-wider border-r border-slate-200">
                  Project
                </th>
                <th class="text-[10px] font-geist font-semibold text-slate-500 py-2 border-r border-slate-200 text-center">Risk</th>
                <th
                  v-for="ym in heatmapMonths"
                  :key="ym"
                  class="text-[9px] font-geist py-2 text-center w-8 min-w-8 border-r border-slate-50"
                  :class="ym === todayYM ? 'text-indigo-600 font-semibold bg-indigo-50/50' : 'text-slate-400'"
                >
                  {{ monthLabel(ym) }}
                </th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="{ project: p, risk } in ministryProjects"
                :key="p.id"
                class="border-b border-slate-50 hover:bg-slate-50/30"
              >
                <td class="sticky left-0 z-10 bg-white px-3 py-1.5 border-r border-slate-200">
                  <router-link
                    :to="`/projects/${p.id}`"
                    class="text-xs font-geist text-slate-700 hover:text-indigo-600 transition-colors truncate block max-w-60"
                    :title="p.name"
                  >
                    {{ p.name }}
                  </router-link>
                  <div class="text-[9px] font-geist text-slate-400 truncate">
                    {{ PHASE_LABELS[p.phase] || p.phase }}
                    <span v-if="p.endDate"> &middot; {{ p.endDate }}</span>
                  </div>
                </td>
                <td class="text-center px-1 py-1 border-r border-slate-200 bg-slate-50/30">
                  <span
                    class="text-[9px] font-geist font-semibold px-1.5 py-0.5 rounded-full whitespace-nowrap"
                    :style="{ backgroundColor: RISK_COLORS[risk.level] + '18', color: RISK_COLORS[risk.level] }"
                  >
                    {{ risk.label }}
                  </span>
                </td>
                <td
                  v-for="(cell, ci) in computeCells(p, risk)"
                  :key="cell.month"
                  class="text-center p-0.5"
                  :class="cell.month === todayYM ? 'bg-indigo-50/30' : ''"
                  @mouseenter="showTooltip($event, cell, p.name)"
                  @mouseleave="hideTooltip"
                >
                  <router-link
                    v-if="cell.isActive"
                    :to="`/projects/${p.id}`"
                    class="block w-full h-7 rounded-sm flex items-center justify-center text-[8px] font-geist font-medium transition-colors hover:ring-1 hover:ring-slate-300"
                    :style="{ backgroundColor: dangerColor(cell), color: dangerTextColor(cell) }"
                  >
                    <template v-if="cell.pctComplete !== null">{{ cell.pctComplete }}</template>
                  </router-link>
                  <div v-else class="w-full h-7"></div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- Legend -->
        <div class="flex items-center gap-4 px-4 py-3 border-t border-slate-100 bg-slate-50">
          <span class="text-[10px] font-geist text-slate-400">Delivery danger:</span>
          <div class="flex gap-0.5">
            <div class="w-6 h-4 rounded-sm" :style="{ backgroundColor: hexToRgba('#10b981', 0.25) }"></div>
            <div class="w-6 h-4 rounded-sm" :style="{ backgroundColor: hexToRgba('#f59e0b', 0.45) }"></div>
            <div class="w-6 h-4 rounded-sm" :style="{ backgroundColor: hexToRgba('#f97316', 0.55) }"></div>
            <div class="w-6 h-4 rounded-sm" :style="{ backgroundColor: hexToRgba('#dc2626', 0.65) }"></div>
            <div class="w-6 h-4 rounded-sm" :style="{ backgroundColor: hexToRgba('#dc2626', 0.9) }"></div>
          </div>
          <span class="text-[10px] font-geist text-slate-400">Safe → Critical</span>
          <span class="text-[10px] font-geist text-slate-400 ml-4">Cell values = % complete</span>
          <span class="text-[10px] font-geist text-indigo-500 ml-4">Blue column = current month</span>
        </div>
      </div>

      <!-- Tooltip -->
      <Teleport to="body">
        <div
          v-if="tooltip.show"
          class="fixed z-50 bg-slate-900 text-white text-xs font-geist rounded-lg px-3 py-2 pointer-events-none whitespace-pre-line max-w-xs shadow-xl"
          :style="{ left: `${tooltip.x + 12}px`, top: `${tooltip.y + 12}px` }"
        >
          {{ tooltip.content }}
        </div>
      </Teleport>
    </div>
  </div>
</template>
