<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import api from '@/lib/api'
import InputText from 'primevue/inputtext'
import MultiSelect from 'primevue/multiselect'
import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import Select from 'primevue/select'
import Textarea from 'primevue/textarea'
import { Search, X, FileText, AlertTriangle, Clock, CheckCircle, ChevronLeft, ChevronRight, ZoomIn, ZoomOut, Plus } from 'lucide-vue-next'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Contract {
  pk_contract: string
  contract_external_id: string | null
  contract_commodity_type: string | null
  contract_name: string
  contract_description: string | null
  contract_vendor: string | null
  contract_effective_date: string | null
  contract_expiration_date: string | null
  contract_hierarchy_type: string | null
  ministry_code: string | null
  ministry_name: string | null
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const loading = ref(true)
const searchQuery = ref('')
const selectedMinistries = ref<string[]>([])
const selectedVendors = ref<string[]>([])
const selectedCommodityTypes = ref<string[]>([])
const viewMode = ref<'gantt' | 'table'>('gantt')
const pagination = ref({ page: 1, limit: 50, total: 0, totalPages: 0 })

// All contracts for gantt/stats (loaded once, not paginated)
const allContracts = ref<Contract[]>([])

// Filter options (loaded once)
const filterOptions = ref<{ ministries: string[]; vendors: string[]; commodityTypes: string[] }>({
  ministries: [], vendors: [], commodityTypes: [],
})

// Detail dialog
const detailDialog = ref(false)
const selectedContract = ref<Contract | null>(null)

// Create/Edit dialog
const editDialog = ref(false)
const editingId = ref<string | null>(null)
const editForm = ref<Record<string, any>>({})
const saving = ref(false)

// Gantt zoom
const pxPerMonth = ref(60)
const MIN_PX = 20
const MAX_PX = 160
const scrollContainer = ref<HTMLElement | null>(null)

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

async function loadAllContracts() {
  loading.value = true
  try {
    // Load all contracts (paginated fetch)
    const firstRes = await api.get('/contracts', { params: { limit: 500, page: 1 } })
    if (!firstRes.data?.success) { loading.value = false; return }
    const all: Contract[] = firstRes.data.data || []
    const meta = firstRes.data.meta || firstRes.data.pagination
    if (meta && meta.total > 500) {
      const pages = Math.ceil(meta.total / 500)
      for (let p = 2; p <= pages; p++) {
        const more = await api.get('/contracts', { params: { limit: 500, page: p } })
        if (more.data?.success) all.push(...(more.data.data || []))
      }
    }
    allContracts.value = all
    filterOptions.value = {
      ministries: [...new Set(all.map(c => c.ministry_name).filter(Boolean) as string[])].sort(),
      vendors: [...new Set(all.map(c => c.contract_vendor).filter(Boolean) as string[])].sort(),
      commodityTypes: [...new Set(all.map(c => c.contract_commodity_type).filter(Boolean) as string[])].sort(),
    }
  } catch { /* ignore */ }
  loading.value = false
}

onMounted(loadAllContracts)

// ---------------------------------------------------------------------------
// Computed: filter options + client-side filtering on full dataset
// ---------------------------------------------------------------------------

const uniqueMinistries = computed(() => filterOptions.value.ministries)
const uniqueVendors = computed(() => filterOptions.value.vendors)
const uniqueCommodityTypes = computed(() => filterOptions.value.commodityTypes)

const filtered = computed(() => {
  let result = allContracts.value

  if (searchQuery.value) {
    const q = searchQuery.value.toLowerCase()
    result = result.filter(c =>
      c.contract_name.toLowerCase().includes(q) ||
      (c.contract_vendor || '').toLowerCase().includes(q) ||
      (c.contract_external_id || '').toLowerCase().includes(q) ||
      (c.contract_description || '').toLowerCase().includes(q)
    )
  }

  if (selectedMinistries.value.length > 0) {
    result = result.filter(c => c.ministry_name && selectedMinistries.value.includes(c.ministry_name))
  }
  if (selectedVendors.value.length > 0) {
    result = result.filter(c => c.contract_vendor && selectedVendors.value.includes(c.contract_vendor))
  }
  if (selectedCommodityTypes.value.length > 0) {
    result = result.filter(c => c.contract_commodity_type && selectedCommodityTypes.value.includes(c.contract_commodity_type))
  }

  return result
})

// Pagination on the filtered set
const paginatedContracts = computed(() => {
  const start = (pagination.value.page - 1) * pagination.value.limit
  return filtered.value.slice(start, start + pagination.value.limit)
})

// Keep pagination metadata in sync
watch(filtered, () => {
  pagination.value.total = filtered.value.length
  pagination.value.totalPages = Math.ceil(filtered.value.length / pagination.value.limit)
  if (pagination.value.page > pagination.value.totalPages && pagination.value.totalPages > 0) {
    pagination.value.page = 1
  }
}, { immediate: true })

function goToPage(p: number) {
  if (p < 1 || p > pagination.value.totalPages) return
  pagination.value.page = p
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

const today = new Date().toISOString().split('T')[0]

function daysUntilExpiry(c: Contract): number | null {
  if (!c.contract_expiration_date) return null
  return Math.ceil((new Date(c.contract_expiration_date).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
}

function expiryStatus(c: Contract): 'expired' | 'critical' | 'warning' | 'active' | 'unknown' {
  const days = daysUntilExpiry(c)
  if (days === null) return 'unknown'
  if (days < 0) return 'expired'
  if (days <= 90) return 'critical'
  if (days <= 365) return 'warning'
  return 'active'
}

function expiryBadge(status: string): string {
  switch (status) {
    case 'expired': return 'bg-slate-200 text-slate-600'
    case 'critical': return 'bg-red-100 text-red-700'
    case 'warning': return 'bg-amber-100 text-amber-700'
    case 'active': return 'bg-green-100 text-green-700'
    default: return 'bg-slate-100 text-slate-500'
  }
}

function expiryLabel(status: string): string {
  switch (status) {
    case 'expired': return 'Expired'
    case 'critical': return 'Expiring < 90d'
    case 'warning': return 'Expiring < 1yr'
    case 'active': return 'Active'
    default: return 'Unknown'
  }
}

const stats = computed(() => {
  let expired = 0, critical = 0, warning = 0, active = 0
  for (const c of filtered.value) {
    const s = expiryStatus(c)
    if (s === 'expired') expired++
    else if (s === 'critical') critical++
    else if (s === 'warning') warning++
    else if (s === 'active') active++
  }
  return { total: filtered.value.length, expired, critical, warning, active }
})

// ---------------------------------------------------------------------------
// Gantt chart
// ---------------------------------------------------------------------------

const ganttContracts = computed(() =>
  filtered.value
    .filter(c => c.contract_effective_date && c.contract_expiration_date)
    .sort((a, b) => (a.contract_expiration_date || '').localeCompare(b.contract_expiration_date || ''))
)

const timelineStart = computed(() => {
  const dates = ganttContracts.value.map(c => c.contract_effective_date!).filter(Boolean)
  if (!dates.length) return '2018-01-01'
  const min = dates.reduce((a, b) => a < b ? a : b)
  return min.substring(0, 7) + '-01'
})

const timelineEnd = computed(() => {
  const dates = ganttContracts.value.map(c => c.contract_expiration_date!).filter(Boolean)
  if (!dates.length) return '2032-12-31'
  const max = dates.reduce((a, b) => a > b ? a : b)
  const d = new Date(max)
  d.setMonth(d.getMonth() + 2, 0)
  return d.toISOString().split('T')[0]
})

const months = computed(() => {
  const result: { label: string; start: string; year: number; month: number }[] = []
  const start = new Date(timelineStart.value)
  const end = new Date(timelineEnd.value)
  const cur = new Date(start.getFullYear(), start.getMonth(), 1)
  while (cur <= end) {
    const y = cur.getFullYear()
    const m = cur.getMonth()
    const mStart = `${y}-${String(m + 1).padStart(2, '0')}-01`
    const label = cur.toLocaleDateString('en-CA', { month: 'short' })
    result.push({ label, start: mStart, year: y, month: m })
    cur.setMonth(cur.getMonth() + 1)
  }
  return result
})

const totalDays = computed(() => {
  const start = new Date(timelineStart.value)
  const end = new Date(timelineEnd.value)
  return Math.max(1, (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24))
})

function dayOffset(dateStr: string): number {
  return (new Date(dateStr).getTime() - new Date(timelineStart.value).getTime()) / (1000 * 60 * 60 * 24)
}

function barLeft(c: Contract): string {
  if (!c.contract_effective_date) return '0%'
  return `${(dayOffset(c.contract_effective_date) / totalDays.value) * 100}%`
}

function barWidth(c: Contract): string {
  if (!c.contract_effective_date || !c.contract_expiration_date) return '1%'
  const days = dayOffset(c.contract_expiration_date) - dayOffset(c.contract_effective_date)
  return `${Math.max(0.3, (days / totalDays.value) * 100)}%`
}

function barColor(c: Contract): string {
  const s = expiryStatus(c)
  switch (s) {
    case 'expired': return '#94a3b8'
    case 'critical': return '#dc2626'
    case 'warning': return '#f59e0b'
    case 'active': return '#10b981'
    default: return '#cbd5e1'
  }
}

const todayOffset = computed(() => {
  const offset = dayOffset(today)
  if (offset < 0 || offset > totalDays.value) return null
  return `${(offset / totalDays.value) * 100}%`
})

const years = computed(() => {
  const ySet = new Map<number, { start: number; span: number }>()
  for (let i = 0; i < months.value.length; i++) {
    const y = months.value[i].year
    if (!ySet.has(y)) ySet.set(y, { start: i, span: 1 })
    else ySet.get(y)!.span++
  }
  return [...ySet.entries()].map(([year, { start, span }]) => ({ year, start, span }))
})

const timelineWidth = computed(() => `${months.value.length * pxPerMonth.value}px`)

function scrollLeft() { scrollContainer.value?.scrollBy({ left: -300, behavior: 'smooth' }) }
function scrollRight() { scrollContainer.value?.scrollBy({ left: 300, behavior: 'smooth' }) }

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

function openDetail(c: Contract) {
  selectedContract.value = c
  detailDialog.value = true
}

function clearFilters() {
  searchQuery.value = ''
  selectedMinistries.value = []
  selectedVendors.value = []
  selectedCommodityTypes.value = []
}

function openCreate() {
  editingId.value = null
  editForm.value = { name: '', externalId: '', vendor: '', description: '', commodityType: 'Services', effectiveDate: '', expirationDate: '', hierarchyType: '' }
  editDialog.value = true
}

function openEdit(c: Contract) {
  editingId.value = c.pk_contract
  editForm.value = {
    name: c.contract_name,
    externalId: c.contract_external_id || '',
    vendor: c.contract_vendor || '',
    description: c.contract_description || '',
    commodityType: c.contract_commodity_type || '',
    effectiveDate: c.contract_effective_date || '',
    expirationDate: c.contract_expiration_date || '',
    hierarchyType: c.contract_hierarchy_type || '',
  }
  editDialog.value = true
}

async function saveContract() {
  saving.value = true
  try {
    if (editingId.value) await api.put(`/contracts/${editingId.value}`, editForm.value)
    else await api.post('/contracts', editForm.value)
    editDialog.value = false
    loadAllContracts()
  } catch { /* ignore */ }
  saving.value = false
}

async function deleteContract(id: string) {
  if (!confirm('Delete this contract?')) return
  try {
    await api.delete(`/contracts/${id}`)
    detailDialog.value = false
    loadAllContracts()
  } catch { /* ignore */ }
}
</script>

<template>
  <div class="min-h-screen pt-8 px-4 md:px-8">
    <div class="max-w-screen-2xl mx-auto">
      <!-- Header -->
      <div class="flex items-start justify-between mb-8">
        <div>
          <h1 class="text-3xl font-jakarta font-bold text-slate-900 mb-2">Contracts</h1>
          <p class="text-slate-500 font-geist">
            {{ stats.total }} contract{{ stats.total !== 1 ? 's' : '' }} tracked.
          </p>
        </div>
        <div class="flex items-center gap-2">
          <div class="flex bg-slate-100 rounded-lg p-0.5">
            <button @click="viewMode = 'gantt'" :class="['px-3 py-1.5 text-xs font-geist rounded-md transition-colors', viewMode === 'gantt' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500']">Gantt</button>
            <button @click="viewMode = 'table'" :class="['px-3 py-1.5 text-xs font-geist rounded-md transition-colors', viewMode === 'table' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500']">Table</button>
          </div>
          <Button icon="pi pi-plus" label="Add Contract" size="small" @click="openCreate" />
        </div>
      </div>

      <!-- Summary cards -->
      <div class="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
        <div class="bg-white rounded-xl border border-slate-200 p-4">
          <div class="flex items-center gap-2 mb-2"><FileText class="w-4 h-4 text-indigo-500" /><span class="text-xs font-geist text-slate-500">Total</span></div>
          <div class="text-2xl font-jakarta font-bold text-slate-900">{{ stats.total }}</div>
        </div>
        <div class="bg-white rounded-xl border border-slate-200 p-4">
          <div class="flex items-center gap-2 mb-2"><CheckCircle class="w-4 h-4 text-green-500" /><span class="text-xs font-geist text-slate-500">Active</span></div>
          <div class="text-2xl font-jakarta font-bold text-green-600">{{ stats.active }}</div>
        </div>
        <div class="bg-white rounded-xl border border-slate-200 p-4">
          <div class="flex items-center gap-2 mb-2"><Clock class="w-4 h-4 text-amber-500" /><span class="text-xs font-geist text-slate-500">Expiring &lt; 1yr</span></div>
          <div class="text-2xl font-jakarta font-bold text-amber-600">{{ stats.warning }}</div>
        </div>
        <div class="bg-white rounded-xl border border-slate-200 p-4">
          <div class="flex items-center gap-2 mb-2"><AlertTriangle class="w-4 h-4 text-red-500" /><span class="text-xs font-geist text-slate-500">Expiring &lt; 90d</span></div>
          <div class="text-2xl font-jakarta font-bold text-red-600">{{ stats.critical }}</div>
        </div>
        <div class="bg-white rounded-xl border border-slate-200 p-4">
          <div class="flex items-center gap-2 mb-2"><X class="w-4 h-4 text-slate-400" /><span class="text-xs font-geist text-slate-500">Expired</span></div>
          <div class="text-2xl font-jakarta font-bold text-slate-500">{{ stats.expired }}</div>
        </div>
      </div>

      <!-- Filters -->
      <div class="flex flex-wrap items-center gap-3 mb-6">
        <div class="relative flex-1 min-w-64">
          <Search class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <InputText v-model="searchQuery" placeholder="Search contract name, vendor, ID..." class="w-full pl-9 text-sm" />
        </div>
        <MultiSelect v-model="selectedMinistries" :options="uniqueMinistries.map(m => ({ label: m, value: m }))" option-label="label" option-value="value" placeholder="Ministry" :maxSelectedLabels="1" class="w-44 text-sm" />
        <MultiSelect v-model="selectedVendors" :options="uniqueVendors.map(v => ({ label: v, value: v }))" option-label="label" option-value="value" placeholder="Vendor" :maxSelectedLabels="1" class="w-44 text-sm" />
        <MultiSelect v-model="selectedCommodityTypes" :options="uniqueCommodityTypes.map(t => ({ label: t, value: t }))" option-label="label" option-value="value" placeholder="Type" :maxSelectedLabels="1" class="w-36 text-sm" />
        <button v-if="searchQuery || selectedMinistries.length || selectedVendors.length || selectedCommodityTypes.length" @click="clearFilters" class="flex items-center gap-1 text-xs font-geist text-slate-500 hover:text-red-500 transition-colors"><X class="w-3.5 h-3.5" /> Clear</button>
      </div>

      <!-- Loading -->
      <div v-if="loading" class="text-center py-20 text-slate-400 font-geist">Loading contracts...</div>

      <!-- ── Gantt View ─────────────────────────────── -->
      <template v-else-if="viewMode === 'gantt'">
        <div v-if="ganttContracts.length === 0" class="text-center py-20 text-slate-400 font-geist">No contracts with dates match the current filters.</div>
        <div v-else class="bg-white rounded-2xl border border-slate-200 overflow-hidden">
          <!-- Zoom controls -->
          <div class="flex items-center justify-between px-4 py-2 border-b border-slate-100 bg-slate-50">
            <span class="text-xs font-geist text-slate-500">{{ ganttContracts.length }} contracts &middot; {{ timelineStart.substring(0,4) }}–{{ timelineEnd.substring(0,4) }}</span>
            <div class="flex items-center gap-3">
              <div class="flex items-center gap-1 text-xs font-geist text-slate-500">
                <button @click="pxPerMonth = Math.max(MIN_PX, pxPerMonth - 10)" class="p-1 rounded hover:bg-slate-200"><ZoomOut class="w-4 h-4" /></button>
                <input type="range" :min="MIN_PX" :max="MAX_PX" :step="5" v-model.number="pxPerMonth" class="w-20 h-1 accent-indigo-600" />
                <button @click="pxPerMonth = Math.min(MAX_PX, pxPerMonth + 10)" class="p-1 rounded hover:bg-slate-200"><ZoomIn class="w-4 h-4" /></button>
              </div>
              <div class="flex gap-1 border-l border-slate-200 pl-3">
                <button @click="scrollLeft" class="p-1 rounded hover:bg-slate-200"><ChevronLeft class="w-4 h-4 text-slate-500" /></button>
                <button @click="scrollRight" class="p-1 rounded hover:bg-slate-200"><ChevronRight class="w-4 h-4 text-slate-500" /></button>
              </div>
            </div>
          </div>

          <div class="flex">
            <!-- Fixed left column: contract name + vendor -->
            <div class="w-72 min-w-72 flex-shrink-0 border-r border-slate-200 bg-white z-10">
              <div class="h-6 border-b border-slate-100 bg-slate-50"></div>
              <div class="h-8 border-b border-slate-200 bg-slate-50"></div>
              <div v-for="c in ganttContracts" :key="c.pk_contract" class="h-10 px-3 flex items-center border-b border-slate-50 cursor-pointer hover:bg-slate-50/50" @click="openDetail(c)">
                <div class="truncate">
                  <span class="text-[10px] font-geist text-slate-400 mr-1">{{ c.contract_external_id }}</span>
                  <span class="text-xs font-geist text-slate-700">{{ c.contract_vendor || c.contract_name }}</span>
                </div>
              </div>
            </div>

            <!-- Timeline area -->
            <div ref="scrollContainer" class="flex-1 overflow-x-auto">
              <div :style="{ minWidth: timelineWidth }" class="relative">
                <!-- Year headers -->
                <div class="flex h-6 border-b border-slate-100 bg-slate-50">
                  <div v-for="y in years" :key="y.year" class="text-[10px] font-geist font-semibold text-slate-600 flex items-center justify-center border-r border-slate-100" :style="{ width: `${(y.span / months.length) * 100}%` }">
                    {{ y.year }}
                  </div>
                </div>
                <!-- Month headers -->
                <div class="flex h-8 border-b border-slate-200 bg-slate-50">
                  <div v-for="m in months" :key="m.start" class="text-[10px] font-geist text-slate-500 flex items-center justify-center border-r border-slate-100 flex-shrink-0" :style="{ width: `${100 / months.length}%` }">
                    {{ pxPerMonth >= 40 ? m.label : m.label.charAt(0) }}
                  </div>
                </div>
                <!-- Today marker -->
                <div v-if="todayOffset" class="absolute top-0 bottom-0 w-px bg-indigo-400 z-20 pointer-events-none" :style="{ left: todayOffset }">
                  <div class="absolute -top-0 -left-2 text-[9px] font-geist text-indigo-500 bg-white px-1 border border-indigo-200 rounded">Today</div>
                </div>
                <!-- Bars -->
                <div v-for="c in ganttContracts" :key="c.pk_contract" class="h-10 relative border-b border-slate-50 cursor-pointer" @click="openDetail(c)">
                  <div
                    class="absolute top-2 h-6 rounded-md opacity-90 hover:opacity-100 transition-opacity flex items-center px-2 overflow-hidden"
                    :style="{ left: barLeft(c), width: barWidth(c), backgroundColor: barColor(c) }"
                    :title="`${c.contract_name}\n${c.contract_vendor || ''}\n${c.contract_effective_date} → ${c.contract_expiration_date}`"
                  >
                    <span class="text-[10px] font-geist text-white truncate">{{ c.contract_name }}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- Legend -->
          <div class="flex items-center gap-4 px-4 py-2 border-t border-slate-100 bg-slate-50 text-[11px] font-geist text-slate-500">
            <span class="flex items-center gap-1"><span class="w-3 h-3 rounded-sm" style="background:#10b981"></span>Active (1yr+)</span>
            <span class="flex items-center gap-1"><span class="w-3 h-3 rounded-sm" style="background:#f59e0b"></span>Expiring &lt; 1yr</span>
            <span class="flex items-center gap-1"><span class="w-3 h-3 rounded-sm" style="background:#dc2626"></span>Expiring &lt; 90d</span>
            <span class="flex items-center gap-1"><span class="w-3 h-3 rounded-sm" style="background:#94a3b8"></span>Expired</span>
          </div>
        </div>
      </template>

      <!-- ── Table View ─────────────────────────────── -->
      <template v-else-if="viewMode === 'table'">
        <div v-if="filtered.length === 0" class="text-center py-20 text-slate-400 font-geist">No contracts match the current filters.</div>
        <div v-else class="bg-white rounded-2xl border border-slate-200 overflow-hidden">
          <div class="overflow-x-auto">
            <table class="w-full text-left">
              <thead class="bg-slate-50 border-b border-slate-200">
                <tr class="text-xs font-geist text-slate-500 uppercase tracking-wide">
                  <th class="px-4 py-3 font-medium">ID</th>
                  <th class="px-4 py-3 font-medium">Contract</th>
                  <th class="px-4 py-3 font-medium">Vendor</th>
                  <th class="px-4 py-3 font-medium">Ministry</th>
                  <th class="px-4 py-3 font-medium">Type</th>
                  <th class="px-4 py-3 font-medium">Effective</th>
                  <th class="px-4 py-3 font-medium">Expiration</th>
                  <th class="px-4 py-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="c in paginatedContracts" :key="c.pk_contract" class="border-b border-slate-50 hover:bg-slate-50/50 cursor-pointer transition-colors" @click="openDetail(c)">
                  <td class="px-4 py-3 text-xs font-geist text-slate-500 font-mono">{{ c.contract_external_id || '—' }}</td>
                  <td class="px-4 py-3">
                    <div class="text-sm font-geist font-medium text-slate-900 max-w-80 truncate">{{ c.contract_name }}</div>
                  </td>
                  <td class="px-4 py-3 text-xs font-geist text-slate-600 max-w-40 truncate">{{ c.contract_vendor || '—' }}</td>
                  <td class="px-4 py-3 text-xs font-geist text-slate-600 max-w-36 truncate">{{ c.ministry_name || '—' }}</td>
                  <td class="px-4 py-3 text-xs font-geist text-slate-600">{{ c.contract_commodity_type || '—' }}</td>
                  <td class="px-4 py-3 text-xs font-geist text-slate-500">{{ c.contract_effective_date || '—' }}</td>
                  <td class="px-4 py-3 text-xs font-geist text-slate-500">{{ c.contract_expiration_date || '—' }}</td>
                  <td class="px-4 py-3">
                    <span :class="['text-[11px] font-geist px-2 py-0.5 rounded-full', expiryBadge(expiryStatus(c))]">
                      {{ expiryLabel(expiryStatus(c)) }}
                    </span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </template>

      <!-- Pagination -->
      <div v-if="pagination.totalPages > 1" class="flex items-center justify-between mt-4 px-1">
        <span class="text-xs font-geist text-slate-500">
          Showing {{ (pagination.page - 1) * pagination.limit + 1 }}–{{ Math.min(pagination.page * pagination.limit, pagination.total) }} of {{ pagination.total }}
        </span>
        <div class="flex items-center gap-1">
          <button @click="goToPage(1)" :disabled="pagination.page <= 1" class="px-2 py-1 text-xs font-geist rounded border border-slate-200 hover:bg-slate-50 disabled:opacity-30 disabled:cursor-not-allowed">&laquo;</button>
          <button @click="goToPage(pagination.page - 1)" :disabled="pagination.page <= 1" class="px-2 py-1 text-xs font-geist rounded border border-slate-200 hover:bg-slate-50 disabled:opacity-30 disabled:cursor-not-allowed">&lsaquo;</button>
          <template v-for="p in Math.min(pagination.totalPages, 7)" :key="p">
            <button
              v-if="pagination.totalPages <= 7 || Math.abs(p - pagination.page) <= 2 || p === 1 || p === pagination.totalPages"
              @click="goToPage(p)"
              :class="['px-2.5 py-1 text-xs font-geist rounded border transition-colors', p === pagination.page ? 'bg-indigo-600 text-white border-indigo-600' : 'border-slate-200 hover:bg-slate-50']"
            >{{ p }}</button>
          </template>
          <button @click="goToPage(pagination.page + 1)" :disabled="pagination.page >= pagination.totalPages" class="px-2 py-1 text-xs font-geist rounded border border-slate-200 hover:bg-slate-50 disabled:opacity-30 disabled:cursor-not-allowed">&rsaquo;</button>
          <button @click="goToPage(pagination.totalPages)" :disabled="pagination.page >= pagination.totalPages" class="px-2 py-1 text-xs font-geist rounded border border-slate-200 hover:bg-slate-50 disabled:opacity-30 disabled:cursor-not-allowed">&raquo;</button>
        </div>
      </div>

      <!-- ── Detail Dialog ─────────────────────────────── -->
      <Dialog v-model:visible="detailDialog" :header="selectedContract?.contract_name || 'Contract'" :modal="true" :style="{ width: '680px' }" :breakpoints="{ '768px': '95vw' }">
        <template v-if="selectedContract">
          <div class="grid md:grid-cols-2 gap-4 text-sm font-geist">
            <div><span class="text-slate-500">Contract ID:</span> <span class="text-slate-800 font-mono">{{ selectedContract.contract_external_id || '—' }}</span></div>
            <div><span class="text-slate-500">Ministry:</span> <span class="text-slate-800">{{ selectedContract.ministry_name || '—' }}</span></div>
            <div><span class="text-slate-500">Vendor:</span> <span class="text-slate-800 font-medium">{{ selectedContract.contract_vendor || '—' }}</span></div>
            <div><span class="text-slate-500">Commodity Type:</span> <span class="text-slate-800">{{ selectedContract.contract_commodity_type || '—' }}</span></div>
            <div><span class="text-slate-500">Effective Date:</span> <span class="text-slate-800">{{ selectedContract.contract_effective_date || '—' }}</span></div>
            <div><span class="text-slate-500">Expiration Date:</span> <span :class="['px-2 py-0.5 rounded-full text-[11px]', expiryBadge(expiryStatus(selectedContract))]">{{ selectedContract.contract_expiration_date || '—' }} ({{ expiryLabel(expiryStatus(selectedContract)) }})</span></div>
            <div><span class="text-slate-500">Hierarchy Type:</span> <span class="text-slate-800">{{ selectedContract.contract_hierarchy_type || '—' }}</span></div>
            <div v-if="daysUntilExpiry(selectedContract) !== null"><span class="text-slate-500">Days Until Expiry:</span> <span class="text-slate-800 font-medium">{{ daysUntilExpiry(selectedContract) }}</span></div>
          </div>
          <div v-if="selectedContract.contract_description" class="mt-4 text-sm font-geist text-slate-700 bg-slate-50 rounded-lg p-4">
            {{ selectedContract.contract_description }}
          </div>
        </template>
        <template #footer>
          <Button severity="danger" text size="small" @click="deleteContract(selectedContract!.pk_contract)">Delete</Button>
          <Button severity="secondary" outlined @click="detailDialog = false; openEdit(selectedContract!)">Edit</Button>
          <Button @click="detailDialog = false">Close</Button>
        </template>
      </Dialog>

      <!-- ── Create/Edit Dialog ──────────────────────────── -->
      <Dialog v-model:visible="editDialog" :header="editingId ? 'Edit Contract' : 'New Contract'" :modal="true" :style="{ width: '640px' }" :breakpoints="{ '768px': '95vw' }">
        <div class="grid gap-4">
          <div class="grid grid-cols-2 gap-4">
            <div><label class="text-xs font-geist text-slate-500 mb-1 block">Contract Name <span class="text-red-500">*</span></label><InputText v-model="editForm.name" class="w-full" :maxlength="500" /></div>
            <div><label class="text-xs font-geist text-slate-500 mb-1 block">Contract ID</label><InputText v-model="editForm.externalId" class="w-full" placeholder="e.g. C1193" :maxlength="100" /></div>
          </div>
          <div><label class="text-xs font-geist text-slate-500 mb-1 block">Description</label><Textarea v-model="editForm.description" rows="3" class="w-full" /></div>
          <div class="grid grid-cols-2 gap-4">
            <div><label class="text-xs font-geist text-slate-500 mb-1 block">Vendor</label><InputText v-model="editForm.vendor" class="w-full" :maxlength="500" /></div>
            <div><label class="text-xs font-geist text-slate-500 mb-1 block">Commodity Type</label><Select v-model="editForm.commodityType" :options="['Services', 'Goods', 'Contingent Labour', 'Mixed', 'Other'].map(v => ({ label: v, value: v }))" option-label="label" option-value="value" class="w-full" /></div>
          </div>
          <div class="grid grid-cols-2 gap-4">
            <div><label class="text-xs font-geist text-slate-500 mb-1 block">Effective Date</label><InputText v-model="editForm.effectiveDate" type="date" max="9999-12-31" class="w-full" /></div>
            <div><label class="text-xs font-geist text-slate-500 mb-1 block">Expiration Date</label><InputText v-model="editForm.expirationDate" type="date" max="9999-12-31" class="w-full" /></div>
          </div>
          <div><label class="text-xs font-geist text-slate-500 mb-1 block">Hierarchy Type</label><InputText v-model="editForm.hierarchyType" class="w-full" placeholder="e.g. Stand Alone Agreement, Master Agreement" /></div>
        </div>
        <template #footer>
          <Button severity="secondary" outlined @click="editDialog = false">Cancel</Button>
          <Button :loading="saving" @click="saveContract" :disabled="!editForm.name">{{ editingId ? 'Save' : 'Create' }}</Button>
        </template>
      </Dialog>
    </div>
  </div>
</template>
