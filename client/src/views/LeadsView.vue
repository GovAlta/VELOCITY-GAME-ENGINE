<script setup lang="ts">
import { computed, ref, onMounted, watch } from 'vue'
import { useProjectStore, PHASE_LABELS } from '@/stores/projects'
import { useAuthStore } from '@/stores/auth'
import { useTheme } from '@/composables/useTheme'
import type { ProjectRecord } from '@/stores/projects'
import api from '@/lib/api'
import FilterBar from '@/components/projects/FilterBar.vue'
import InputText from 'primevue/inputtext'
import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import Select from 'primevue/select'
import Paginator from 'primevue/paginator'
import { User, ChevronDown, ChevronUp, Calendar, Search, Users, Briefcase, Merge, Trash2, Edit3 } from 'lucide-vue-next'

const store = useProjectStore()
const auth = useAuthStore()
const { chartColors } = useTheme()

const viewMode = ref<'leads' | 'directory'>('leads')

// ═══════════════════════════════════════════════════════════
// LEADS VIEW (from store, groups by project lead)
// ═══════════════════════════════════════════════════════════
const sortBy = ref<'count' | 'name' | 'avgCompletion'>('count')
const sortDir = ref<'desc' | 'asc'>('desc')

interface LeadGroup {
  name: string
  projects: ProjectRecord[]
  count: number
  ministries: string[]
  avgCompletion: number
  atRiskCount: number
  pastDueCount: number
}

const leadGroups = computed((): LeadGroup[] => {
  const map = new Map<string, ProjectRecord[]>()
  for (const p of store.filteredProjects) {
    const names = (p.projectLead || 'Unassigned').split(/[,;]/).map(s => s.trim()).filter(Boolean)
    if (names.length === 0) names.push('Unassigned')
    for (const name of names) {
      if (!map.has(name)) map.set(name, [])
      map.get(name)!.push(p)
    }
  }
  const today = new Date().toISOString().split('T')[0]
  const groups: LeadGroup[] = []
  for (const [name, projects] of map) {
    const ministrySet = new Set(projects.map(p => p.ministryCode))
    const withPct = projects.filter(p => p.percentComplete !== null)
    const avgCompletion = withPct.length > 0 ? withPct.reduce((sum, p) => sum + (p.percentComplete || 0), 0) / withPct.length : 0
    const pastDueCount = projects.filter(p => p.endDate && p.endDate < today && p.phase !== 'completion' && p.phase !== 'cancelled').length
    const atRiskCount = projects.filter(p => {
      if (!p.startDate || !p.endDate || p.percentComplete === null) return false
      const elapsed = new Date(today).getTime() - new Date(p.startDate).getTime()
      const total = new Date(p.endDate).getTime() - new Date(p.startDate).getTime()
      return total > 0 && p.percentComplete < (elapsed / total) * 100 - 15
    }).length
    groups.push({ name, projects, count: projects.length, ministries: [...ministrySet].sort(), avgCompletion: Math.round(avgCompletion), atRiskCount, pastDueCount })
  }
  groups.sort((a, b) => {
    let cmp = 0
    if (sortBy.value === 'count') cmp = a.count - b.count
    else if (sortBy.value === 'name') cmp = a.name.localeCompare(b.name)
    else cmp = a.avgCompletion - b.avgCompletion
    return sortDir.value === 'desc' ? -cmp : cmp
  })
  return groups
})

function toggleSort(field: typeof sortBy.value) {
  if (sortBy.value === field) sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc'
  else { sortBy.value = field; sortDir.value = 'desc' }
}

const expandedLeads = ref<Set<string>>(new Set())
function toggleExpand(name: string) {
  expandedLeads.value.has(name) ? expandedLeads.value.delete(name) : expandedLeads.value.add(name)
}

function phaseColor(phase: string): string {
  const palette = chartColors.value.series
  const keys = Object.keys(PHASE_LABELS)
  const idx = keys.indexOf(phase)
  return idx >= 0 ? palette[idx % palette.length] : chartColors.value.muted
}

