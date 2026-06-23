<script setup lang="ts">
import { computed, ref } from 'vue'
import { useProjectStore, PHASE_COLORS, PHASE_LABELS } from '@/stores/projects'
import { useTheme } from '@/composables/useTheme'
import FilterBar from '@/components/projects/FilterBar.vue'
import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut } from 'lucide-vue-next'

const store = useProjectStore()
const { chartColors } = useTheme()

// Zoom: pixels per month (scalable X axis)
const pxPerMonth = ref(80)
const MIN_PX = 24
const MAX_PX = 200

function zoomIn() {
  pxPerMonth.value = Math.min(MAX_PX, pxPerMonth.value + 16)
}
function zoomOut() {
  pxPerMonth.value = Math.max(MIN_PX, pxPerMonth.value - 16)
}

// Only show projects with both start and end dates
const ganttProjects = computed(() => {
  return store.filteredProjects
    .filter(p => p.startDate && p.endDate)
    .sort((a, b) => (a.startDate || '').localeCompare(b.startDate || ''))
})

// Timeline range
const timelineStart = computed(() => {
  const dates = ganttProjects.value.map(p => p.startDate!).filter(Boolean)
  if (dates.length === 0) return '2025-01-01'
  const min = dates.reduce((a, b) => a < b ? a : b)
  return min.substring(0, 7) + '-01'
})

const timelineEnd = computed(() => {
  const dates = ganttProjects.value.map(p => p.endDate!).filter(Boolean)
  if (dates.length === 0) return '2027-12-31'
  const max = dates.reduce((a, b) => a > b ? a : b)
  const d = new Date(max)
  d.setMonth(d.getMonth() + 1, 0)
  return d.toISOString().split('T')[0]
})

// Generate months between start and end
const months = computed(() => {
  const result: { label: string; start: string; end: string; year: number; month: number }[] = []
  const start = new Date(timelineStart.value)
  const end = new Date(timelineEnd.value)
  const cur = new Date(start.getFullYear(), start.getMonth(), 1)

  while (cur <= end) {
    const y = cur.getFullYear()
    const m = cur.getMonth()
    const mStart = `${y}-${String(m + 1).padStart(2, '0')}-01`
    const nextMonth = new Date(y, m + 1, 0)
    const mEnd = `${y}-${String(m + 1).padStart(2, '0')}-${String(nextMonth.getDate()).padStart(2, '0')}`
    const label = cur.toLocaleDateString('en-CA', { month: 'short' })
    result.push({ label, start: mStart, end: mEnd, year: y, month: m })
    cur.setMonth(cur.getMonth() + 1)
  }
  return result
})

// Total days in timeline
const totalDays = computed(() => {
  const start = new Date(timelineStart.value)
  const end = new Date(timelineEnd.value)
  return Math.max(1, (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24))
})

function dayOffset(dateStr: string): number {
  const start = new Date(timelineStart.value)
  const d = new Date(dateStr)
  return (d.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)
}

function barLeft(project: { startDate: string | null }): string {
  if (!project.startDate) return '0%'
  return `${(dayOffset(project.startDate) / totalDays.value) * 100}%`
}

function barWidth(project: { startDate: string | null; endDate: string | null }): string {
  if (!project.startDate || !project.endDate) return '1%'
  const days = dayOffset(project.endDate) - dayOffset(project.startDate)
  return `${Math.max(0.5, (days / totalDays.value) * 100)}%`
}

// Theme-aware bar color: use the chart palette series, cycling per phase
function barColor(phase: string): string {
  const palette = chartColors.value.series
  const phaseKeys = Object.keys(PHASE_COLORS)
  const idx = phaseKeys.indexOf(phase)
  if (idx >= 0) return palette[idx % palette.length]
  return chartColors.value.muted
}

// Scrollable container
const scrollContainer = ref<HTMLElement | null>(null)

