<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import api from '@/lib/api'
import InputText from 'primevue/inputtext'
import MultiSelect from 'primevue/multiselect'
import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import Select from 'primevue/select'
import Textarea from 'primevue/textarea'
import { Search, X, Monitor, Shield, Database, Cloud, Server, Building2, Plus } from 'lucide-vue-next'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Application {
  pk_application: string
  application_name: string
  application_aliases: string | null
  application_description: string | null
  application_business_process: string | null
  application_type: string | null
  application_architecture_type: string | null
  application_install_type: string | null
  application_install_status: string | null
  application_lifecycle_stage_status: string | null
  application_lifecycle_stage: string | null
  application_technology_stack: string | null
  application_user_base: string | null
  application_platform: string | null
  application_last_change_date: string | null
  application_business_owner: string | null
  application_it_owner: string | null
  application_last_updated_by: string | null
  application_business_criticality: string | null
  application_emergency_tier: string | null
  application_data_classification: string | null
  application_is_certified: boolean
  application_department: string | null
  ministry_code: string | null
  ministry_name: string | null
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const loading = ref(true)
const searchQuery = ref('')
const selectedInstallTypes = ref<string[]>([])
const selectedDataClassifications = ref<string[]>([])
const selectedAppTypes = ref<string[]>([])
const selectedCriticalities = ref<string[]>([])
const selectedMinistries = ref<string[]>([])

const pagination = ref({ page: 1, limit: 50, total: 0, totalPages: 0 })

// Detail dialog
const detailDialog = ref(false)
const selectedApp = ref<Application | null>(null)

// Create/Edit dialog
const editDialog = ref(false)
const editingId = ref<string | null>(null)
const editForm = ref<Record<string, any>>({})
const saving = ref(false)

// All applications (loaded once, full dataset for client-side filtering)
const allApplications = ref<Application[]>([])

// Filter option lists (loaded once from a large fetch)
const filterOptions = ref<{ installTypes: string[]; dataClassifications: string[]; appTypes: string[]; criticalities: string[]; ministries: string[] }>({
  installTypes: [], dataClassifications: [], appTypes: [], criticalities: [], ministries: [],
})

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

async function loadAllApplications() {
  loading.value = true
  try {
    const firstRes = await api.get('/applications', { params: { limit: 500, page: 1 } })
    if (!firstRes.data?.success) { loading.value = false; return }
    const all: Application[] = firstRes.data.data || []
    const meta = firstRes.data.meta || firstRes.data.pagination
    if (meta && meta.total > 500) {
      const pages = Math.ceil(meta.total / 500)
      for (let p = 2; p <= pages; p++) {
        const more = await api.get('/applications', { params: { limit: 500, page: p } })
        if (more.data?.success) all.push(...(more.data.data || []))
      }
    }
    allApplications.value = all
    filterOptions.value = {
      installTypes: [...new Set(all.map(a => a.application_install_type).filter(Boolean) as string[])].sort(),
      dataClassifications: [...new Set(all.map(a => a.application_data_classification).filter(Boolean) as string[])].sort(),
      appTypes: [...new Set(all.map(a => a.application_type).filter(Boolean) as string[])].sort(),
      criticalities: [...new Set(all.map(a => a.application_business_criticality).filter(Boolean) as string[])].sort(),
      ministries: [...new Set(all.map(a => a.ministry_name).filter(Boolean) as string[])].sort(),
    }
  } catch { /* ignore */ }
  loading.value = false
}

onMounted(loadAllApplications)

// ---------------------------------------------------------------------------
// Client-side filtering on full dataset
// ---------------------------------------------------------------------------

const uniqueInstallTypes = computed(() => filterOptions.value.installTypes)
const uniqueDataClassifications = computed(() => filterOptions.value.dataClassifications)
const uniqueAppTypes = computed(() => filterOptions.value.appTypes)
const uniqueCriticalities = computed(() => filterOptions.value.criticalities)
const uniqueMinistries = computed(() => filterOptions.value.ministries)

const filtered = computed(() => {
  let result = allApplications.value

  if (searchQuery.value) {
    const q = searchQuery.value.toLowerCase()
    result = result.filter(a =>
      a.application_name.toLowerCase().includes(q) ||
      (a.application_aliases || '').toLowerCase().includes(q) ||
      (a.application_technology_stack || '').toLowerCase().includes(q) ||
      (a.application_description || '').toLowerCase().includes(q) ||
      (a.application_business_owner || '').toLowerCase().includes(q) ||
      (a.application_it_owner || '').toLowerCase().includes(q)
    )
  }
  if (selectedInstallTypes.value.length > 0) result = result.filter(a => a.application_install_type && selectedInstallTypes.value.includes(a.application_install_type))
  if (selectedDataClassifications.value.length > 0) result = result.filter(a => a.application_data_classification && selectedDataClassifications.value.includes(a.application_data_classification))
  if (selectedAppTypes.value.length > 0) result = result.filter(a => a.application_type && selectedAppTypes.value.includes(a.application_type))
  if (selectedCriticalities.value.length > 0) result = result.filter(a => a.application_business_criticality && selectedCriticalities.value.includes(a.application_business_criticality))
  if (selectedMinistries.value.length > 0) result = result.filter(a => a.ministry_name && selectedMinistries.value.includes(a.ministry_name))

  return result
})

// Paginate the filtered results
const paginatedApplications = computed(() => {
  const start = (pagination.value.page - 1) * pagination.value.limit
  return filtered.value.slice(start, start + pagination.value.limit)
})

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

const stats = computed(() => {
  const byInstall: Record<string, number> = {}
  const byClassification: Record<string, number> = {}
  for (const a of filtered.value) {
    const it = a.application_install_type || 'Unknown'
    byInstall[it] = (byInstall[it] || 0) + 1
    const dc = a.application_data_classification || 'Unknown'
    byClassification[dc] = (byClassification[dc] || 0) + 1
  }
  return { total: filtered.value.length, byInstall, byClassification }
})

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

function openDetail(app: Application) {
  selectedApp.value = app
  detailDialog.value = true
}

function clearFilters() {
  searchQuery.value = ''
  selectedInstallTypes.value = []
  selectedDataClassifications.value = []
  selectedAppTypes.value = []
  selectedCriticalities.value = []
  selectedMinistries.value = []
}

function openCreate() {
  editingId.value = null
  editForm.value = { name: '', description: '', installType: '', applicationType: '', dataClassification: '', technologyStack: '', platform: '', businessCriticality: '', businessOwner: '', itOwner: '' }
  editDialog.value = true
}

function openEdit(app: Application) {
  editingId.value = app.pk_application
  editForm.value = {
    name: app.application_name,
    aliases: app.application_aliases || '',
    description: app.application_description || '',
    installType: app.application_install_type || '',
    applicationType: app.application_type || '',
    architectureType: app.application_architecture_type || '',
    installStatus: app.application_install_status || '',
    lifecycleStageStatus: app.application_lifecycle_stage_status || '',
    lifecycleStage: app.application_lifecycle_stage || '',
    technologyStack: app.application_technology_stack || '',
    userBase: app.application_user_base || '',
    platform: app.application_platform || '',
    businessOwner: app.application_business_owner || '',
    itOwner: app.application_it_owner || '',
    businessCriticality: app.application_business_criticality || '',
    emergencyTier: app.application_emergency_tier || '',
    dataClassification: app.application_data_classification || '',
    isCertified: app.application_is_certified,
    department: app.application_department || '',
  }
  editDialog.value = true
}

async function saveApplication() {
  saving.value = true
  try {
    if (editingId.value) {
      await api.put(`/applications/${editingId.value}`, editForm.value)
    } else {
      await api.post('/applications', editForm.value)
    }
    editDialog.value = false
    loadAllApplications()
  } catch { /* toast error */ }
  saving.value = false
}

async function deleteApplication(id: string) {
  if (!confirm('Delete this application?')) return
  try {
    await api.delete(`/applications/${id}`)
    detailDialog.value = false
    loadAllApplications()
  } catch { /* ignore */ }
}

// Badge colors
function installBadgeColor(type: string | null): string {
  if (!type) return 'bg-slate-100 text-slate-600'
  const t = type.toLowerCase()
  if (t.includes('cloud')) return 'bg-sky-100 text-sky-700'
  if (t.includes('premise')) return 'bg-amber-100 text-amber-700'
  if (t.includes('hybrid')) return 'bg-purple-100 text-purple-700'
  return 'bg-slate-100 text-slate-600'
}

function classificationBadgeColor(cls: string | null): string {
  if (!cls) return 'bg-slate-100 text-slate-600'
  const c = cls.toLowerCase()
  if (c.includes('protected b')) return 'bg-red-100 text-red-700'
  if (c.includes('protected a')) return 'bg-orange-100 text-orange-700'
  if (c.includes('public')) return 'bg-green-100 text-green-700'
  return 'bg-slate-100 text-slate-600'
}

function criticalityBadgeColor(crit: string | null): string {
  if (!crit) return 'bg-slate-100 text-slate-500'
  const c = crit.toLowerCase()
  if (c.includes('mission') || c.includes('critical')) return 'bg-red-100 text-red-700'
  if (c.includes('high')) return 'bg-orange-100 text-orange-700'
  if (c.includes('medium')) return 'bg-yellow-100 text-yellow-700'
  if (c.includes('low')) return 'bg-green-100 text-green-700'
  return 'bg-slate-100 text-slate-500'
}
</script>

<template>
  <div class="min-h-screen pt-8 px-4 md:px-8">
    <div class="max-w-screen-2xl mx-auto">
      <!-- Header -->
      <div class="flex items-start justify-between mb-8">
        <div>
          <h1 class="text-3xl font-jakarta font-bold text-slate-900 mb-2">Applications (CMDB)</h1>
          <p class="text-slate-500 font-geist">
            {{ stats.total }} application{{ stats.total !== 1 ? 's' : '' }} in the registry.
          </p>
        </div>
        <Button icon="pi pi-plus" label="Add Application" size="small" @click="openCreate" />
      </div>

      <!-- Summary cards -->
      <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <div class="bg-white rounded-xl border border-slate-200 p-4">
          <div class="flex items-center gap-2 mb-2"><Monitor class="w-4 h-4 text-indigo-500" /><span class="text-xs font-geist text-slate-500">Total Apps</span></div>
          <div class="text-2xl font-jakarta font-bold text-slate-900">{{ stats.total }}</div>
        </div>
        <div class="bg-white rounded-xl border border-slate-200 p-4">
          <div class="flex items-center gap-2 mb-2"><Cloud class="w-4 h-4 text-sky-500" /><span class="text-xs font-geist text-slate-500">Cloud</span></div>
          <div class="text-2xl font-jakarta font-bold text-slate-900">{{ stats.byInstall['Cloud'] || 0 }}</div>
        </div>
        <div class="bg-white rounded-xl border border-slate-200 p-4">
          <div class="flex items-center gap-2 mb-2"><Server class="w-4 h-4 text-amber-500" /><span class="text-xs font-geist text-slate-500">On Premise</span></div>
          <div class="text-2xl font-jakarta font-bold text-slate-900">{{ stats.byInstall['On Premise'] || 0 }}</div>
        </div>
        <div class="bg-white rounded-xl border border-slate-200 p-4">
          <div class="flex items-center gap-2 mb-2"><Shield class="w-4 h-4 text-red-500" /><span class="text-xs font-geist text-slate-500">Protected B</span></div>
          <div class="text-2xl font-jakarta font-bold text-slate-900">{{ stats.byClassification['Protected B'] || 0 }}</div>
        </div>
      </div>

      <!-- Filters -->
      <div class="flex flex-wrap items-center gap-3 mb-6">
        <div class="relative flex-1 min-w-64">
          <Search class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <InputText v-model="searchQuery" placeholder="Search name, aliases, tech stack..." class="w-full pl-9 text-sm" />
        </div>
        <MultiSelect v-model="selectedMinistries" :options="uniqueMinistries.map(m => ({ label: m, value: m }))" option-label="label" option-value="value" placeholder="Ministry" :maxSelectedLabels="1" class="w-44 text-sm" />
        <MultiSelect v-model="selectedInstallTypes" :options="uniqueInstallTypes.map(t => ({ label: t, value: t }))" option-label="label" option-value="value" placeholder="Install Type" :maxSelectedLabels="1" class="w-40 text-sm" />
        <MultiSelect v-model="selectedDataClassifications" :options="uniqueDataClassifications.map(c => ({ label: c, value: c }))" option-label="label" option-value="value" placeholder="Classification" :maxSelectedLabels="1" class="w-44 text-sm" />
        <MultiSelect v-model="selectedAppTypes" :options="uniqueAppTypes.map(t => ({ label: t, value: t }))" option-label="label" option-value="value" placeholder="App Type" :maxSelectedLabels="1" class="w-44 text-sm" />
        <button v-if="searchQuery || selectedInstallTypes.length || selectedDataClassifications.length || selectedAppTypes.length || selectedCriticalities.length || selectedMinistries.length" @click="clearFilters" class="flex items-center gap-1 text-xs font-geist text-slate-500 hover:text-red-500 transition-colors">
          <X class="w-3.5 h-3.5" /> Clear
        </button>
      </div>

      <!-- Loading state -->
      <div v-if="loading" class="text-center py-20 text-slate-400 font-geist">Loading applications...</div>

      <!-- Table -->
      <div v-else-if="filtered.length > 0" class="bg-white rounded-2xl border border-slate-200 overflow-hidden">
        <div class="overflow-x-auto">
          <table class="w-full text-left">
            <thead class="bg-slate-50 border-b border-slate-200">
              <tr class="text-xs font-geist text-slate-500 uppercase tracking-wide">
                <th class="px-4 py-3 font-medium">Application</th>
                <th class="px-4 py-3 font-medium">Ministry</th>
                <th class="px-4 py-3 font-medium">Tech Stack</th>
                <th class="px-4 py-3 font-medium">Install</th>
                <th class="px-4 py-3 font-medium">Type</th>
                <th class="px-4 py-3 font-medium">Classification</th>
                <th class="px-4 py-3 font-medium">Criticality</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="app in paginatedApplications"
                :key="app.pk_application"
                class="border-b border-slate-50 hover:bg-slate-50/50 cursor-pointer transition-colors"
                @click="openDetail(app)"
              >
                <td class="px-4 py-3">
                  <div class="text-sm font-geist font-medium text-slate-900 max-w-72 truncate">{{ app.application_name }}</div>
                  <div v-if="app.application_aliases" class="text-[11px] text-slate-400 truncate max-w-72">{{ app.application_aliases }}</div>
                </td>
                <td class="px-4 py-3 text-xs font-geist text-slate-600 max-w-40 truncate">{{ app.ministry_name || '—' }}</td>
                <td class="px-4 py-3 text-xs font-geist text-slate-600 max-w-48 truncate">{{ app.application_technology_stack || '—' }}</td>
                <td class="px-4 py-3"><span :class="['text-[11px] font-geist px-2 py-0.5 rounded-full', installBadgeColor(app.application_install_type)]">{{ app.application_install_type || '—' }}</span></td>
                <td class="px-4 py-3 text-xs font-geist text-slate-600">{{ app.application_type || '—' }}</td>
                <td class="px-4 py-3"><span :class="['text-[11px] font-geist px-2 py-0.5 rounded-full', classificationBadgeColor(app.application_data_classification)]">{{ app.application_data_classification || '—' }}</span></td>
                <td class="px-4 py-3"><span :class="['text-[11px] font-geist px-2 py-0.5 rounded-full', criticalityBadgeColor(app.application_business_criticality)]">{{ app.application_business_criticality || '—' }}</span></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div v-else class="text-center py-20 text-slate-400 font-geist">
        No applications match the current filters.
      </div>

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
      <Dialog v-model:visible="detailDialog" :header="selectedApp?.application_name || 'Application'" :modal="true" :style="{ width: '720px' }" :breakpoints="{ '768px': '95vw' }">
        <template v-if="selectedApp">
          <div class="grid md:grid-cols-2 gap-4 text-sm font-geist">
            <div v-if="selectedApp.application_aliases"><span class="text-slate-500">Aliases:</span> <span class="text-slate-800">{{ selectedApp.application_aliases }}</span></div>
            <div><span class="text-slate-500">Ministry:</span> <span class="text-slate-800">{{ selectedApp.ministry_name || '—' }}</span></div>
            <div><span class="text-slate-500">Install Type:</span> <span :class="['px-2 py-0.5 rounded-full text-[11px]', installBadgeColor(selectedApp.application_install_type)]">{{ selectedApp.application_install_type || '—' }}</span></div>
            <div><span class="text-slate-500">App Type:</span> <span class="text-slate-800">{{ selectedApp.application_type || '—' }}</span></div>
            <div><span class="text-slate-500">Architecture:</span> <span class="text-slate-800">{{ selectedApp.application_architecture_type || '—' }}</span></div>
            <div><span class="text-slate-500">Install Status:</span> <span class="text-slate-800">{{ selectedApp.application_install_status || '—' }}</span></div>
            <div><span class="text-slate-500">Lifecycle Stage:</span> <span class="text-slate-800">{{ selectedApp.application_lifecycle_stage || '—' }} ({{ selectedApp.application_lifecycle_stage_status || '—' }})</span></div>
            <div><span class="text-slate-500">Platform:</span> <span class="text-slate-800">{{ selectedApp.application_platform || '—' }}</span></div>
            <div><span class="text-slate-500">Tech Stack:</span> <span class="text-slate-800">{{ selectedApp.application_technology_stack || '—' }}</span></div>
            <div><span class="text-slate-500">User Base:</span> <span class="text-slate-800">{{ selectedApp.application_user_base || '—' }}</span></div>
            <div><span class="text-slate-500">Data Classification:</span> <span :class="['px-2 py-0.5 rounded-full text-[11px]', classificationBadgeColor(selectedApp.application_data_classification)]">{{ selectedApp.application_data_classification || '—' }}</span></div>
            <div><span class="text-slate-500">Business Criticality:</span> <span :class="['px-2 py-0.5 rounded-full text-[11px]', criticalityBadgeColor(selectedApp.application_business_criticality)]">{{ selectedApp.application_business_criticality || '—' }}</span></div>
            <div><span class="text-slate-500">Emergency Tier:</span> <span class="text-slate-800">{{ selectedApp.application_emergency_tier || '—' }}</span></div>
            <div><span class="text-slate-500">Certified:</span> <span class="text-slate-800">{{ selectedApp.application_is_certified ? 'Yes' : 'No' }}</span></div>
            <div><span class="text-slate-500">Business Owner:</span> <span class="text-slate-800">{{ selectedApp.application_business_owner || '—' }}</span></div>
            <div><span class="text-slate-500">IT Owner:</span> <span class="text-slate-800">{{ selectedApp.application_it_owner || '—' }}</span></div>
          </div>
          <div v-if="selectedApp.application_description" class="mt-4 text-sm font-geist text-slate-700 bg-slate-50 rounded-lg p-4">
            {{ selectedApp.application_description }}
          </div>
        </template>
        <template #footer>
          <Button severity="danger" text size="small" @click="deleteApplication(selectedApp!.pk_application)">Delete</Button>
          <Button severity="secondary" outlined @click="detailDialog = false; openEdit(selectedApp!)">Edit</Button>
          <Button @click="detailDialog = false">Close</Button>
        </template>
      </Dialog>

      <!-- ── Create/Edit Dialog ──────────────────────────── -->
      <Dialog v-model:visible="editDialog" :header="editingId ? 'Edit Application' : 'New Application'" :modal="true" :style="{ width: '680px' }" :breakpoints="{ '768px': '95vw' }">
        <div class="grid gap-4">
          <div><label class="text-xs font-geist text-slate-500 mb-1 block">Name <span class="text-red-500">*</span></label><InputText v-model="editForm.name" class="w-full" :maxlength="500" /></div>
          <div><label class="text-xs font-geist text-slate-500 mb-1 block">Aliases</label><InputText v-model="editForm.aliases" class="w-full" placeholder="Space-separated aliases" /></div>
          <div><label class="text-xs font-geist text-slate-500 mb-1 block">Description</label><Textarea v-model="editForm.description" rows="3" class="w-full" /></div>
          <div class="grid grid-cols-2 gap-4">
            <div><label class="text-xs font-geist text-slate-500 mb-1 block">Application Type</label><Select v-model="editForm.applicationType" :options="['Custom Development', 'COTS', 'COTS with Custom Development', 'SaaS', 'PaaS', 'Other'].map(v => ({ label: v, value: v }))" option-label="label" option-value="value" class="w-full" /></div>
            <div><label class="text-xs font-geist text-slate-500 mb-1 block">Install Type</label><Select v-model="editForm.installType" :options="['Cloud', 'On Premise', 'Hybrid', 'SaaS'].map(v => ({ label: v, value: v }))" option-label="label" option-value="value" class="w-full" /></div>
          </div>
          <div class="grid grid-cols-2 gap-4">
            <div><label class="text-xs font-geist text-slate-500 mb-1 block">Data Classification</label><Select v-model="editForm.dataClassification" :options="['Public', 'Protected A', 'Protected B', 'Protected C'].map(v => ({ label: v, value: v }))" option-label="label" option-value="value" class="w-full" /></div>
            <div><label class="text-xs font-geist text-slate-500 mb-1 block">Business Criticality</label><Select v-model="editForm.businessCriticality" :options="['Mission Critical', 'High', 'Medium', 'Low'].map(v => ({ label: v, value: v }))" option-label="label" option-value="value" class="w-full" /></div>
          </div>
          <div class="grid grid-cols-2 gap-4">
            <div><label class="text-xs font-geist text-slate-500 mb-1 block">Technology Stack</label><InputText v-model="editForm.technologyStack" class="w-full" placeholder="e.g. MSSQL, C#, .NET" /></div>
            <div><label class="text-xs font-geist text-slate-500 mb-1 block">Platform</label><InputText v-model="editForm.platform" class="w-full" placeholder="e.g. Windows, SAP, Linux" /></div>
          </div>
          <div class="grid grid-cols-2 gap-4">
            <div><label class="text-xs font-geist text-slate-500 mb-1 block">Business Owner</label><InputText v-model="editForm.businessOwner" class="w-full" /></div>
            <div><label class="text-xs font-geist text-slate-500 mb-1 block">IT Application Owner</label><InputText v-model="editForm.itOwner" class="w-full" /></div>
          </div>
        </div>
        <template #footer>
          <Button severity="secondary" outlined @click="editDialog = false">Cancel</Button>
          <Button :loading="saving" @click="saveApplication" :disabled="!editForm.name">{{ editingId ? 'Save' : 'Create' }}</Button>
        </template>
      </Dialog>
    </div>
  </div>
</template>
