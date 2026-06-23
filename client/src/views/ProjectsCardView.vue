<script setup lang="ts">
import { computed, ref, onActivated, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useProjectStore, PHASE_LABELS, PHASE_COLORS } from '@/stores/projects'
import { useAuthStore } from '@/stores/auth'
import { useTheme } from '@/composables/useTheme'
import api from '@/lib/api'
import FilterBar from '@/components/projects/FilterBar.vue'
import Paginator from 'primevue/paginator'
import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import Textarea from 'primevue/textarea'
import Select from 'primevue/select'
import {
  Calendar, Building2, User, AlertTriangle, FileText,
  LayoutGrid, List, Plus, Trash2,
  GitFork, ChevronDown, ChevronRight, Lock,
} from 'lucide-vue-next'
import type { ProjectRecord } from '@/stores/projects'

// Cluster row = a parent project plus the list of its clones (may be empty).
interface ProjectCluster extends ProjectRecord {
  clones: ProjectRecord[]
}

const router = useRouter()
const store = useProjectStore()
const auth = useAuthStore()

// Re-fetch projects when navigating back to this view
onMounted(() => store.loadFromApi())
const { chartColors } = useTheme()

const viewMode = ref<'cards' | 'table'>('cards')
const page = ref(0)
const rows = 24

const sortBy = ref<'name' | 'endDate' | 'ministry' | 'percentComplete'>('endDate')
const sortDir = ref<'asc' | 'desc'>('asc')

const sortedProjects = computed(() => {
  const list = [...store.filteredProjects]
  list.sort((a, b) => {
    let cmp = 0
    switch (sortBy.value) {
      case 'name':
        cmp = a.name.localeCompare(b.name)
        break
      case 'endDate':
        cmp = (a.endDate || '9999').localeCompare(b.endDate || '9999')
        break
      case 'ministry':
        cmp = a.ministryCode.localeCompare(b.ministryCode)
        break
      case 'percentComplete':
        cmp = (a.percentComplete || 0) - (b.percentComplete || 0)
        break
    }
    return sortDir.value === 'desc' ? -cmp : cmp
  })
  return list
})

// ─── Cluster grouping ────────────────────────────────────────────────
// Top-level projects show as cards. Clones are nested under their parent
// (when the parent is in the current filtered list); a "X versions" badge
// indicates the cluster size and opens an inline expander.

const expandedClusters = ref<Set<string>>(new Set())
function toggleCluster(id: string) {
  if (expandedClusters.value.has(id)) expandedClusters.value.delete(id)
  else expandedClusters.value.add(id)
}

const clusteredProjects = computed<ProjectCluster[]>(() => {
  const list = sortedProjects.value
  const idSet = new Set(list.map(p => p.id))
  const childrenMap = new Map<string, ProjectRecord[]>()

  // Bucket clones by their parent ID — but only for parents that are also in the
  // current filtered list. Otherwise the clone surfaces on its own as an orphan.
  for (const p of list) {
    if (p.fkProjectParent && idSet.has(p.fkProjectParent)) {
      const arr = childrenMap.get(p.fkProjectParent) ?? []
      arr.push(p)
      childrenMap.set(p.fkProjectParent, arr)
    }
  }

  return list
    .filter(p => !p.fkProjectParent || !idSet.has(p.fkProjectParent))
    .map(p => ({ ...p, clones: childrenMap.get(p.id) ?? [] }))
})

const paginatedProjects = computed(() => {
  const start = page.value
  return clusteredProjects.value.slice(start, start + rows)
})

function toggleSort(field: typeof sortBy.value) {
  if (sortBy.value === field) {
    sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc'
  } else {
    sortBy.value = field
    sortDir.value = 'asc'
  }
}

function phaseColor(phase: string): string {
  const palette = chartColors.value.series
  const phaseKeys = Object.keys(PHASE_COLORS)
  const idx = phaseKeys.indexOf(phase)
  if (idx >= 0) return palette[idx % palette.length]
  return chartColors.value.muted
}

function formatDate(d: string | null): string {
  if (!d) return 'TBD'
  return d
}

