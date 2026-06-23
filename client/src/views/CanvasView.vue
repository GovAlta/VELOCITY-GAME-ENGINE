<script setup lang="ts">
import { ref, computed, onMounted, watch, markRaw, h } from 'vue'
import { VueFlow, useVueFlow, Position, MarkerType } from '@vue-flow/core'
import { Background } from '@vue-flow/background'
import { Controls } from '@vue-flow/controls'
import { MiniMap } from '@vue-flow/minimap'
import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'
import '@vue-flow/controls/dist/style.css'
import '@vue-flow/minimap/dist/style.css'
import { useAuthStore } from '@/stores/auth'
import api from '@/lib/api'
import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import Select from 'primevue/select'
import InputText from 'primevue/inputtext'
import MultiSelect from 'primevue/multiselect'
import { Save, RotateCcw, Link2, Filter, X, Maximize2 } from 'lucide-vue-next'

const auth = useAuthStore()

// ─── Data ────────────────────────────────────────────────
interface CanvasProject {
  pk_project: string; project_code: string; project_name: string; project_status: string;
  project_percent_complete: number | null; project_start_date: string | null; project_end_date: string | null;
  canvas_x: number | null; canvas_y: number | null; ministry_code: string; ministry_name: string;
}
interface CanvasModule {
  pk_module: string; fk_module_project: string; module_name: string; module_status: string;
  module_percent_complete: number | null; canvas_x: number | null; canvas_y: number | null;
}
interface CanvasDependency {
  pk_project_dependency: string; fk_dependency_from: string; fk_dependency_to: string;
  dependency_type: string; dependency_label: string | null;
}

const projects = ref<CanvasProject[]>([])
const modules = ref<CanvasModule[]>([])
const dependencies = ref<CanvasDependency[]>([])
const loading = ref(true)
const saving = ref(false)

// Filters
const selectedMinistries = ref<string[]>([])
const focusedProjectId = ref<string | null>(null)
const showModules = ref(true)

const uniqueMinistries = computed(() => {
  const set = new Map<string, string>()
  for (const p of projects.value) { if (p.ministry_code) set.set(p.ministry_code, p.ministry_name) }
  return [...set.entries()].map(([code, name]) => ({ label: `${code} - ${name}`, value: code })).sort((a,b) => a.label.localeCompare(b.label))
})

// ─── Status colors ───────────────────────────────────────
const STATUS_COLORS: Record<string, string> = {
  discovery: '#8b5cf6', requirements: '#6366f1', development: '#0891b2',
  testing: '#f59e0b', client_review: '#f97316', client_acceptance: '#10b981',
  completion: '#059669', on_hold: '#94a3b8', cancelled: '#ef4444',
  // Module statuses
  requirements_gathering: '#6366f1', building: '#0891b2', client_sign_off: '#10b981',
  delivered: '#059669', closed: '#64748b',
}

function statusColor(status: string): string {
  return STATUS_COLORS[status] || '#94a3b8'
}

function riskColor(p: CanvasProject): string {
  if (p.project_status === 'completion') return '#059669'
  if (!p.project_start_date || !p.project_end_date || p.project_percent_complete == null) return statusColor(p.project_status)
  const now = Date.now()
  const start = new Date(p.project_start_date).getTime()
  const end = new Date(p.project_end_date).getTime()
  const total = end - start
  if (total <= 0) return statusColor(p.project_status)
  const elapsed = (now - start) / total
  const expected = Math.min(elapsed * 100, 100)
  const gap = expected - p.project_percent_complete
  if (gap <= 5) return '#10b981'
  if (gap <= 20) return '#f59e0b'
  if (gap <= 40) return '#f97316'
  return '#dc2626'
}

// ─── Load ────────────────────────────────────────────────
async function loadCanvas() {
  loading.value = true
  try {
    const res = await api.get('/canvas')
    if (res.data?.success) {
      projects.value = res.data.data.projects
      modules.value = res.data.data.modules
      dependencies.value = res.data.data.dependencies
    }
  } catch { /* fallback empty */ }
  loading.value = false
}

onMounted(loadCanvas)

// ─── Vue Flow nodes + edges ──────────────────────────────
const { onNodeDragStop, fitView } = useVueFlow()

const filteredProjects = computed(() => {
  let list = projects.value
  if (selectedMinistries.value.length > 0) {
    list = list.filter(p => selectedMinistries.value.includes(p.ministry_code))
  }
  if (focusedProjectId.value) {
    const linked = new Set<string>([focusedProjectId.value])
    for (const d of dependencies.value) {
      if (d.fk_dependency_from === focusedProjectId.value) linked.add(d.fk_dependency_to)
      if (d.fk_dependency_to === focusedProjectId.value) linked.add(d.fk_dependency_from)
    }
    list = list.filter(p => linked.has(p.pk_project))
  }
  return list
})