// ═══════════════════════════════════════════════════════════
// PEOPLE DIRECTORY (from API, paginated)
// ═══════════════════════════════════════════════════════════
const persons = ref<any[]>([])
const personTotal = ref(0)
const personPage = ref(1)
const personLimit = 30
const personSearch = ref('')
const filterType = ref<'all' | 'fte' | 'contractor'>('all')
const loadingPersons = ref(false)

async function loadPersons() {
  loadingPersons.value = true
  try {
    const res = await api.get('/persons', {
      params: {
        page: personPage.value,
        limit: personLimit,
        search: personSearch.value || undefined,
        type: filterType.value !== 'all' ? filterType.value : undefined,
      },
    })
    if (res.data?.success) {
      const d = res.data.data
      persons.value = d.data || d
      personTotal.value = d.pagination?.total || persons.value.length
    }
  } catch { persons.value = [] }
  loadingPersons.value = false
}

onMounted(() => { if (viewMode.value === 'directory') loadPersons() })
watch(viewMode, v => { if (v === 'directory') loadPersons() })
watch([personPage, filterType], loadPersons)

let searchTimeout: ReturnType<typeof setTimeout> | null = null
function onSearchInput() {
  if (searchTimeout) clearTimeout(searchTimeout)
  searchTimeout = setTimeout(() => { personPage.value = 1; loadPersons() }, 300)
}

// ── Edit Person ──
const editDialog = ref(false)
const editForm = ref<Record<string, any>>({})
const editingId = ref<string | null>(null)

function openEditDialog(p: any) {
  editingId.value = p.pk_person
  editForm.value = { displayName: p.person_display_name, email: p.person_email || '', githubHandle: p.person_github_handle || '', organization: p.person_organization || '', isFte: p.person_is_fte, notes: p.person_notes || '' }
  editDialog.value = true
}

async function savePerson() {
  try {
    if (editingId.value) {
      await api.put(`/persons/${editingId.value}`, editForm.value)
    } else {
      await api.post('/persons', editForm.value)
    }
    editDialog.value = false
    await loadPersons()
    await store.loadFromApi()
  } catch (e: any) { alert(e?.response?.data?.error?.message || 'Failed to save') }
}

function openCreateDialog() {
  editingId.value = null
  editForm.value = { displayName: '', email: '', githubHandle: '', organization: '', isFte: true, notes: '' }
  editDialog.value = true
}

async function deletePerson(id: string, name: string) {
  if (!confirm(`Delete "${name}" and remove from all projects?`)) return
  try { await api.delete(`/persons/${id}`); await loadPersons(); await store.loadFromApi() }
  catch (e: any) { alert(e?.response?.data?.error?.message || 'Failed') }
}

// ── Merge ──
const mergeDialog = ref(false)
const mergeSurvivorId = ref<string | null>(null)
const mergeSurvivorName = ref('')
const mergeSearchQuery = ref('')
const mergeSearchResults = ref<any[]>([])
const mergeVictimId = ref<string | null>(null)
const mergeVictimName = ref('')

function openMergeDialog(p: any) {
  mergeSurvivorId.value = p.pk_person
  mergeSurvivorName.value = p.person_display_name
  mergeVictimId.value = null
  mergeVictimName.value = ''
  mergeSearchQuery.value = ''
  mergeSearchResults.value = []
  mergeDialog.value = true
}

let mergeSearchTimeout: ReturnType<typeof setTimeout> | null = null
function onMergeSearch() {
  if (mergeSearchTimeout) clearTimeout(mergeSearchTimeout)
  const q = mergeSearchQuery.value.trim()
  if (q.length < 1) { mergeSearchResults.value = []; return }
  mergeSearchTimeout = setTimeout(async () => {
    try {
      const res = await api.get('/persons/search', { params: { q } })
      mergeSearchResults.value = (res.data?.data || []).filter((p: any) => p.pk_person !== mergeSurvivorId.value)
    } catch { mergeSearchResults.value = [] }
  }, 250)
}