// Create project
const createDialog = ref(false)
const createForm = ref<Record<string, any>>({ name: '', description: '', ministryCode: 'TI', status: 'discovery', startDate: '', endDate: '' })
const creating = ref(false)

const ministrySelectOptions = computed(() =>
  store.ministries
    .map(m => ({ label: `${m.shortName} - ${m.name}`, value: m.shortName }))
    .sort((a, b) => a.label.localeCompare(b.label))
)

async function createProject() {
  // Client-side guard for the truly-required fields. The server enforces these
  // anyway; this avoids a round-trip when the form is incomplete.
  if (!createForm.value.name?.trim() || !createForm.value.ministryCode) {
    alert('Project Name and Ministry are required.')
    return
  }
  creating.value = true
  try {
    // Strip empty strings on optional fields so the server treats them as omitted
    // rather than rejecting "" as an invalid date / number.
    const payload: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(createForm.value)) {
      if (v === '' || v === undefined) continue
      payload[k] = v
    }
    const res = await api.post('/projects', payload)
    if (res.data?.success) {
      createDialog.value = false
      createForm.value = { name: '', description: '', ministryCode: 'TI', status: 'discovery', startDate: '', endDate: '' }
      await store.loadFromApi()
      // Navigate to the new project
      if (res.data.data?.pk_project) router.push(`/projects/${res.data.data.pk_project}`)
    }
  } catch (e: any) {
    const err = e?.response?.data?.error
    if (err?.code === 'VALIDATION_ERROR' && err.details?.length) {
      alert('Could not create project:\n' + err.details.map((d: any) => `• ${d.field}: ${d.message}`).join('\n'))
    } else {
      alert(err?.message || 'Failed to create project')
    }
  } finally {
    creating.value = false
  }
}

async function deleteProject(id: string, name: string) {
  if (!confirm(`Delete "${name}"? This action is reversible (soft delete).`)) return
  try {
    await api.delete(`/projects/${id}`)
    await store.loadFromApi()
  } catch (e: any) {
    alert(e?.response?.data?.error?.message || 'Failed to delete')
  }
}
</script>