const filteredProjectIds = computed(() => new Set(filteredProjects.value.map(p => p.pk_project)))

const nodes = computed(() => {
  const result: any[] = []
  let autoX = 50, autoY = 50, col = 0

  for (const p of filteredProjects.value) {
    const x = p.canvas_x ?? autoX
    const y = p.canvas_y ?? autoY

    result.push({
      id: p.pk_project,
      type: 'default',
      position: { x, y },
      data: { label: '' },
      style: {
        background: '#ffffff',
        border: `3px solid ${riskColor(p)}`,
        borderRadius: '12px',
        padding: '0',
        width: '220px',
        minHeight: '60px',
        fontSize: '11px',
        boxShadow: '0 2px 8px rgba(0,0,0,0.06)',
      },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      label: `${p.project_code || ''} ${p.project_name}`.trim(),
    })

    // Module nodes
    if (showModules.value) {
      const projModules = modules.value.filter(m => m.fk_module_project === p.pk_project)
      let modY = y + 90
      for (const m of projModules) {
        const mx = m.canvas_x ?? (x + 20)
        const my = m.canvas_y ?? modY
        result.push({
          id: m.pk_module,
          type: 'default',
          position: { x: mx, y: my },
          parentId: undefined,
          data: { label: '' },
          style: {
            background: statusColor(m.module_status) + '15',
            border: `2px solid ${statusColor(m.module_status)}`,
            borderRadius: '8px',
            padding: '0',
            width: '180px',
            minHeight: '36px',
            fontSize: '10px',
          },
          sourcePosition: Position.Right,
          targetPosition: Position.Left,
          label: m.module_name,
        })
        modY += 50
      }
    }

    autoX += 280
    col++
    if (col >= 5) { col = 0; autoX = 50; autoY += 300 }
  }
  return result
})

const edges = computed(() => {
  const result: any[] = []

  // Project-to-module edges
  if (showModules.value) {
    for (const m of modules.value) {
      if (!filteredProjectIds.value.has(m.fk_module_project)) continue
      result.push({
        id: `pm-${m.fk_module_project}-${m.pk_module}`,
        source: m.fk_module_project,
        target: m.pk_module,
        type: 'smoothstep',
        animated: false,
        style: { stroke: '#cbd5e1', strokeWidth: 1 },
      })
    }
  }

  // Dependency edges
  const depTypeLabels: Record<string, string> = {
    finish_to_start: 'FS', start_to_start: 'SS', finish_to_finish: 'FF', start_to_finish: 'SF', other: '→',
  }
  const depTypeColors: Record<string, string> = {
    finish_to_start: '#6366f1', start_to_start: '#0891b2', finish_to_finish: '#f59e0b', start_to_finish: '#f97316', other: '#94a3b8',
  }

  for (const d of dependencies.value) {
    if (!filteredProjectIds.value.has(d.fk_dependency_from) || !filteredProjectIds.value.has(d.fk_dependency_to)) continue
    result.push({
      id: d.pk_project_dependency,
      source: d.fk_dependency_from,
      target: d.fk_dependency_to,
      type: 'smoothstep',
      animated: true,
      label: d.dependency_label || depTypeLabels[d.dependency_type] || '→',
      labelStyle: { fontSize: '10px', fontWeight: '600', fill: depTypeColors[d.dependency_type] || '#94a3b8' },
      labelBgStyle: { fill: '#ffffff', fillOpacity: 0.9 },
      labelBgPadding: [4, 2] as [number, number],
      style: { stroke: depTypeColors[d.dependency_type] || '#94a3b8', strokeWidth: 2 },
      markerEnd: MarkerType.ArrowClosed,
    })
  }

  return result
})

// ─── Position persistence ────────────────────────────────
const dirtyPositions = ref(new Map<string, { x: number; y: number; type: 'project' | 'module' }>())

onNodeDragStop(({ node }) => {
  const isModule = modules.value.some(m => m.pk_module === node.id)
  dirtyPositions.value.set(node.id, { x: node.position.x, y: node.position.y, type: isModule ? 'module' : 'project' })
})

