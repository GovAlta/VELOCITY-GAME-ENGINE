<script setup lang="ts">
import { computed } from 'vue'
import { useProjectStore, PHASE_LABELS, PHASE_COLORS, PHASE_ORDER } from '@/stores/projects'
import { useTheme } from '@/composables/useTheme'
import { Bar, Doughnut } from 'vue-chartjs'
import {
  Chart as ChartJS, CategoryScale, LinearScale, BarElement, ArcElement,
  Title, Tooltip, Legend,
} from 'chart.js'
import {
  Zap, FolderKanban, Building2, CalendarCheck, TrendingUp,
  AlertTriangle, ArrowRight,
} from 'lucide-vue-next'

ChartJS.register(CategoryScale, LinearScale, BarElement, ArcElement, Title, Tooltip, Legend)

const store = useProjectStore()
const { chartColors } = useTheme()

const statCards = computed(() => [
  { label: 'Total Projects', value: store.stats.total, icon: FolderKanban, accent: 'text-indigo-600' },
  { label: 'Ministries', value: store.uniqueMinistries.length, icon: Building2, accent: 'text-teal-600' },
  { label: 'With Timeline', value: store.stats.withDates, icon: CalendarCheck, accent: 'text-purple-600' },
  { label: 'Avg Completion', value: `${Math.round(store.stats.avgCompletion)}%`, icon: TrendingUp, accent: 'text-amber-600' },
])

// Phase chart — uses theme-aware series colors
const phaseChartData = computed(() => {
  const palette = chartColors.value.series
  const labels: string[] = []
  const data: number[] = []
  const colors: string[] = []
  let idx = 0
  for (const phase of PHASE_ORDER) {
    const count = store.stats.byPhase[phase] || 0
    if (count > 0) {
      labels.push(PHASE_LABELS[phase] || phase)
      data.push(count)
      colors.push(palette[idx % palette.length])
      idx++
    }
  }
  return {
    labels,
    datasets: [{ data, backgroundColor: colors, borderWidth: 0 }],
  }
})

const phaseChartOptions = computed(() => ({
  responsive: true,
  maintainAspectRatio: false,
  plugins: {
    legend: {
      position: 'right' as const,
      labels: { usePointStyle: true, padding: 12, font: { size: 11 }, color: chartColors.value.text },
    },
  },
}))

// Ministry chart (top 12) — uses theme primary color
const ministryChartData = computed(() => {
  const entries = Object.entries(store.stats.byMinistry)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
  return {
    labels: entries.map(([code]) => code),
    datasets: [{
      label: 'Projects',
      data: entries.map(([, count]) => count),
      backgroundColor: chartColors.value.series[0],
      borderRadius: 4,
    }],
  }
})

const ministryChartOptions = computed(() => ({
  responsive: true,
  maintainAspectRatio: false,
  indexAxis: 'y' as const,
  plugins: { legend: { display: false } },
  scales: {
    x: { grid: { color: chartColors.value.grid }, ticks: { color: chartColors.value.text, font: { size: 11 } } },
    y: { grid: { display: false }, ticks: { color: chartColors.value.text, font: { size: 11, family: 'Geist' } } },
  },
}))

// Recent / upcoming go-lives
const upcomingGoLives = computed(() => {
  const today = new Date().toISOString().split('T')[0]
  return store.allProjects
    .filter(p => p.endDate && p.endDate >= today && p.phase !== 'completion')
    .sort((a, b) => (a.endDate || '').localeCompare(b.endDate || ''))
    .slice(0, 8)
})

// At-risk: projects with endDate in the past but not completed
const atRiskProjects = computed(() => {
  const today = new Date().toISOString().split('T')[0]
  return store.allProjects
    .filter(p => p.endDate && p.endDate < today && p.phase !== 'completion' && p.phase !== 'cancelled')
    .sort((a, b) => (a.endDate || '').localeCompare(b.endDate || ''))
    .slice(0, 8)
})
</script>

