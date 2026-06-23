<script setup lang="ts">
import { computed, ref } from 'vue'
import { useProjectStore, PHASE_LABELS, PHASE_COLORS, PHASE_ORDER } from '@/stores/projects'
import type { ProjectRecord } from '@/stores/projects'
import { useTheme } from '@/composables/useTheme'
import FilterBar from '@/components/projects/FilterBar.vue'

const store = useProjectStore()
const { chartColors } = useTheme()

const groupBy = ref<'ministry' | 'phase' | 'goLiveDateType'>('ministry')

// Generate months for the timeline header (FY 2025-04 to 2027-12)
const heatmapMonths = computed(() => {
  const result: string[] = []
  const start = new Date(2024, 6, 1) // July 2024
  const end = new Date(2027, 11, 1) // Dec 2027
  const cur = new Date(start)
  while (cur <= end) {
    result.push(`${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}`)
    cur.setMonth(cur.getMonth() + 1)
  }
  return result
})

function monthLabel(ym: string): string {
  const [y, m] = ym.split('-')
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return months[parseInt(m) - 1]
}

function yearLabel(ym: string): string {
  return ym.split('-')[0]
}

// Year groups
const yearGroups = computed(() => {
  const groups = new Map<string, number>()
  for (const ym of heatmapMonths.value) {
    const y = yearLabel(ym)
    groups.set(y, (groups.get(y) || 0) + 1)
  }
  return [...groups.entries()].map(([year, span]) => ({ year, span }))
})

// Build heatmap data
interface HeatmapRow {
  label: string
  code: string
  cells: { month: string; count: number; projects: ProjectRecord[] }[]
  total: number
}

const heatmapRows = computed((): HeatmapRow[] => {
  const projects = store.filteredProjects

  // Group projects
  const groups = new Map<string, { label: string; code: string; projects: ProjectRecord[] }>()

  for (const p of projects) {
    let key: string
    let label: string

    if (groupBy.value === 'ministry') {
      key = p.ministryCode
      label = `${p.ministryCode} - ${p.ministryName}`
    } else if (groupBy.value === 'phase') {
      key = p.phase
      label = PHASE_LABELS[p.phase] || p.phase
    } else {
      key = p.goLiveDateType || 'Unknown'
      label = p.goLiveDateType || 'Unknown'
    }

    if (!groups.has(key)) {
      groups.set(key, { label, code: key, projects: [] })
    }
    groups.get(key)!.projects.push(p)
  }

  // For each group, count projects active in each month
  const rows: HeatmapRow[] = []

  for (const [, group] of groups) {
    const cells = heatmapMonths.value.map(ym => {
      const [y, m] = ym.split('-').map(Number)
      const monthStart = new Date(y, m - 1, 1)
      const monthEnd = new Date(y, m, 0)
      const msStr = monthStart.toISOString().split('T')[0]
      const meStr = monthEnd.toISOString().split('T')[0]

      const active = group.projects.filter(p => {
        // Project is active during this month if it overlaps
        const pStart = p.startDate || p.endDate
        const pEnd = p.endDate || p.startDate
        if (!pStart && !pEnd) {
          // If no dates, show in endDate month or skip
          return false
        }
        const s = pStart || '2020-01-01'
        const e = pEnd || '2030-12-31'
        return s <= meStr && e >= msStr
      })

      return { month: ym, count: active.length, projects: active }
    })

    rows.push({
      label: group.label,
      code: group.code,
      cells,
      total: group.projects.length,
    })
  }

  // Sort by total descending
  rows.sort((a, b) => b.total - a.total)

  return rows
})

// Max count for color scaling
const maxCount = computed(() => {
  let max = 1
  for (const row of heatmapRows.value) {
    for (const cell of row.cells) {
      if (cell.count > max) max = cell.count
    }
  }
  return max
})

// Parse the theme marker color into RGB for alpha blending
function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace('#', '')
  return {
    r: parseInt(h.substring(0, 2), 16),
    g: parseInt(h.substring(2, 4), 16),
    b: parseInt(h.substring(4, 6), 16),
  }
}