async function savePositions() {
  saving.value = true
  const projectPositions: { id: string; x: number; y: number }[] = []
  const modulePositions: { id: string; x: number; y: number }[] = []

  for (const [id, pos] of dirtyPositions.value) {
    if (pos.type === 'project') projectPositions.push({ id, x: pos.x, y: pos.y })
    else modulePositions.push({ id, x: pos.x, y: pos.y })
  }

  try {
    await api.post('/canvas/positions', { projects: projectPositions, modules: modulePositions })
    dirtyPositions.value.clear()
  } catch (e: any) { alert(e?.response?.data?.error?.message || 'Failed to save') }
  saving.value = false
}

async function resetCanvas() {
  if (!confirm('Reset all project/module positions? They will auto-layout next time.')) return
  try {
    await api.post('/canvas/reset')
    await loadCanvas()
    dirtyPositions.value.clear()
    setTimeout(() => fitView({ padding: 0.2 }), 100)
  } catch { /* ignore */ }
}

// ─── Add dependency dialog ───────────────────────────────
const depDialog = ref(false)
const depForm = ref<Record<string, any>>({ fromProjectId: '', toProjectId: '', type: 'finish_to_start', label: '', notes: '' })
const projectOptions = computed(() =>
  projects.value.map(p => ({ label: `${p.project_code || ''} ${p.project_name}`.trim(), value: p.pk_project }))
    .sort((a, b) => a.label.localeCompare(b.label))
)

const depTypeOptions = [
  { label: 'Finish to Start (FS)', value: 'finish_to_start' },
  { label: 'Start to Start (SS)', value: 'start_to_start' },
  { label: 'Finish to Finish (FF)', value: 'finish_to_finish' },
  { label: 'Start to Finish (SF)', value: 'start_to_finish' },
  { label: 'Other', value: 'other' },
]

async function saveDependency() {
  try {
    await api.post('/canvas/dependencies', depForm.value)
    depDialog.value = false
    await loadCanvas()
  } catch (e: any) { alert(e?.response?.data?.error?.message || 'Failed') }
}

async function deleteDependency(id: string) {
  if (!confirm('Remove this dependency link?')) return
  try { await api.delete(`/canvas/dependencies/${id}`); await loadCanvas() }
  catch { /* ignore */ }
}

function focusProject(id: string) {
  focusedProjectId.value = focusedProjectId.value === id ? null : id
}

function clearFilters() {
  selectedMinistries.value = []
  focusedProjectId.value = null
}
</script>