function selectMergeVictim(p: any) {
  mergeVictimId.value = p.pk_person
  mergeVictimName.value = p.person_display_name
  mergeSearchQuery.value = ''
  mergeSearchResults.value = []
}

// ── Person Detail ──
const detailDialog = ref(false)
const detailPerson = ref<any>(null)
const detailAssignments = ref<any[]>([])
const detailLoading = ref(false)

async function openPersonDetail(p: any) {
  detailPerson.value = p
  detailAssignments.value = []
  detailDialog.value = true
  detailLoading.value = true
  try {
    const res = await api.get(`/persons/${p.pk_person}`)
    if (res.data?.success) {
      detailPerson.value = res.data.data
      detailAssignments.value = res.data.data.assignments || []
    }
  } catch { /* keep what we had */ }
  detailLoading.value = false
}

async function executeMerge() {
  if (!mergeSurvivorId.value || !mergeVictimId.value) return
  if (!confirm(`Merge "${mergeVictimName.value}" into "${mergeSurvivorName.value}"? The duplicate will be deleted.`)) return
  try {
    await api.post(`/persons/${mergeSurvivorId.value}/merge`, { mergePersonId: mergeVictimId.value })
    mergeDialog.value = false
    await loadPersons()
    await store.loadFromApi()
  } catch (e: any) { alert(e?.response?.data?.error?.message || 'Merge failed') }
}
</script>