function cellColor(count: number): string {
  if (count === 0) return 'transparent'
  const intensity = Math.min(count / maxCount.value, 1)
  const alpha = 0.1 + intensity * 0.85
  const { r, g, b } = hexToRgb(chartColors.value.marker)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

function cellTextColor(count: number): string {
  if (count === 0) return 'transparent'
  const intensity = count / maxCount.value
  return intensity > 0.5 ? chartColors.value.markerText : chartColors.value.marker
}

// Tooltip (hover)
const tooltip = ref<{ show: boolean; x: number; y: number; content: string }>({ show: false, x: 0, y: 0, content: '' })

function showTooltip(event: MouseEvent, cell: HeatmapRow['cells'][0], rowLabel: string) {
  if (cell.count === 0) return
  const names = cell.projects.slice(0, 3).map(p => p.name).join('\n')
  const more = cell.count > 3 ? `\n+${cell.count - 3} more — click to view all` : ''
  tooltip.value = {
    show: true,
    x: event.clientX,
    y: event.clientY,
    content: `${rowLabel} - ${cell.month}\n${cell.count} project${cell.count > 1 ? 's' : ''}\n\n${names}${more}`,
  }
}

function hideTooltip() {
  tooltip.value.show = false
}

// Modal (click)
const modal = ref<{ show: boolean; label: string; month: string; projects: ProjectRecord[] }>({ show: false, label: '', month: '', projects: [] })

function openModal(cell: HeatmapRow['cells'][0], rowLabel: string) {
  if (cell.count === 0) return
  hideTooltip()
  modal.value = { show: true, label: rowLabel, month: cell.month, projects: cell.projects }
}

function closeModal() {
  modal.value.show = false
}

function formatMonthLabel(ym: string): string {
  const [y, m] = ym.split('-')
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
  return `${months[parseInt(m) - 1]} ${y}`
}
</script>

<template>
  <div class="min-h-screen pt-8 px-4 md:px-8">
    <div class="max-w-screen-2xl mx-auto">
      <div class="mb-8">
        <h1 class="text-3xl font-jakarta font-bold text-slate-900 mb-2">Ministry Heatmap</h1>
        <p class="text-slate-500 font-geist">
          Project activity density across time. Shows how many projects are active each month.
        </p>
      </div>

      <div class="mb-6 flex flex-wrap items-end gap-4">
        <FilterBar />
      </div>

      <!-- Group by selector -->
      <div class="flex items-center gap-2 mb-4 text-xs font-geist text-slate-500">
        <span>Group by:</span>
        <button
          v-for="opt in [
            { key: 'ministry', label: 'Ministry' },
            { key: 'phase', label: 'Phase' },
            { key: 'goLiveDateType', label: 'Go-Live Type' },
          ] as const"
          :key="opt.key"
          class="px-2 py-1 rounded-md transition-colors"
          :class="groupBy === opt.key ? 'bg-indigo-50 text-indigo-600 font-medium' : 'hover:bg-slate-100'"
          @click="groupBy = opt.key"
        >
          {{ opt.label }}
        </button>
      </div>

      <div v-if="heatmapRows.length === 0" class="text-center py-20 text-slate-400 font-geist">
        No data matches the current filters.
      </div>

      <div v-else class="bg-white rounded-2xl border border-slate-200 overflow-hidden">
        <div class="overflow-x-auto">
          <table class="w-full border-collapse" style="min-width: 900px">
            <thead>
              <!-- Year row -->
              <tr class="bg-slate-50">
                <th class="sticky left-0 z-10 bg-slate-50 w-56 min-w-56 border-r border-slate-200"></th>
                <th class="bg-slate-50 border-r border-slate-200 w-12 min-w-12"></th>
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
                  {{ groupBy === 'ministry' ? 'Ministry' : groupBy === 'phase' ? 'Phase' : 'Go-Live Type' }}
                </th>
                <th class="text-[10px] font-geist font-semibold text-slate-500 py-2 border-r border-slate-200 text-center">#</th>
                <th
                  v-for="ym in heatmapMonths"
                  :key="ym"
                  class="text-[9px] font-geist text-slate-400 py-2 text-center w-8 min-w-8 border-r border-slate-50"
                >
                  {{ monthLabel(ym) }}
                </th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="row in heatmapRows"
                :key="row.code"
                class="border-b border-slate-50 hover:bg-slate-50/50"
              >
                <td class="sticky left-0 z-10 bg-white px-3 py-1.5 text-xs font-geist truncate border-r border-slate-200 max-w-56">
                  <router-link
                    v-if="groupBy === 'ministry' && row.code !== 'UNKNOWN'"
                    :to="`/heatmap/${row.code}`"
                    class="text-slate-700 hover:text-indigo-600 transition-colors"
                  >
                    {{ row.label }}
                  </router-link>
                  <span v-else class="text-slate-700">{{ row.label }}</span>
                </td>
                <td class="text-[10px] font-geist font-semibold text-slate-500 text-center border-r border-slate-200 bg-slate-50/50">
                  {{ row.total }}
                </td>
                <td
                  v-for="cell in row.cells"
                  :key="cell.month"
                  class="text-center p-0.5"
                  @mouseenter="showTooltip($event, cell, row.label)"
                  @mouseleave="hideTooltip"
                  @click="openModal(cell, row.label)"
                >
                  <div
                    class="w-full h-7 rounded-sm flex items-center justify-center text-[9px] font-geist font-medium transition-colors"
                    :class="cell.count > 0 ? 'cursor-pointer hover:ring-2 hover:ring-indigo-300' : 'cursor-default'"
                    :style="{ backgroundColor: cellColor(cell.count), color: cellTextColor(cell.count) }"
                  >
                    {{ cell.count > 0 ? cell.count : '' }}
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- Color legend -->
        <div class="flex items-center gap-3 px-4 py-3 border-t border-slate-100 bg-slate-50">
          <span class="text-[10px] font-geist text-slate-400">Density:</span>
          <div class="flex gap-1">
            <div
              v-for="i in 5"
              :key="i"
              class="w-6 h-4 rounded-sm"
              :style="{ backgroundColor: cellColor(Math.ceil((i / 5) * maxCount)) }"
            ></div>
          </div>
          <span class="text-[10px] font-geist text-slate-400">Low → High</span>
        </div>
      </div>

      <!-- Tooltip -->
      <Teleport to="body">
        <div
          v-if="tooltip.show && !modal.show"
          class="fixed z-50 bg-slate-900 text-white text-xs font-geist rounded-lg px-3 py-2 pointer-events-none whitespace-pre-line max-w-xs shadow-xl"
          :style="{ left: `${tooltip.x + 12}px`, top: `${tooltip.y + 12}px` }"
        >
          {{ tooltip.content }}
        </div>
      </Teleport>

      <!-- Cell Detail Modal -->
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
            <!-- Backdrop -->
            <div class="absolute inset-0 bg-black/40" @click="closeModal"></div>
            <!-- Modal -->
            <div class="relative bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[80vh] flex flex-col z-10 overflow-hidden">
              <!-- Header -->
              <div class="flex items-center justify-between px-6 py-4 border-b border-slate-200 bg-slate-50 flex-shrink-0">
                <div>
                  <h2 class="text-lg font-jakarta font-bold text-slate-900">{{ modal.label }}</h2>
                  <p class="text-xs font-geist text-slate-500">{{ formatMonthLabel(modal.month) }} &middot; {{ modal.projects.length }} project{{ modal.projects.length !== 1 ? 's' : '' }}</p>
                </div>
                <button @click="closeModal" class="p-2 rounded-lg hover:bg-slate-200 transition-colors" aria-label="Close modal">
                  <svg class="w-5 h-5 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              </div>
              <!-- Project list -->
              <div class="overflow-y-auto flex-1 divide-y divide-slate-100">
                <router-link
                  v-for="p in modal.projects"
                  :key="p.id"
                  :to="`/projects/${p.id}`"
                  class="flex items-center gap-4 px-6 py-3 hover:bg-slate-50 transition-colors group"
                  @click="closeModal"
                >
                  <!-- Phase dot -->
                  <div class="w-2.5 h-2.5 rounded-full flex-shrink-0" :style="{ backgroundColor: cellColor(modal.projects.length) }"></div>
                  <!-- Info -->
                  <div class="flex-1 min-w-0">
                    <div class="text-sm font-geist font-medium text-slate-900 truncate group-hover:text-indigo-600">{{ p.name }}</div>
                    <div class="text-[10px] font-geist text-slate-400">
                      {{ p.ministryCode }} &middot; {{ PHASE_LABELS[p.phase] || p.phase }}
                      <span v-if="p.projectLead"> &middot; {{ p.projectLead }}</span>
                    </div>
                  </div>
                  <!-- Progress -->
                  <div v-if="p.percentComplete !== null" class="hidden sm:flex items-center gap-2 flex-shrink-0 w-28">
                    <div class="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                      <div class="h-full rounded-full" :style="{ width: `${p.percentComplete}%`, backgroundColor: chartColors.marker }"></div>
                    </div>
                    <span class="text-[10px] font-geist text-slate-500 w-8 text-right">{{ p.percentComplete }}%</span>
                  </div>
                  <!-- Date -->
                  <div class="hidden md:block text-[10px] font-geist text-slate-400 flex-shrink-0 w-20 text-right">
                    {{ p.endDate || 'TBD' }}
                  </div>
                </router-link>
              </div>
            </div>
          </div>
        </Transition>
      </Teleport>
    </div>
  </div>
</template>