<template>
  <div class="h-screen flex flex-col">
    <!-- Toolbar -->
    <div class="flex items-center gap-3 px-4 py-2 border-b border-slate-200 bg-white z-10 flex-shrink-0">
      <h1 class="text-lg font-jakarta font-bold text-slate-900">Canvas</h1>

      <MultiSelect
        v-model="selectedMinistries"
        :options="uniqueMinistries"
        option-label="label"
        option-value="value"
        placeholder="Filter Ministry"
        :max-selected-labels="2"
        class="w-52 text-xs"
      />

      <label class="flex items-center gap-1.5 text-xs font-geist text-slate-600 cursor-pointer">
        <input type="checkbox" v-model="showModules" class="rounded" />
        Modules
      </label>

      <div v-if="focusedProjectId" class="flex items-center gap-1 text-xs font-geist bg-indigo-50 text-indigo-600 px-2 py-1 rounded-lg">
        Focused
        <button @click="focusedProjectId = null" class="hover:text-indigo-800"><X class="w-3 h-3" /></button>
      </div>

      <Button v-if="selectedMinistries.length || focusedProjectId" label="Clear" icon="pi pi-times" size="small" severity="secondary" text @click="clearFilters" />

      <div class="ml-auto flex items-center gap-2">
        <span v-if="dirtyPositions.size > 0" class="text-[10px] font-geist text-amber-600">{{ dirtyPositions.size }} unsaved</span>

        <Button v-if="auth.isAuthenticated" label="Link Projects" icon="pi pi-link" size="small" severity="info" outlined @click="depDialog = true" />
        <Button v-if="auth.isAuthenticated && dirtyPositions.size > 0" label="Save Layout" icon="pi pi-save" size="small" :loading="saving" @click="savePositions" />
        <Button v-if="auth.isAuthenticated" icon="pi pi-refresh" size="small" severity="secondary" text rounded v-tooltip="'Reset layout'" @click="resetCanvas" />
        <Button icon="pi pi-arrows-alt" size="small" severity="secondary" text rounded v-tooltip="'Fit to view'" @click="fitView({ padding: 0.2 })" />
      </div>
    </div>

    <!-- Loading -->
    <div v-if="loading" class="flex-1 flex items-center justify-center text-slate-400 font-geist">Loading canvas...</div>

    <!-- Vue Flow -->
    <div v-else class="flex-1">
      <VueFlow
        :nodes="nodes"
        :edges="edges"
        :default-viewport="{ zoom: 0.6, x: 50, y: 50 }"
        :min-zoom="0.1"
        :max-zoom="2"
        fit-view-on-init
        @node-click="({ node }) => focusProject(node.id)"
      >
        <Background />
        <Controls />
        <MiniMap />

        <!-- Custom node template -->
        <template #node-default="{ data, label, id }">
          <div class="px-3 py-2 cursor-pointer select-none">
            <div class="font-geist font-medium leading-tight truncate" style="max-width: 200px">{{ label }}</div>
          </div>
        </template>
      </VueFlow>
    </div>

    <!-- Dependency legend (bottom bar) -->
    <div class="flex items-center gap-4 px-4 py-1.5 border-t border-slate-200 bg-slate-50 text-[10px] font-geist text-slate-500 flex-shrink-0">
      <span class="font-semibold text-slate-600">Dependencies:</span>
      <span class="flex items-center gap-1"><span class="w-3 h-0.5 bg-indigo-500 inline-block"></span> FS</span>
      <span class="flex items-center gap-1"><span class="w-3 h-0.5 bg-cyan-600 inline-block"></span> SS</span>
      <span class="flex items-center gap-1"><span class="w-3 h-0.5 bg-amber-500 inline-block"></span> FF</span>
      <span class="flex items-center gap-1"><span class="w-3 h-0.5 bg-orange-500 inline-block"></span> SF</span>
      <span class="flex items-center gap-1"><span class="w-3 h-0.5 bg-slate-400 inline-block"></span> Other</span>
      <span class="ml-4 font-semibold text-slate-600">Borders:</span>
      <span class="flex items-center gap-1"><span class="w-3 h-3 rounded border-2 border-green-500 inline-block"></span> On Track</span>
      <span class="flex items-center gap-1"><span class="w-3 h-3 rounded border-2 border-amber-500 inline-block"></span> At Risk</span>
      <span class="flex items-center gap-1"><span class="w-3 h-3 rounded border-2 border-orange-500 inline-block"></span> Behind</span>
      <span class="flex items-center gap-1"><span class="w-3 h-3 rounded border-2 border-red-600 inline-block"></span> Critical</span>
      <span class="ml-auto">{{ filteredProjects.length }} projects &middot; {{ dependencies.length }} dependencies &middot; Click project to focus</span>
    </div>

    <!-- Add Dependency Dialog -->
    <Dialog v-model:visible="depDialog" header="Link Projects (Dependency)" :modal="true" :style="{ width: '580px' }" :breakpoints="{ '768px': '95vw' }">
      <div class="grid gap-4">
        <div>
          <label class="text-xs font-geist text-slate-500 mb-1 block">From Project <span class="text-red-500">*</span></label>
          <Select v-model="depForm.fromProjectId" :options="projectOptions" option-label="label" option-value="value" filter placeholder="Select source project" class="w-full" />
        </div>
        <div>
          <label class="text-xs font-geist text-slate-500 mb-1 block">To Project <span class="text-red-500">*</span></label>
          <Select v-model="depForm.toProjectId" :options="projectOptions" option-label="label" option-value="value" filter placeholder="Select target project" class="w-full" />
        </div>
        <div class="grid grid-cols-2 gap-4">
          <div>
            <label class="text-xs font-geist text-slate-500 mb-1 block">Dependency Type</label>
            <Select v-model="depForm.type" :options="depTypeOptions" option-label="label" option-value="value" class="w-full" />
          </div>
          <div>
            <label class="text-xs font-geist text-slate-500 mb-1 block">Label (optional)</label>
            <InputText v-model="depForm.label" class="w-full" placeholder="e.g. Data feed" />
          </div>
        </div>
        <div>
          <label class="text-xs font-geist text-slate-500 mb-1 block">Notes</label>
          <InputText v-model="depForm.notes" class="w-full" />
        </div>
      </div>
      <template #footer>
        <Button label="Cancel" severity="secondary" outlined @click="depDialog = false" />
        <Button label="Create Link" icon="pi pi-link" @click="saveDependency" :disabled="!depForm.fromProjectId || !depForm.toProjectId || depForm.fromProjectId === depForm.toProjectId" />
      </template>
    </Dialog>
  </div>
</template>

<style>
/* Vue Flow overrides */
.vue-flow__node-default {
  padding: 0 !important;
  border: none !important;
  background: transparent !important;
}
.vue-flow__edge-label {
  font-family: 'Geist', sans-serif !important;
}
</style>