<template>
  <div class="min-h-screen pt-8 px-4 md:px-8">
    <div class="max-w-screen-2xl mx-auto">
      <div class="mb-8">
        <h1 class="text-3xl font-jakarta font-bold text-slate-900 mb-2 flex items-center gap-3">
          <Users class="w-8 h-8 text-indigo-600" />
          Team & Leads
        </h1>
        <p class="text-slate-500 font-geist">{{ leadGroups.length }} leads, {{ personTotal }} people in directory.</p>
      </div>

      <!-- View toggle -->
      <div class="flex items-center gap-3 mb-6">
        <div class="flex border border-slate-200 rounded-lg p-0.5">
          <button class="px-4 py-1.5 rounded-md text-sm font-geist transition-colors" :class="viewMode === 'leads' ? 'bg-indigo-50 text-indigo-600 font-medium' : 'text-slate-500'" @click="viewMode = 'leads'">
            <User class="w-4 h-4 inline mr-1" /> By Project Lead
          </button>
          <button class="px-4 py-1.5 rounded-md text-sm font-geist transition-colors" :class="viewMode === 'directory' ? 'bg-indigo-50 text-indigo-600 font-medium' : 'text-slate-500'" @click="viewMode = 'directory'">
            <Briefcase class="w-4 h-4 inline mr-1" /> People Directory
          </button>
        </div>
      </div>

      <!-- ═══ LEADS VIEW ═══ -->
      <template v-if="viewMode === 'leads'">
        <div class="mb-6"><FilterBar /></div>
        <div class="flex items-center gap-2 mb-4 text-xs font-geist text-slate-500">
          <span>Sort:</span>
          <button v-for="opt in [{key:'count',label:'Projects'},{key:'name',label:'Name'},{key:'avgCompletion',label:'Avg %'}] as const" :key="opt.key" class="px-2 py-1 rounded-md transition-colors" :class="sortBy === opt.key ? 'bg-indigo-50 text-indigo-600 font-medium' : 'hover:bg-slate-100'" @click="toggleSort(opt.key)">{{ opt.label }} <span v-if="sortBy === opt.key">{{ sortDir === 'asc' ? '↑' : '↓' }}</span></button>
        </div>
        <div class="space-y-3">
          <div v-for="lead in leadGroups" :key="lead.name" class="bg-white rounded-2xl border border-slate-200 overflow-hidden">
            <button class="w-full flex items-center gap-4 p-5 text-left hover:bg-slate-50 transition-colors" @click="toggleExpand(lead.name)">
              <div class="w-10 h-10 rounded-full bg-indigo-50 flex items-center justify-center flex-shrink-0"><User class="w-5 h-5 text-indigo-600" /></div>
              <div class="flex-1 min-w-0">
                <div class="text-sm font-jakarta font-bold text-slate-900">{{ lead.name }}</div>
                <div class="text-[10px] font-geist text-slate-400 truncate">{{ lead.ministries.join(', ') }}</div>
              </div>
              <div class="hidden sm:flex items-center gap-6 flex-shrink-0">
                <div class="text-center"><div class="text-lg font-jakarta font-bold text-slate-900">{{ lead.count }}</div><div class="text-[10px] font-geist text-slate-400">Projects</div></div>
                <div class="text-center"><div class="text-lg font-jakarta font-bold text-slate-900">{{ lead.avgCompletion }}%</div><div class="text-[10px] font-geist text-slate-400">Avg</div></div>
                <div v-if="lead.atRiskCount > 0" class="text-center"><div class="text-lg font-jakarta font-bold text-amber-600">{{ lead.atRiskCount }}</div><div class="text-[10px] font-geist text-slate-400">At Risk</div></div>
                <div v-if="lead.pastDueCount > 0" class="text-center"><div class="text-lg font-jakarta font-bold text-red-600">{{ lead.pastDueCount }}</div><div class="text-[10px] font-geist text-slate-400">Past Due</div></div>
              </div>
              <ChevronDown v-if="!expandedLeads.has(lead.name)" class="w-4 h-4 text-slate-400 flex-shrink-0" />
              <ChevronUp v-else class="w-4 h-4 text-slate-400 flex-shrink-0" />
            </button>
            <div v-if="expandedLeads.has(lead.name)" class="border-t border-slate-100 divide-y divide-slate-50">
              <router-link v-for="p in lead.projects" :key="p.id" :to="`/projects/${p.id}`" class="flex items-center gap-4 px-5 py-3 hover:bg-slate-50 transition-colors group">
                <div class="w-2.5 h-2.5 rounded-full flex-shrink-0" :style="{ backgroundColor: phaseColor(p.phase) }"></div>
                <div class="flex-1 min-w-0">
                  <div class="text-sm font-geist text-slate-900 truncate group-hover:text-indigo-600">{{ p.name }}</div>
                  <div class="text-[10px] font-geist text-slate-400">{{ p.ministryCode }} &middot; {{ PHASE_LABELS[p.phase] || p.phase }}</div>
                </div>
                <div v-if="p.percentComplete !== null" class="hidden sm:flex items-center gap-2 flex-shrink-0 w-32">
                  <div class="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden"><div class="h-full rounded-full" :style="{ width: `${p.percentComplete}%`, backgroundColor: phaseColor(p.phase) }"></div></div>
                  <span class="text-[10px] font-geist text-slate-500 w-8 text-right">{{ p.percentComplete }}%</span>
                </div>
                <div class="hidden md:flex items-center gap-1 text-[10px] font-geist text-slate-400 flex-shrink-0 w-24"><Calendar class="w-3 h-3" />{{ p.endDate || 'TBD' }}</div>
              </router-link>
            </div>
          </div>
        </div>
      </template>

      <!-- ═══ PEOPLE DIRECTORY ═══ -->
      <template v-if="viewMode === 'directory'">
        <div class="flex flex-wrap items-center gap-3 mb-6">
          <div class="relative flex-1 min-w-[200px] max-w-md">
            <Search class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
            <InputText v-model="personSearch" placeholder="Search people..." class="w-full !pl-9" @input="onSearchInput" />
          </div>
          <div class="flex border border-slate-200 rounded-lg p-0.5">
            <button v-for="opt in [{key:'all',label:'All'},{key:'fte',label:'FTE'},{key:'contractor',label:'Contractors'}] as const" :key="opt.key" class="px-3 py-1.5 rounded-md text-xs font-geist transition-colors" :class="filterType === opt.key ? 'bg-indigo-50 text-indigo-600 font-medium' : 'text-slate-500'" @click="filterType = opt.key; personPage = 1">{{ opt.label }}</button>
          </div>
          <Button v-if="auth.isAuthenticated" label="Add Person" icon="pi pi-plus" size="small" severity="secondary" outlined @click="openCreateDialog()" />
          <span class="text-xs font-geist text-slate-400 ml-auto">{{ personTotal }} people</span>
        </div>

        <div class="bg-white rounded-2xl border border-slate-200 overflow-hidden mb-4">
          <div class="overflow-x-auto">
            <table class="w-full text-left">
              <thead>
                <tr class="bg-slate-50 border-b border-slate-200">
                  <th class="px-4 py-3 text-[10px] font-geist font-semibold text-slate-600 uppercase tracking-wider">Name</th>
                  <th class="px-3 py-3 text-[10px] font-geist font-semibold text-slate-600 uppercase tracking-wider w-20">Type</th>
                  <th class="px-3 py-3 text-[10px] font-geist font-semibold text-slate-600 uppercase tracking-wider w-44 hidden lg:table-cell">Email</th>
                  <th class="px-3 py-3 text-[10px] font-geist font-semibold text-slate-600 uppercase tracking-wider w-28 hidden lg:table-cell">GitHub</th>
                  <th class="px-3 py-3 text-[10px] font-geist font-semibold text-slate-600 uppercase tracking-wider w-32 hidden md:table-cell">Organization</th>
                  <th class="px-3 py-3 text-[10px] font-geist font-semibold text-slate-600 uppercase tracking-wider w-16 text-center">Projects</th>
                  <th v-if="auth.isAuthenticated" class="px-3 py-3 text-[10px] font-geist font-semibold text-slate-600 uppercase tracking-wider w-28 text-center">Actions</th>
                </tr>
              </thead>
              <tbody>
                <tr v-if="loadingPersons" class="border-b border-slate-50"><td colspan="7" class="px-4 py-8 text-center text-sm text-slate-400 font-geist">Loading...</td></tr>
                <tr v-else-if="persons.length === 0" class="border-b border-slate-50"><td colspan="7" class="px-4 py-8 text-center text-sm text-slate-400 font-geist">No people found.</td></tr>
                <tr v-for="p in persons" :key="p.pk_person" class="border-b border-slate-50 hover:bg-slate-50">
                  <td class="px-4 py-2.5">
                    <button class="flex items-center gap-2 text-left group" @click="openPersonDetail(p)">
                      <User class="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
                      <span class="text-sm font-geist text-slate-900 group-hover:text-indigo-600 transition-colors">{{ p.person_display_name }}</span>
                    </button>
                  </td>
                  <td class="px-3 py-2.5">
                    <span class="text-[10px] font-geist font-semibold px-1.5 py-0.5 rounded" :class="p.person_is_fte ? 'bg-indigo-50 text-indigo-600' : 'bg-amber-50 text-amber-600'">{{ p.person_is_fte ? 'FTE' : 'Contractor' }}</span>
                  </td>
                  <td class="px-3 py-2.5 text-xs font-geist text-slate-500 hidden lg:table-cell truncate max-w-44">{{ p.person_email || '—' }}</td>
                  <td class="px-3 py-2.5 text-xs font-geist text-slate-500 hidden lg:table-cell">{{ p.person_github_handle || '—' }}</td>
                  <td class="px-3 py-2.5 text-xs font-geist text-slate-500 hidden md:table-cell">{{ p.person_organization || '—' }}</td>
                  <td class="px-3 py-2.5 text-center text-xs font-geist font-semibold text-slate-700">{{ p.assignment_count || 0 }}</td>
                  <td v-if="auth.isAuthenticated" class="px-3 py-2.5 text-center">
                    <div class="flex items-center justify-center gap-1">
                      <Button icon="pi pi-pencil" size="small" severity="secondary" text rounded @click="openEditDialog(p)" aria-label="Edit" />
                      <Button icon="pi pi-arrows-h" size="small" severity="info" text rounded @click="openMergeDialog(p)" aria-label="Merge" v-tooltip="'Merge duplicate'" />
                      <Button icon="pi pi-trash" size="small" severity="danger" text rounded @click="deletePerson(p.pk_person, p.person_display_name)" aria-label="Delete" />
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <Paginator :rows="personLimit" :totalRecords="personTotal" :first="(personPage - 1) * personLimit" @update:first="personPage = Math.floor($event / personLimit) + 1" />
      </template>

      <!-- Edit/Create Person Dialog -->
      <Dialog v-model:visible="editDialog" :header="editingId ? 'Edit Person' : 'Add Person'" :modal="true" :style="{ width: '580px' }" :breakpoints="{ '768px': '95vw' }">
        <div class="grid gap-4">
          <div><label class="text-xs font-geist text-slate-500 mb-1 block">Display Name <span class="text-red-500">*</span></label><InputText v-model="editForm.displayName" class="w-full" /></div>
          <div class="grid grid-cols-2 gap-4">
            <div><label class="text-xs font-geist text-slate-500 mb-1 block">Email</label><InputText v-model="editForm.email" class="w-full" type="email" placeholder="name@example.com" /></div>
            <div><label class="text-xs font-geist text-slate-500 mb-1 block">GitHub Handle</label><InputText v-model="editForm.githubHandle" class="w-full" placeholder="@username" /></div>
          </div>
          <div class="grid grid-cols-2 gap-4">
            <div><label class="text-xs font-geist text-slate-500 mb-1 block">Organization</label><InputText v-model="editForm.organization" class="w-full" placeholder="e.g. CGI, Vantix" /></div>
            <div class="flex items-end pb-1"><label class="flex items-center gap-2 text-sm font-geist text-slate-600 cursor-pointer"><input type="checkbox" v-model="editForm.isFte" class="rounded" /> FTE (uncheck = Contractor)</label></div>
          </div>
          <div><label class="text-xs font-geist text-slate-500 mb-1 block">Notes</label><InputText v-model="editForm.notes" class="w-full" /></div>
        </div>
        <template #footer>
          <Button label="Cancel" severity="secondary" outlined @click="editDialog = false" />
          <Button :label="editingId ? 'Save' : 'Create'" @click="savePerson" :disabled="!editForm.displayName" />
        </template>
      </Dialog>

      <!-- Merge Dialog -->
      <Dialog v-model:visible="mergeDialog" header="Merge People" :modal="true" :style="{ width: '560px' }" :breakpoints="{ '768px': '95vw' }">
        <div class="grid gap-4">
          <div class="p-3 bg-indigo-50 rounded-xl">
            <div class="text-xs font-geist text-indigo-600 font-semibold mb-1">Keep (Survivor)</div>
            <div class="text-sm font-geist text-slate-900 font-medium">{{ mergeSurvivorName }}</div>
          </div>
          <div>
            <label class="text-xs font-geist text-slate-500 mb-1 block">Search for the duplicate to merge in</label>
            <div class="relative">
              <InputText v-model="mergeSearchQuery" class="w-full" placeholder="Type name of duplicate..." @input="onMergeSearch" />
              <div v-if="mergeSearchResults.length > 0" class="absolute z-10 mt-1 w-full bg-white border border-slate-200 rounded-xl shadow-lg max-h-48 overflow-y-auto">
                <button v-for="p in mergeSearchResults" :key="p.pk_person" class="w-full text-left px-3 py-2 text-sm font-geist hover:bg-slate-50 border-b border-slate-50 last:border-0" @click="selectMergeVictim(p)">
                  {{ p.person_display_name }} <span class="text-[10px] text-slate-400">{{ p.person_is_fte ? 'FTE' : 'Contractor' }}</span>
                </button>
              </div>
            </div>
          </div>
          <div v-if="mergeVictimId" class="p-3 bg-red-50 rounded-xl">
            <div class="text-xs font-geist text-red-600 font-semibold mb-1">Merge & Delete</div>
            <div class="text-sm font-geist text-slate-900 font-medium">{{ mergeVictimName }}</div>
            <div class="text-[10px] font-geist text-slate-500 mt-1">All project assignments will transfer to "{{ mergeSurvivorName }}".</div>
          </div>
        </div>
        <template #footer>
          <Button label="Cancel" severity="secondary" outlined @click="mergeDialog = false" />
          <Button label="Merge" severity="danger" @click="executeMerge" :disabled="!mergeVictimId" icon="pi pi-arrows-h" />
        </template>
      </Dialog>

      <!-- Person Detail Dialog -->
      <Dialog v-model:visible="detailDialog" :header="detailPerson?.person_display_name || 'Person'" :modal="true" :style="{ width: '640px' }" :breakpoints="{ '768px': '95vw' }">
        <div v-if="detailPerson" class="space-y-4">
          <!-- Person info -->
          <div class="grid grid-cols-2 gap-3 text-sm font-geist">
            <div><span class="text-slate-400">Type:</span> <span class="ml-1 font-medium" :class="detailPerson.person_is_fte ? 'text-indigo-600' : 'text-amber-600'">{{ detailPerson.person_is_fte ? 'FTE' : 'Contractor' }}</span></div>
            <div v-if="detailPerson.person_organization"><span class="text-slate-400">Org:</span> <span class="ml-1 text-slate-700">{{ detailPerson.person_organization }}</span></div>
            <div v-if="detailPerson.person_email"><span class="text-slate-400">Email:</span> <a :href="`mailto:${detailPerson.person_email}`" class="ml-1 text-indigo-600 hover:text-indigo-700">{{ detailPerson.person_email }}</a></div>
            <div v-if="detailPerson.person_github_handle"><span class="text-slate-400">GitHub:</span> <a :href="`https://github.com/${detailPerson.person_github_handle.replace('@','')}`" target="_blank" rel="noopener" class="ml-1 text-indigo-600 hover:text-indigo-700">{{ detailPerson.person_github_handle }}</a></div>
            <div v-if="detailPerson.person_notes" class="col-span-2"><span class="text-slate-400">Notes:</span> <span class="ml-1 text-slate-700">{{ detailPerson.person_notes }}</span></div>
          </div>

          <!-- Project assignments -->
          <div>
            <h3 class="text-sm font-jakarta font-bold text-slate-900 mb-2">Project Assignments ({{ detailAssignments.length }})</h3>
            <div v-if="detailLoading" class="text-sm text-slate-400 font-geist py-4 text-center">Loading...</div>
            <div v-else-if="detailAssignments.length === 0" class="text-sm text-slate-400 font-geist py-4 text-center border border-dashed border-slate-200 rounded-xl">Not assigned to any projects.</div>
            <div v-else class="space-y-1 max-h-80 overflow-y-auto">
              <router-link
                v-for="a in detailAssignments"
                :key="a.pk_project_lead"
                :to="`/projects/${a.fk_project_lead_project}`"
                class="flex items-center gap-3 p-2.5 rounded-lg hover:bg-slate-50 transition-colors group"
                @click="detailDialog = false"
              >
                <div class="flex-1 min-w-0">
                  <div class="text-sm font-geist text-slate-900 truncate group-hover:text-indigo-600">{{ a.project_name }}</div>
                  <div class="text-[10px] font-geist text-slate-400">
                    <span v-if="a.ministry_code" class="mr-1">{{ a.ministry_code }}</span>
                    <span class="px-1 py-0.5 rounded bg-slate-100 text-slate-500">{{ a.lead_role?.replace(/_/g, ' ') || 'team member' }}</span>
                    <span v-if="a.lead_is_primary" class="ml-1 px-1 py-0.5 rounded bg-indigo-50 text-indigo-600">Primary</span>
                  </div>
                </div>
              </router-link>
            </div>
          </div>
        </div>
        <template #footer>
          <Button label="Edit Person" icon="pi pi-pencil" severity="secondary" outlined @click="detailDialog = false; openEditDialog(detailPerson)" v-if="auth.isAuthenticated" />
          <Button label="Close" severity="secondary" @click="detailDialog = false" />
        </template>
      </Dialog>
    </div>
  </div>
</template>
