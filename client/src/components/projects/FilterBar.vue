<script setup lang="ts">
import { useProjectStore, PHASE_LABELS } from '@/stores/projects'
import InputText from 'primevue/inputtext'
import MultiSelect from 'primevue/multiselect'
import Button from 'primevue/button'
import { Search, X } from 'lucide-vue-next'

const store = useProjectStore()

const ministryOptions = store.uniqueMinistries.map(m => ({
  label: `${m.code} - ${m.name}`,
  value: m.code,
}))

const phaseOptions = Object.entries(PHASE_LABELS).map(([key, label]) => ({
  label,
  value: key,
}))

const sourceOptions = store.uniqueSources.map(s => ({ label: s, value: s }))
</script>

<template>
  <div class="flex flex-wrap items-center gap-3">
    <div class="relative flex-1 min-w-[200px] max-w-md">
      <Search class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
      <InputText
        v-model="store.searchQuery"
        placeholder="Search projects, ministries, demand #..."
        class="w-full !pl-9"
        data-testid="search-input"
      />
    </div>

    <MultiSelect
      v-model="store.selectedMinistries"
      :options="ministryOptions"
      option-label="label"
      option-value="value"
      placeholder="Ministry"
      :max-selected-labels="2"
      class="w-48"
      data-testid="ministry-filter"
    />

    <MultiSelect
      v-model="store.selectedPhases"
      :options="phaseOptions"
      option-label="label"
      option-value="value"
      placeholder="Phase"
      :max-selected-labels="2"
      class="w-44"
      data-testid="phase-filter"
    />

    <MultiSelect
      v-model="store.selectedSources"
      :options="sourceOptions"
      option-label="label"
      option-value="value"
      placeholder="Source"
      :max-selected-labels="1"
      class="w-48"
      data-testid="source-filter"
    />

    <label class="flex items-center gap-2 text-xs font-geist cursor-pointer px-3 py-2 rounded-lg border transition-colors"
      :class="store.missionCriticalOnly ? 'border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400' : 'border-slate-200 dark:border-slate-600 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800'"
      data-testid="mission-critical-filter">
      <input type="checkbox" v-model="store.missionCriticalOnly" class="rounded accent-red-600" />
      Mission Critical
    </label>

    <Button
      v-if="store.searchQuery || store.selectedMinistries.length || store.selectedPhases.length || store.selectedSources.length || store.missionCriticalOnly"
      icon="pi pi-times"
      label="Clear"
      severity="secondary"
      size="small"
      outlined
      @click="store.clearFilters()"
      data-testid="clear-filters"
    >
      <template #icon>
        <X class="w-3.5 h-3.5 mr-1" />
      </template>
    </Button>

    <div class="text-xs font-geist text-slate-400 ml-auto">
      {{ store.filteredProjects.length }} of {{ store.allProjects.length }} projects
    </div>
  </div>
</template>