<template>
  <div class="min-h-screen">
    <!-- Hero -->
    <header class="pt-20 pb-14 px-4 md:px-8" aria-label="Hero section">
      <div class="max-w-screen-2xl mx-auto">
        <div
          class="bg-slate-50 rounded-3xl p-5 sm:p-8 md:p-14 relative overflow-hidden"
          style="box-shadow: 0 0 0 1px rgba(148,163,184,0.1), 0 4px 30px rgba(0,0,0,0.04)"
        >
          <div class="absolute top-0 right-0 w-96 h-96 bg-indigo-100 rounded-full blur-[120px] opacity-40"></div>
          <div class="absolute bottom-0 left-0 w-64 h-64 bg-teal-100 rounded-full blur-[100px] opacity-30"></div>

          <div class="relative max-w-3xl">
            <div class="flex items-center gap-2 mb-6">
              <span class="text-xs font-geist font-semibold uppercase tracking-widest text-indigo-600 bg-indigo-50 border border-indigo-100 px-3 py-1 rounded-full">
                Project Tool for AI
              </span>
            </div>
            <h1 class="text-3xl sm:text-4xl md:text-5xl lg:text-6xl font-jakarta font-bold text-slate-900 leading-[1.1] mb-6">
              Velo
              <span class="text-indigo-600">Project Velocity</span>
            </h1>
            <p class="text-lg text-slate-600 font-geist leading-relaxed mb-8 max-w-xl">
              AI-powered project tracking.
              {{ store.allProjects.length }} projects across {{ store.uniqueMinistries.length }} ministries,
              driven by hyper-factory automation.
            </p>
            <div class="flex flex-wrap gap-3">
              <router-link
                to="/projects"
                class="inline-flex items-center gap-2 px-6 py-3 bg-indigo-600 text-white rounded-full text-sm font-medium font-geist hover:bg-indigo-700 transition-colors shadow-sm"
              >
                Browse Projects
                <ArrowRight class="w-4 h-4" />
              </router-link>
              <router-link
                to="/gantt"
                class="inline-flex items-center gap-2 px-6 py-3 border border-slate-300 bg-white text-slate-700 rounded-full text-sm font-medium font-geist hover:bg-slate-50 transition-colors"
              >
                <Zap class="w-4 h-4" />
                View Gantt
              </router-link>
            </div>
          </div>
        </div>
      </div>
    </header>

    <!-- Stats -->
    <section class="px-4 md:px-8 mb-16" aria-label="Key statistics">
      <div class="max-w-screen-2xl mx-auto">
        <div class="grid sm:grid-cols-2 lg:grid-cols-4 gap-6">
          <div
            v-for="stat in statCards"
            :key="stat.label"
            class="bg-white rounded-3xl border border-slate-200 p-6"
            style="box-shadow: 0 0 0 1px rgba(148,163,184,0.08), 0 2px 12px rgba(0,0,0,0.03)"
          >
            <div class="flex items-center gap-3 mb-3">
              <div class="w-10 h-10 rounded-xl bg-slate-50 flex items-center justify-center">
                <component :is="stat.icon" class="w-5 h-5" :class="stat.accent" />
              </div>
            </div>
            <div class="text-2xl font-jakarta font-bold text-slate-900">{{ stat.value }}</div>
            <div class="text-xs font-geist text-slate-500 mt-1">{{ stat.label }}</div>
          </div>
        </div>
      </div>
    </section>

    <!-- Charts Row -->
    <section class="px-4 md:px-8 mb-16" aria-label="Charts">
      <div class="max-w-screen-2xl mx-auto grid lg:grid-cols-2 gap-6">
        <!-- Phase Distribution -->
        <div class="bg-white rounded-3xl border border-slate-200 p-6">
          <h2 class="text-lg font-jakarta font-bold text-slate-900 mb-4">Phase Distribution</h2>
          <div class="h-64">
            <Doughnut :data="phaseChartData" :options="phaseChartOptions" />
          </div>
        </div>

        <!-- Ministry Distribution -->
        <div class="bg-white rounded-3xl border border-slate-200 p-6">
          <h2 class="text-lg font-jakarta font-bold text-slate-900 mb-4">Projects by Ministry (Top 12)</h2>
          <div class="h-64">
            <Bar :data="ministryChartData" :options="ministryChartOptions" />
          </div>
        </div>
      </div>
    </section>

    <!-- Upcoming Go-Lives & At-Risk -->
    <section class="px-4 md:px-8 mb-16" aria-label="Timelines">
      <div class="max-w-screen-2xl mx-auto grid lg:grid-cols-2 gap-6">
        <!-- Upcoming -->
        <div class="bg-white rounded-3xl border border-slate-200 p-6">
          <h2 class="text-lg font-jakarta font-bold text-slate-900 mb-4 flex items-center gap-2">
            <CalendarCheck class="w-5 h-5 text-indigo-600" />
            Upcoming Go-Lives
          </h2>
          <div v-if="upcomingGoLives.length === 0" class="text-sm text-slate-400 py-4">No upcoming go-lives with dates.</div>
          <div class="space-y-3">
            <router-link
              v-for="p in upcomingGoLives"
              :key="p.id"
              :to="`/projects/${p.id}`"
              class="flex items-center justify-between p-3 rounded-xl hover:bg-slate-50 transition-colors group"
            >
              <div class="min-w-0">
                <div class="text-sm font-geist font-medium text-slate-900 truncate group-hover:text-indigo-600">{{ p.name }}</div>
                <div class="text-xs font-geist text-slate-400">{{ p.ministryCode }} &middot; {{ p.goLiveDateType || 'Objective' }}</div>
              </div>
              <div class="text-xs font-geist font-medium text-slate-600 whitespace-nowrap ml-3">{{ p.endDate }}</div>
            </router-link>
          </div>
        </div>

        <!-- At-Risk -->
        <div class="bg-white rounded-3xl border border-slate-200 p-6">
          <h2 class="text-lg font-jakarta font-bold text-slate-900 mb-4 flex items-center gap-2">
            <AlertTriangle class="w-5 h-5 text-amber-500" />
            Past Due (Not Completed)
          </h2>
          <div v-if="atRiskProjects.length === 0" class="text-sm text-slate-400 py-4">No past-due projects.</div>
          <div class="space-y-3">
            <router-link
              v-for="p in atRiskProjects"
              :key="p.id"
              :to="`/projects/${p.id}`"
              class="flex items-center justify-between p-3 rounded-xl hover:bg-slate-50 transition-colors group"
            >
              <div class="min-w-0">
                <div class="text-sm font-geist font-medium text-slate-900 truncate group-hover:text-indigo-600">{{ p.name }}</div>
                <div class="text-xs font-geist text-slate-400">{{ p.ministryCode }} &middot; {{ PHASE_LABELS[p.phase] }}</div>
              </div>
              <div class="text-xs font-geist font-medium text-red-500 whitespace-nowrap ml-3">{{ p.endDate }}</div>
            </router-link>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>