function scrollLeft() {
  scrollContainer.value?.scrollBy({ left: -300, behavior: 'smooth' })
}

function scrollRight() {
  scrollContainer.value?.scrollBy({ left: 300, behavior: 'smooth' })
}

// Today marker
const todayOffset = computed(() => {
  const today = new Date().toISOString().split('T')[0]
  const offset = dayOffset(today)
  if (offset < 0 || offset > totalDays.value) return null
  return `${(offset / totalDays.value) * 100}%`
})

// Group unique years
const years = computed(() => {
  const ySet = new Map<number, { start: number; span: number }>()
  for (let i = 0; i < months.value.length; i++) {
    const y = months.value[i].year
    if (!ySet.has(y)) {
      ySet.set(y, { start: i, span: 1 })
    } else {
      ySet.get(y)!.span++
    }
  }
  return [...ySet.entries()].map(([year, { start, span }]) => ({ year, start, span }))
})

// Timeline width based on zoom
const timelineWidth = computed(() => `${months.value.length * pxPerMonth.value}px`)
</script>

<template>
  <div class="min-h-screen pt-8 px-4 md:px-8">
    <div class="max-w-screen-2xl mx-auto">
      <div class="mb-8">
        <h1 class="text-3xl font-jakarta font-bold text-slate-900 mb-2">Gantt Chart</h1>
        <p class="text-slate-500 font-geist">
          Timeline view of {{ ganttProjects.length }} projects with start and end dates.
        </p>
      </div>

      <div class="mb-6">
        <FilterBar />
      </div>

      <div v-if="ganttProjects.length === 0" class="text-center py-20 text-slate-400 font-geist">
        No projects with both start and end dates match the current filters.
      </div>

      <div v-else class="bg-white rounded-2xl border border-slate-200 overflow-hidden">
        <!-- Scroll + Zoom controls -->
        <div class="flex items-center justify-between px-4 py-2 border-b border-slate-100 bg-slate-50">
          <span class="text-xs font-geist text-slate-500">{{ timelineStart }} to {{ timelineEnd }}</span>
          <div class="flex items-center gap-3">
            <div class="flex items-center gap-1 text-xs font-geist text-slate-500">
              <button @click="zoomOut" class="p-1 rounded hover:bg-slate-200 transition-colors" aria-label="Zoom out" :disabled="pxPerMonth <= MIN_PX">
                <ZoomOut class="w-4 h-4" :class="pxPerMonth <= MIN_PX ? 'text-slate-300' : 'text-slate-500'" />
              </button>
              <input
                type="range"
                :min="MIN_PX"
                :max="MAX_PX"
                :step="8"
                v-model.number="pxPerMonth"
                class="w-24 h-1 accent-indigo-600"
                aria-label="Timeline zoom"
              />
              <button @click="zoomIn" class="p-1 rounded hover:bg-slate-200 transition-colors" aria-label="Zoom in" :disabled="pxPerMonth >= MAX_PX">
                <ZoomIn class="w-4 h-4" :class="pxPerMonth >= MAX_PX ? 'text-slate-300' : 'text-slate-500'" />
              </button>
            </div>
            <div class="flex gap-1 border-l border-slate-200 pl-3">
              <button @click="scrollLeft" class="p-1 rounded hover:bg-slate-200 transition-colors" aria-label="Scroll left">
                <ChevronLeft class="w-4 h-4 text-slate-500" />
              </button>
              <button @click="scrollRight" class="p-1 rounded hover:bg-slate-200 transition-colors" aria-label="Scroll right">
                <ChevronRight class="w-4 h-4 text-slate-500" />
              </button>
            </div>
          </div>
        </div>

        <div class="flex">
          <!-- Project names (fixed left column) -->
          <div class="w-60 min-w-60 flex-shrink-0 border-r border-slate-200 bg-white z-10">
            <div class="h-6 border-b border-slate-100 bg-slate-50"></div>
            <div class="h-8 border-b border-slate-200 bg-slate-50"></div>
            <div
              v-for="p in ganttProjects"
              :key="p.id"
              class="h-10 px-3 flex items-center border-b border-slate-50"
            >
              <router-link
                :to="`/projects/${p.id}`"
                class="text-xs font-geist text-slate-700 truncate hover:text-indigo-600 transition-colors"
                :title="p.name"
              >
                <span class="text-[10px] text-slate-400 mr-1">{{ p.ministryCode }}</span>
                {{ p.name }}
              </router-link>
            </div>
          </div>

          <!-- Timeline area -->
          <div ref="scrollContainer" class="flex-1 overflow-x-auto">
            <div :style="{ minWidth: timelineWidth }" class="relative">
              <!-- Year headers -->
              <div class="flex h-6 border-b border-slate-100 bg-slate-50">
                <div
                  v-for="y in years"
                  :key="y.year"
                  class="text-[10px] font-geist font-semibold text-slate-600 flex items-center justify-center border-r border-slate-100"
                  :style="{ width: `${(y.span / months.length) * 100}%` }"
                >
                  {{ y.year }}
                </div>
              </div>

              <!-- Month headers -->
              <div class="flex h-8 border-b border-slate-200 bg-slate-50">
                <div
                  v-for="m in months"
                  :key="m.start"
                  class="text-[10px] font-geist text-slate-500 flex items-center justify-center border-r border-slate-100 flex-shrink-0"
                  :style="{ width: `${100 / months.length}%` }"
                >
                  {{ pxPerMonth >= 48 ? m.label : m.label.charAt(0) }}
                </div>
              </div>

              <!-- Today marker -->
              <div
                v-if="todayOffset"
                class="absolute top-0 bottom-0 w-px bg-red-400 z-20 pointer-events-none"
                :style="{ left: todayOffset }"
              >
                <div class="absolute -top-0 -left-2 text-[8px] font-geist font-semibold text-red-500 bg-red-50 px-1 rounded">
                  Today
                </div>
              </div>

              <!-- Project bars -->
              <div class="relative">
                <div
                  v-for="p in ganttProjects"
                  :key="p.id"
                  class="h-10 relative border-b border-slate-50"
                >
                  <!-- Grid lines -->
                  <div class="absolute inset-0 flex pointer-events-none">
                    <div
                      v-for="m in months"
                      :key="m.start"
                      class="border-r border-slate-50 flex-shrink-0"
                      :style="{ width: `${100 / months.length}%` }"
                    ></div>
                  </div>
                  <!-- Bar -->
                  <router-link
                    :to="`/projects/${p.id}`"
                    class="absolute top-2 h-6 rounded-md cursor-pointer hover:opacity-80 transition-opacity flex items-center px-2 overflow-hidden"
                    :style="{
                      left: barLeft(p),
                      width: barWidth(p),
                      backgroundColor: barColor(p.phase),
                    }"
                    :title="`${p.name} (${p.startDate} → ${p.endDate})`"
                  >
                    <span class="text-[9px] text-white font-geist font-medium truncate whitespace-nowrap">
                      {{ p.name }}
                    </span>
                    <!-- Progress overlay -->
                    <div
                      v-if="p.percentComplete != null && p.percentComplete < 100"
                      class="absolute top-0 left-0 bottom-0 bg-black/10 rounded-l-md pointer-events-none"
                      :style="{ width: `${p.percentComplete}%` }"
                    ></div>
                  </router-link>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Legend — theme-aware -->
        <div class="flex flex-wrap gap-3 px-4 py-3 border-t border-slate-100 bg-slate-50">
          <div
            v-for="(label, phase) in PHASE_LABELS"
            :key="phase"
            class="flex items-center gap-1.5 text-[10px] font-geist text-slate-500"
          >
            <div class="w-3 h-3 rounded-sm" :style="{ backgroundColor: barColor(String(phase)) }"></div>
            {{ label }}
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