<template>
  <div class="min-h-screen pt-8 px-4 md:px-8">
    <div class="max-w-screen-2xl mx-auto">
      <div class="mb-8 flex items-start justify-between">
        <div>
          <h1 class="text-3xl font-jakarta font-bold text-slate-900 mb-2">Projects</h1>
          <p class="text-slate-500 font-geist">Browse, search, and filter all tracked projects.</p>
        </div>
        <Button v-if="auth.isAuthenticated" label="New Project" icon="pi pi-plus" @click="createDialog = true" />
      </div>

      <div class="mb-6">
        <FilterBar />
      </div>

      <!-- Sort + View Toggle -->
      <div class="flex items-center gap-2 mb-4 text-xs font-geist text-slate-500">
        <span>Sort by:</span>
        <button
          v-for="opt in [
            { key: 'name', label: 'Name' },
            { key: 'endDate', label: 'Go-Live' },
            { key: 'ministry', label: 'Ministry' },
            { key: 'percentComplete', label: 'Completion' },
          ] as const"
          :key="opt.key"
          class="px-2 py-1 rounded-md transition-colors"
          :class="sortBy === opt.key ? 'bg-indigo-50 text-indigo-600 font-medium' : 'hover:bg-slate-100'"
          @click="toggleSort(opt.key)"
        >
          {{ opt.label }}
          <span v-if="sortBy === opt.key">{{ sortDir === 'asc' ? '↑' : '↓' }}</span>
        </button>

        <div class="ml-auto flex items-center gap-1 border border-slate-200 rounded-lg p-0.5">
          <button
            class="p-1.5 rounded-md transition-colors"
            :class="viewMode === 'cards' ? 'bg-indigo-50 text-indigo-600' : 'text-slate-400 hover:text-slate-600'"
            @click="viewMode = 'cards'"
            aria-label="Card view"
          >
            <LayoutGrid class="w-4 h-4" />
          </button>
          <button
            class="p-1.5 rounded-md transition-colors"
            :class="viewMode === 'table' ? 'bg-indigo-50 text-indigo-600' : 'text-slate-400 hover:text-slate-600'"
            @click="viewMode = 'table'"
            aria-label="Table view"
          >
            <List class="w-4 h-4" />
          </button>
        </div>
      </div>

      <!-- Table View -->
      <div v-if="viewMode === 'table'" class="bg-white rounded-2xl border border-slate-200 overflow-hidden mb-8">
        <div class="overflow-x-auto">
          <table class="w-full text-left">
            <thead>
              <tr class="bg-slate-50 border-b border-slate-200">
                <th class="px-4 py-3 text-[10px] font-geist font-semibold text-slate-600 uppercase tracking-wider">Name</th>
                <th class="px-3 py-3 text-[10px] font-geist font-semibold text-slate-600 uppercase tracking-wider w-20">Ministry</th>
                <th class="px-3 py-3 text-[10px] font-geist font-semibold text-slate-600 uppercase tracking-wider w-28">Phase</th>
                <th class="px-3 py-3 text-[10px] font-geist font-semibold text-slate-600 uppercase tracking-wider w-16">%</th>
                <th class="px-3 py-3 text-[10px] font-geist font-semibold text-slate-600 uppercase tracking-wider w-28 hidden md:table-cell">Go-Live</th>
                <th class="px-3 py-3 text-[10px] font-geist font-semibold text-slate-600 uppercase tracking-wider w-36 hidden lg:table-cell">Lead</th>
                <th class="px-3 py-3 text-[10px] font-geist font-semibold text-slate-600 uppercase tracking-wider w-28 hidden lg:table-cell">Demand #</th>
              </tr>
            </thead>
            <tbody>
              <template v-for="p in paginatedProjects" :key="p.id">
                <tr
                  class="border-b border-slate-50 hover:bg-slate-50 transition-colors cursor-pointer"
                  @click="$router.push(`/projects/${p.id}`)"
                >
                  <td class="px-4 py-2.5">
                    <div class="flex items-center gap-2">
                      <button
                        v-if="p.clones.length > 0"
                        @click.stop="toggleCluster(p.id)"
                        class="p-0.5 rounded hover:bg-slate-200 dark:hover:bg-slate-700"
                        :title="`${p.clones.length} version${p.clones.length === 1 ? '' : 's'}`"
                      >
                        <ChevronDown v-if="expandedClusters.has(p.id)" class="w-3.5 h-3.5 text-violet-600" />
                        <ChevronRight v-else class="w-3.5 h-3.5 text-slate-500" />
                      </button>
                      <span v-else class="w-3.5"></span>
                      <span class="text-sm font-geist text-slate-900 truncate max-w-xs">{{ p.name }}</span>
                      <span v-if="p.clones.length > 0" class="text-[10px] font-geist font-semibold px-1.5 py-0.5 rounded-full bg-violet-50 text-violet-700 flex items-center gap-1">
                        <GitFork class="w-3 h-3" /> {{ p.clones.length + 1 }}
                      </span>
                      <Lock v-if="p.projectIsLocked" class="w-3 h-3 text-rose-500" v-tooltip="'Locked'" />
                    </div>
                  </td>
                  <td class="px-3 py-2.5">
                    <span class="text-[10px] font-geist font-semibold uppercase px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-600">{{ p.ministryCode }}</span>
                  </td>
                  <td class="px-3 py-2.5">
                    <span
                      class="text-[10px] font-geist font-semibold px-1.5 py-0.5 rounded"
                      :style="{ backgroundColor: phaseColor(p.phase) + '18', color: phaseColor(p.phase) }"
                    >{{ PHASE_LABELS[p.phase] || p.phase }}</span>
                  </td>
                  <td class="px-3 py-2.5 text-xs font-geist text-slate-600">
                    {{ p.percentComplete !== null ? `${p.percentComplete}%` : '—' }}
                  </td>
                  <td class="px-3 py-2.5 text-xs font-geist text-slate-500 hidden md:table-cell">{{ p.endDate || 'TBD' }}</td>
                  <td class="px-3 py-2.5 text-xs font-geist text-slate-500 truncate max-w-36 hidden lg:table-cell">{{ p.projectLead || '—' }}</td>
                  <td class="px-3 py-2.5 text-[10px] font-geist text-slate-400 hidden lg:table-cell">{{ p.demandNumber?.split('\n')[0] || '—' }}</td>
                </tr>
                <tr
                  v-for="c in (expandedClusters.has(p.id) ? p.clones : [])"
                  :key="c.id"
                  class="border-b border-slate-50 bg-violet-50/30 dark:bg-violet-950/10 hover:bg-violet-100/50 cursor-pointer"
                  @click="$router.push(`/projects/${c.id}`)"
                >
                  <td class="px-4 py-2 pl-12">
                    <div class="flex items-center gap-2">
                      <span class="text-violet-400 text-xs">↳</span>
                      <span class="text-sm font-geist text-slate-700 truncate max-w-xs">{{ c.name }}</span>
                      <span v-if="c.projectVersionLabel" class="text-[9px] font-geist text-violet-700 px-1.5 py-0.5 rounded bg-violet-100">
                        {{ c.projectVersionLabel }}
                      </span>
                      <Lock v-if="c.projectIsLocked" class="w-3 h-3 text-rose-500" />
                    </div>
                  </td>
                  <td class="px-3 py-2">
                    <span class="text-[10px] font-geist font-semibold uppercase px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-600">{{ c.ministryCode }}</span>
                  </td>
                  <td class="px-3 py-2">
                    <span
                      class="text-[10px] font-geist font-semibold px-1.5 py-0.5 rounded"
                      :style="{ backgroundColor: phaseColor(c.phase) + '18', color: phaseColor(c.phase) }"
                    >{{ PHASE_LABELS[c.phase] || c.phase }}</span>
                  </td>
                  <td class="px-3 py-2 text-xs font-geist text-slate-600">{{ c.percentComplete !== null ? `${c.percentComplete}%` : '—' }}</td>
                  <td class="px-3 py-2 text-xs font-geist text-slate-500 hidden md:table-cell">{{ c.endDate || 'TBD' }}</td>
                  <td class="px-3 py-2 text-xs font-geist text-slate-500 truncate max-w-36 hidden lg:table-cell">{{ c.projectLead || '—' }}</td>
                  <td class="px-3 py-2 text-[10px] font-geist text-slate-400 hidden lg:table-cell">{{ c.demandNumber?.split('\n')[0] || '—' }}</td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Card Grid -->
      <div v-if="viewMode === 'cards'" class="grid sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5 mb-8">
        <div v-for="p in paginatedProjects" :key="p.id" class="contents">
        <router-link
          :to="`/projects/${p.id}`"
          class="group bg-white rounded-2xl border border-slate-200 p-5 hover:shadow-lg hover:border-indigo-200 transition-all relative overflow-hidden"
        >
          <!-- Phase indicator -->
          <div class="absolute top-0 left-0 right-0 h-1" :style="{ backgroundColor: phaseColor(p.phase) }"></div>

          <!-- Top-right badges -->
          <div class="absolute top-3 right-3 flex items-center gap-1.5">
            <Lock v-if="p.projectIsLocked" class="w-3.5 h-3.5 text-rose-500" v-tooltip="'Locked'" />
            <span v-if="p.isDuplicate"
                  class="text-[10px] font-geist font-semibold px-2 py-0.5 rounded-full bg-amber-50 text-amber-600">
              Duplicate
            </span>
            <button
              v-if="p.clones.length > 0"
              @click.prevent.stop="toggleCluster(p.id)"
              class="text-[10px] font-geist font-semibold px-2 py-0.5 rounded-full bg-violet-100 hover:bg-violet-200 text-violet-700 flex items-center gap-1"
              v-tooltip="`${p.clones.length} clone${p.clones.length === 1 ? '' : 's'} — click to ${expandedClusters.has(p.id) ? 'collapse' : 'expand'}`"
            >
              <GitFork class="w-3 h-3" /> {{ p.clones.length + 1 }}
              <ChevronDown v-if="expandedClusters.has(p.id)" class="w-3 h-3" />
              <ChevronRight v-else class="w-3 h-3" />
            </button>
          </div>

          <!-- Ministry badge -->
          <div class="flex items-center gap-2 mb-3 mt-1 flex-wrap">
            <span class="text-[10px] font-geist font-semibold uppercase px-2 py-0.5 rounded-full bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400">
              {{ p.ministryCode }}
            </span>
            <span
              class="text-[10px] font-geist font-semibold px-2 py-0.5 rounded-full"
              :style="{ backgroundColor: phaseColor(p.phase) + '18', color: phaseColor(p.phase) }"
            >
              {{ PHASE_LABELS[p.phase] || p.phase }}
            </span>
            <span
              v-if="p.isMissionCritical"
              class="text-[10px] font-geist font-semibold px-2 py-0.5 rounded-full bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400"
            >
              Mission Critical
            </span>
          </div>

          <!-- Name -->
          <h3 class="font-jakarta font-bold text-sm text-slate-900 mb-2 line-clamp-2 group-hover:text-indigo-600 transition-colors leading-snug">
            {{ p.name }}
          </h3>

          <!-- Description -->
          <p class="text-xs font-geist text-slate-500 line-clamp-2 mb-3 leading-relaxed">
            {{ p.description || 'No description available.' }}
          </p>

          <!-- Progress bar -->
          <div v-if="p.percentComplete !== null" class="mb-3">
            <div class="flex items-center justify-between mb-1">
              <span class="text-[10px] font-geist text-slate-400">Progress</span>
              <span class="text-[10px] font-geist font-medium text-slate-600">{{ p.percentComplete }}%</span>
            </div>
            <div class="h-1.5 bg-slate-100 rounded-full overflow-hidden">
              <div
                class="h-full rounded-full transition-all"
                :style="{ width: `${p.percentComplete}%`, backgroundColor: phaseColor(p.phase) }"
              ></div>
            </div>
          </div>

          <!-- Meta -->
          <div class="flex flex-wrap gap-x-3 gap-y-1 text-[10px] font-geist text-slate-400 mt-auto pt-2 border-t border-slate-100">
            <span v-if="p.endDate" class="flex items-center gap-1">
              <Calendar class="w-3 h-3" /> {{ formatDate(p.endDate) }}
            </span>
            <span v-if="p.goLiveDateType" class="flex items-center gap-1">
              <AlertTriangle class="w-3 h-3" /> {{ p.goLiveDateType }}
            </span>
            <span v-if="p.projectLead" class="flex items-center gap-1">
              <User class="w-3 h-3" /> {{ p.projectLead.split(',')[0] }}
            </span>
            <span v-if="p.demandNumber" class="flex items-center gap-1">
              <FileText class="w-3 h-3" /> {{ p.demandNumber.split('\n')[0] }}
            </span>
          </div>
        </router-link>

        <!-- Expanded clone cards (smaller, indented visual via violet outline) -->
        <router-link
          v-for="c in (expandedClusters.has(p.id) ? p.clones : [])"
          :key="c.id"
          :to="`/projects/${c.id}`"
          class="group bg-violet-50/40 dark:bg-violet-950/20 rounded-2xl border-2 border-dashed border-violet-300 dark:border-violet-700 p-4 hover:shadow-md hover:border-violet-500 transition-all relative"
        >
          <div class="absolute top-3 right-3 flex items-center gap-1.5">
            <Lock v-if="c.projectIsLocked" class="w-3.5 h-3.5 text-rose-500" />
            <span class="text-[10px] font-geist font-semibold px-1.5 py-0.5 rounded-full bg-violet-200 text-violet-800">
              clone of {{ p.name.length > 12 ? p.name.slice(0, 12) + '…' : p.name }}
            </span>
          </div>
          <div class="flex items-center gap-2 mb-2 mt-1 flex-wrap">
            <span class="text-violet-600 text-xs">↳</span>
            <span class="text-[10px] font-geist font-semibold uppercase px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-600">
              {{ c.ministryCode }}
            </span>
            <span v-if="c.projectVersionLabel"
                  class="text-[10px] font-geist font-semibold px-2 py-0.5 rounded-full bg-violet-100 text-violet-700">
              {{ c.projectVersionLabel }}
            </span>
          </div>
          <h4 class="font-jakarta font-bold text-sm text-slate-800 mb-2 line-clamp-2 leading-snug">{{ c.name }}</h4>
          <div v-if="c.percentComplete !== null" class="mb-1">
            <div class="h-1 bg-slate-100 rounded-full overflow-hidden">
              <div class="h-full rounded-full" :style="{ width: `${c.percentComplete}%`, backgroundColor: phaseColor(c.phase) }"></div>
            </div>
          </div>
          <div class="flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] font-geist text-slate-500">
            <span>{{ PHASE_LABELS[c.phase] || c.phase }}</span>
            <span v-if="c.percentComplete !== null">· {{ c.percentComplete }}%</span>
            <span v-if="c.projectLead">· {{ c.projectLead.split(',')[0] }}</span>
          </div>
        </router-link>
        </div>
      </div>

      <!-- Pagination — counts top-level projects (clusters), not individual versions -->
      <Paginator
        v-if="clusteredProjects.length > rows"
        :rows="rows"
        :totalRecords="clusteredProjects.length"
        :first="page"
        @update:first="page = $event"
        class="mb-8"
      />
      <!-- Create Project Dialog -->
      <Dialog v-model:visible="createDialog" header="New Project" :modal="true" :style="{ width: '640px' }" :breakpoints="{ '768px': '95vw' }">
        <p class="text-xs font-geist text-slate-500 mb-4">
          Fields marked <span class="text-red-500 font-bold">*</span> are required. Everything else can be filled in later.
        </p>
        <div class="grid gap-4">
          <div>
            <label class="text-xs font-geist text-slate-700 dark:text-slate-300 mb-1 block font-medium">
              Project Name <span class="text-red-500">*</span>
            </label>
            <InputText
              v-model="createForm.name"
              class="w-full"
              placeholder="Enter project name"
              :maxlength="500"
              :invalid="createForm.name !== undefined && createForm.name.length === 0"
            />
          </div>
          <div>
            <label class="text-xs font-geist text-slate-500 mb-1 block">
              Description <span class="text-slate-400">(optional)</span>
            </label>
            <Textarea v-model="createForm.description" rows="3" class="w-full" placeholder="Brief description of the project" />
          </div>
          <div class="grid grid-cols-2 gap-4">
            <div>
              <label class="text-xs font-geist text-slate-700 dark:text-slate-300 mb-1 block font-medium">
                Ministry <span class="text-red-500">*</span>
              </label>
              <Select
                v-model="createForm.ministryCode"
                :options="ministrySelectOptions"
                option-label="label"
                option-value="value"
                filter
                class="w-full"
                :invalid="!createForm.ministryCode"
              />
            </div>
            <div>
              <label class="text-xs font-geist text-slate-500 mb-1 block">
                Status <span class="text-slate-400">(optional)</span>
              </label>
              <Select v-model="createForm.status" :options="[
                { label: 'Discovery', value: 'discovery' },
                { label: 'Requirements', value: 'requirements' },
                { label: 'Development', value: 'development' },
              ]" option-label="label" option-value="value" class="w-full" />
            </div>
          </div>
          <div class="grid grid-cols-2 gap-4">
            <div>
              <label class="text-xs font-geist text-slate-500 mb-1 block">
                Start Date <span class="text-slate-400">(optional)</span>
              </label>
              <InputText v-model="createForm.startDate" type="date" max="9999-12-31" class="w-full" />
            </div>
            <div>
              <label class="text-xs font-geist text-slate-500 mb-1 block">
                End Date <span class="text-slate-400">(optional)</span>
              </label>
              <InputText v-model="createForm.endDate" type="date" max="9999-12-31" class="w-full" />
            </div>
          </div>
        </div>
        <template #footer>
          <Button label="Cancel" severity="secondary" outlined @click="createDialog = false" />
          <Button label="Create Project" icon="pi pi-check" :loading="creating" @click="createProject" :disabled="!createForm.name || !createForm.ministryCode" />
        </template>
      </Dialog>
    </div>
  </div>
</template>
