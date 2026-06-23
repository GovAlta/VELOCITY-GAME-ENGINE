<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useProjectStore, PHASE_LABELS, PHASE_COLORS, RISK_COLORS, RISK_LABELS } from '@/stores/projects'
import type { RiskLevel } from '@/stores/projects'
import { useAuthStore } from '@/stores/auth'
import { useTheme } from '@/composables/useTheme'
import api from '@/lib/api'
import InputText from 'primevue/inputtext'
import Textarea from 'primevue/textarea'
import Select from 'primevue/select'
import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import InputNumber from 'primevue/inputnumber'
import Menu from 'primevue/menu'
import {
  ArrowLeft, Calendar, Building2, User, FileText, GitBranch,
  ExternalLink, AlertTriangle, DollarSign, Target, Users,
  FolderOpen, BookOpen, Database, Link2, ShieldAlert, TrendingDown,
  CheckCircle, Gauge, Edit3, Plus, Trash2, Save, X, RefreshCw, Shield,
} from 'lucide-vue-next'
import ModuleDetailDialog from '@/components/modules/ModuleDetailDialog.vue'
import SharePointPanel from '@/components/sharepoint/SharePointPanel.vue'
import ProjectMembersPanel from '@/components/collaboration/ProjectMembersPanel.vue'
import CloneProjectDialog from '@/components/collaboration/CloneProjectDialog.vue'
import VersionsBadge from '@/components/collaboration/VersionsBadge.vue'
import VersionsPanel from '@/components/collaboration/VersionsPanel.vue'
import { useCollaborationStore } from '@/stores/collaboration'
import { GitFork, Network, Pencil, Lock } from 'lucide-vue-next'

const route = useRoute()
const router = useRouter()
const store = useProjectStore()
const auth = useAuthStore()
const { chartColors } = useTheme()

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------
const project = ref<Record<string, any> | null>(null)
const loading = ref(true)
const saving = ref(false)
const editing = ref(false)
const editForm = ref<Record<string, any>>({})

// Sub-resources loaded from API
const leads = ref<any[]>([])
const budgets = ref<any[]>([])
const links = ref<any[]>([])
const modules = ref<any[]>([])
const velocityData = ref<any>(null)
const updates = ref<any[]>([])
const linkedApplications = ref<any[]>([])
const linkedContracts = ref<any[]>([])

// Application/Contract link dialogs
const appLinkDialog = ref(false)
const contractLinkDialog = ref(false)
const appLinkForm = ref({ applicationId: '', moduleId: null as string | null, relationshipType: 'other', description: '' })
const contractLinkForm = ref({ contractId: '', moduleId: null as string | null, relationshipType: 'other', description: '' })
const applicationSearchQuery = ref('')
const applicationSearchResults = ref<any[]>([])
const contractSearchQuery = ref('')
const contractSearchResults = ref<any[]>([])

const projectId = computed(() => route.params.id as string)

// ─── Collaboration state ────────────────────────────────────
const collaboration = useCollaborationStore()
const showCloneDialog = ref(false)
const editingVersionLabel = ref(false)
const versionLabelDraft = ref('')

const collabPerms = computed(() => collaboration.permissions[projectId.value])
const lockedByName = computed(() => {
  const lockedBy = (project.value as any)?.project_locked_by
  if (!lockedBy) return null
  // Best-effort: pick from members list
  const m = (collaboration.members[projectId.value] || []).find(x => x.fk_pm_user === lockedBy)
  return m?.user_display_name || null
})

async function refreshCollaboration() {
  if (!projectId.value) return
  await Promise.all([
    collaboration.fetchPermissions(projectId.value),
    collaboration.fetchMembers(projectId.value),
    collaboration.fetchCluster(projectId.value),
  ])
}

async function saveVersionLabel() {
  try {
    await collaboration.renameVersion(projectId.value, versionLabelDraft.value || null)
    editingVersionLabel.value = false
    await loadProject(true)
  } catch (e: any) {
    alert(e?.response?.data?.error?.message || 'Failed to rename')
  }
}

// ─── Inline lock controls ──────────────────────────────────────────────
const showLockDialog = ref(false)
const lockReasonDraft = ref('')

async function acquireLock() {
  try {
    await collaboration.lockProject(projectId.value, lockReasonDraft.value.trim() || undefined)
    showLockDialog.value = false
    lockReasonDraft.value = ''
    await loadProject(true)
  } catch (e: any) {
    alert(e?.response?.data?.error?.message || 'Failed to acquire lock')
  }
}

async function releaseLock(force = false) {
  if (force && !confirm('Force-unlock will override the original locker and write a project_update audit entry. Continue?')) return
  try {
    await collaboration.unlockProject(projectId.value, force)
    await loadProject(true)
  } catch (e: any) {
    alert(e?.response?.data?.error?.message || 'Failed to release lock')
  }
}

// ─── Inline clone-policy toggle ────────────────────────────────────────
const showClonePolicyDialog = ref(false)
const clonePolicyReasonDraft = ref('')
const clonePolicySaving = ref(false)

function openClonePolicyDialog() {
  clonePolicyReasonDraft.value = ''
  showClonePolicyDialog.value = true
}

async function confirmClonePolicy() {
  const currentlyDisabled = !!(p.value as any)?.project_clone_disabled
  clonePolicySaving.value = true
  try {
    await collaboration.setClonePolicy(
      projectId.value,
      !currentlyDisabled,
      currentlyDisabled ? null : (clonePolicyReasonDraft.value.trim() || null),
    )
    showClonePolicyDialog.value = false
    clonePolicyReasonDraft.value = ''
    await loadProject(true)
  } catch (e: any) {
    alert(e?.response?.data?.error?.message || 'Failed to update clone policy')
  } finally {
    clonePolicySaving.value = false
  }
}

// ─── Header action menu (hamburger fallback on small screens) ──────────
const actionsMenu = ref()
function toggleActionsMenu(e: Event) { actionsMenu.value?.toggle(e) }

const actionsMenuItems = computed(() => {
  const items: any[] = []
  const proj = p.value as any
  const perms = collabPerms.value
  const isLocked = !!proj?.project_is_locked
  const lockedByMe = proj?.project_locked_by === auth.user?.id

  // Lock actions
  if (perms?.canToggleLock && !isLocked) {
    items.push({ label: 'Lock for focused work', icon: 'pi pi-lock', command: () => { showLockDialog.value = true } })
  }
  if (isLocked && lockedByMe) {
    items.push({ label: 'Release lock', icon: 'pi pi-lock-open', command: () => releaseLock(false) })
  }
  if (isLocked && !lockedByMe && perms?.isAdmin) {
    items.push({ label: 'Force-unlock (admin)', icon: 'pi pi-shield', command: () => releaseLock(true) })
  }

  // Clone-policy (admin only)
  if (perms?.canTogglePolicy) {
    items.push({
      label: proj?.project_clone_disabled ? 'Re-enable cloning' : 'Disable cloning',
      icon: proj?.project_clone_disabled ? 'pi pi-check-circle' : 'pi pi-ban',
      command: () => openClonePolicyDialog(),
    })
  }

  // Standard actions
  if (perms?.canClone && !proj?.fk_project_parent) {
    items.push({ label: 'Clone', icon: 'pi pi-copy', command: () => { showCloneDialog.value = true } })
  }
  if (collaboration.clusters[projectId.value]?.versions && collaboration.clusters[projectId.value]!.versions.length > 1) {
    items.push({ label: 'Cluster view', icon: 'pi pi-share-alt', command: () => router.push(`/projects/${projectId.value}/cluster`) })
  }
  if (canEdit.value) {
    items.push({ separator: true })
    items.push({ label: 'Edit project', icon: 'pi pi-pencil', command: () => startEdit() })
    items.push({ label: 'Delete project', icon: 'pi pi-trash', class: 'text-red-600', command: () => deleteProject() })
  }
  return items
})

// ---------------------------------------------------------------------------
// Load from API
// ---------------------------------------------------------------------------
async function loadProject(silent = false) {
  // Only show loading spinner on initial load, not refreshes
  if (!project.value && !silent) loading.value = true

  try {
    const res = await api.get(`/projects/${projectId.value}`)
    if (res.data?.success) {
      project.value = res.data.data
      leads.value = res.data.data.leads || []
      budgets.value = res.data.data.budgets || []
      links.value = res.data.data.links || []
      modules.value = res.data.data.modules || []
      linkedApplications.value = res.data.data.applications || []
      linkedContracts.value = res.data.data.contracts || []
      // Load velocity data for this project's modules
      try {
        const velRes = await api.get(`/velocity/projects/${projectId.value}`)
        velocityData.value = velRes.data?.data || null
      } catch { /* velocity data optional */ }
    }
  } catch {
    // Fallback to store only on initial load
    if (!project.value) {
      const p = store.getProjectById(projectId.value)
      if (p) {
        project.value = {
          pk_project: p.id,
          project_name: p.name,
          project_description: p.description,
          project_status: p.phase,
          project_start_date: p.startDate,
          project_end_date: p.endDate,
          project_go_live_date_type: p.goLiveDateType,
          project_percent_complete: p.percentComplete,
          project_priority: p.priority,
          project_scope: p.scope,
          project_category: p.category,
          project_demand_number: p.demandNumber,
          project_ministry_priority: p.ministryPriority,
          project_risk: p.risk,
          project_additional_info: p.additionalInfo,
          project_branch: p.branch,
          ministry_code: p.ministryCode,
          ministry_name: p.ministryName,
          project_source: p.source,
        }
      }
    }
  }

  // Load updates silently
  try {
    const res = await api.get(`/projects/${projectId.value}/updates`)
    if (res.data?.success) updates.value = res.data.data || []
  } catch { /* ignore */ }

  // Load linked applications & contracts
  loadLinkedItems()

  // Load audits
  loadAudits()

  loading.value = false
}

async function loadLinkedItems() {
  if (!project.value) return
  try {
    const [appRes, contractRes] = await Promise.all([
      api.get(`/projects/${projectId.value}/applications`),
      api.get(`/projects/${projectId.value}/contracts`),
    ])
    linkedApplications.value = appRes.data?.data || []
    linkedContracts.value = contractRes.data?.data || []
  } catch { /* ignore */ }
}

let appSearchTimer: ReturnType<typeof setTimeout>
async function onAppSearch() {
  clearTimeout(appSearchTimer)
  appSearchTimer = setTimeout(async () => {
    if (applicationSearchQuery.value.length < 2) { applicationSearchResults.value = []; return }
    try {
      const res = await api.get('/applications', { params: { search: applicationSearchQuery.value, limit: 10 } })
      applicationSearchResults.value = res.data?.data || []
    } catch { applicationSearchResults.value = [] }
  }, 300)
}

let contractSearchTimer: ReturnType<typeof setTimeout>
async function onContractSearch() {
  clearTimeout(contractSearchTimer)
  contractSearchTimer = setTimeout(async () => {
    if (contractSearchQuery.value.length < 2) { contractSearchResults.value = []; return }
    try {
      const res = await api.get('/contracts', { params: { search: contractSearchQuery.value, limit: 10 } })
      contractSearchResults.value = res.data?.data || []
    } catch { contractSearchResults.value = [] }
  }, 300)
}

async function saveAppLink() {
  try {
    await api.post(`/projects/${projectId.value}/applications`, appLinkForm.value)
    appLinkDialog.value = false
    loadLinkedItems()
  } catch { /* ignore */ }
}

async function removeAppLink(linkId: string) {
  try {
    await api.delete(`/projects/${projectId.value}/applications/${linkId}`)
    loadLinkedItems()
  } catch { /* ignore */ }
}

async function saveContractLink() {
  try {
    await api.post(`/projects/${projectId.value}/contracts`, contractLinkForm.value)
    contractLinkDialog.value = false
    loadLinkedItems()
  } catch { /* ignore */ }
}

async function removeContractLink(linkId: string) {
  try {
    await api.delete(`/projects/${projectId.value}/contracts/${linkId}`)
    loadLinkedItems()
  } catch { /* ignore */ }
}

/** Refresh data in background without flicker */
function refresh() { loadProject(true) }

// ─── SSE: keep this view in sync with collaboration events ─────────────
//
// Subscribes to /velocity/stream and reacts to events that touch THIS project.
// Without this, toggling clone-policy, lock state, members, etc. only updated
// the actor's UI — other tabs (or even the actor's own tab if they bypass the
// store) had to refresh manually.
let collabEventSource: EventSource | null = null

function isEventForThisProject(data: any): boolean {
  if (!data || !projectId.value) return false
  return data.projectId === projectId.value || data.parentId === projectId.value
}

function connectCollabSSE() {
  if (collabEventSource) collabEventSource.close()
  const baseUrl = import.meta.env.VITE_API_BASE_URL || '/api'
  collabEventSource = new EventSource(`${baseUrl}/velocity/stream`)

  // Project-level mutation events → refresh both the project record and the
  // computed permissions/cluster/members caches.
  const projectEvents = [
    'project_updated', 'project_deleted',
    'lock_acquired', 'lock_released',
    'clone_policy_changed',
    'version_renamed',
    'member_added', 'member_removed', 'member_role_changed',
    'ownership_transferred',
    'sharepoint_folders_created',
  ]
  for (const ev of projectEvents) {
    collabEventSource.addEventListener(ev, (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data)
        if (!isEventForThisProject(data)) return
        loadProject(true)
        refreshCollaboration()
      } catch { /* ignore parse errors */ }
    })
  }

  // version_created: a clone was made. Refresh cluster (so the badge updates)
  // and only refresh the project itself if THIS project is the clone target.
  collabEventSource.addEventListener('version_created', (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data)
      // Refresh cluster either way (parent's badge needs to update; clone's
      // panel may now reveal a sibling).
      if (data.parentId === projectId.value || data.projectId === projectId.value) {
        refreshCollaboration()
      }
    } catch { /* ignore */ }
  })

  // module_created / module_updated / module_deleted: refresh project to pick
  // up the new module list (and the velocity heatmap on detail view).
  for (const ev of ['module_created', 'module_updated', 'module_deleted']) {
    collabEventSource.addEventListener(ev, (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data)
        if (data.projectId === projectId.value) loadProject(true)
      } catch { /* ignore */ }
    })
  }
}

function disconnectCollabSSE() {
  collabEventSource?.close()
  collabEventSource = null
}

onMounted(() => {
  loadProject()
  refreshCollaboration()
  connectCollabSSE()
})
onUnmounted(() => {
  deepAuditEventSource.value?.close()
  stopAuditPolling()
  disconnectCollabSSE()
})
watch(() => route.params.id, () => {
  loadProject()
  refreshCollaboration()
  connectCollabSSE()
})

// ---------------------------------------------------------------------------
// Risk Assessment (computed from project data)
// ---------------------------------------------------------------------------
const riskAssessment = computed(() => {
  const p = project.value
  if (!p) return { level: 'no-data' as RiskLevel, label: 'Unknown', color: '#94a3b8', bgColor: '#f1f5f9', reason: '', expectedPct: null as number | null, actualPct: null as number | null, daysRemaining: null as number | null, velocityNeeded: null as number | null }

  const pct = p.project_percent_complete
  const start = p.project_start_date
  const end = p.project_end_date
  const status = p.project_status
  const today = new Date().toISOString().split('T')[0]

  if (status === 'completion' || pct === 100) {
    return { level: 'completed' as RiskLevel, label: 'Completed', color: RISK_COLORS['completed'], bgColor: '#ecfdf5', reason: 'Project completed.', expectedPct: 100, actualPct: pct ?? 100, daysRemaining: 0, velocityNeeded: null }
  }
  if (!start || !end) {
    return { level: 'no-data' as RiskLevel, label: 'No Timeline', color: '#94a3b8', bgColor: '#f1f5f9', reason: 'Missing start or end date.', expectedPct: null, actualPct: pct, daysRemaining: null, velocityNeeded: null }
  }

  const startMs = new Date(start).getTime(), endMs = new Date(end).getTime(), todayMs = new Date(today).getTime()
  const totalDuration = endMs - startMs, elapsed = todayMs - startMs, remaining = endMs - todayMs
  const daysRemaining = Math.ceil(remaining / 86400000)
  const timeRatio = totalDuration > 0 ? Math.max(0, Math.min(elapsed / totalDuration, 1)) : 1
  const expectedPct = Math.round(timeRatio * 100)
  const actualPct = pct ?? 0

  if (pct === null) {
    return daysRemaining < 0
      ? { level: 'past-due' as RiskLevel, label: 'Past Due', color: RISK_COLORS['past-due'], bgColor: '#fef2f2', reason: `Due ${Math.abs(daysRemaining)} days ago, no completion data.`, expectedPct, actualPct: null, daysRemaining, velocityNeeded: null }
      : { level: 'no-data' as RiskLevel, label: 'No Data', color: '#94a3b8', bgColor: '#f1f5f9', reason: 'No percent complete reported.', expectedPct, actualPct: null, daysRemaining, velocityNeeded: null }
  }
  if (daysRemaining < 0) {
    return { level: 'past-due' as RiskLevel, label: 'Past Due', color: RISK_COLORS['past-due'], bgColor: '#fef2f2', reason: `Due ${Math.abs(daysRemaining)} days ago at ${actualPct}%.`, expectedPct: 100, actualPct, daysRemaining, velocityNeeded: null }
  }

  const gap = expectedPct - actualPct
  const daysElapsed = Math.max(1, Math.ceil(elapsed / 86400000))
  const velocity = actualPct / daysElapsed
  const needed = daysRemaining > 0 ? (100 - actualPct) / daysRemaining : Infinity
  const vr = velocity > 0 ? Math.round((needed / velocity) * 100) / 100 : null

  if (gap <= 5) return { level: 'on-track' as RiskLevel, label: 'On Track', color: RISK_COLORS['on-track'], bgColor: '#ecfdf5', reason: `${actualPct}% vs ${expectedPct}% expected.`, expectedPct, actualPct, daysRemaining, velocityNeeded: vr }
  if (gap <= 20) return { level: 'at-risk' as RiskLevel, label: 'At Risk', color: RISK_COLORS['at-risk'], bgColor: '#fffbeb', reason: `${actualPct}% vs ${expectedPct}% expected. Needs ${vr}x velocity.`, expectedPct, actualPct, daysRemaining, velocityNeeded: vr }
  if (gap <= 40) return { level: 'behind' as RiskLevel, label: 'Behind', color: RISK_COLORS['behind'], bgColor: '#fff7ed', reason: `${actualPct}% vs ${expectedPct}% expected. Needs ${vr}x velocity.`, expectedPct, actualPct, daysRemaining, velocityNeeded: vr }
  return { level: 'critical' as RiskLevel, label: 'Critical', color: RISK_COLORS['critical'], bgColor: '#fef2f2', reason: `${actualPct}% vs ${expectedPct}% expected. Severe delivery risk.`, expectedPct, actualPct, daysRemaining, velocityNeeded: vr }
})

const RISK_BG_CLASSES: Record<string, string> = {
  'completed': 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-800',
  'on-track': 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-800',
  'at-risk': 'bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-800',
  'behind': 'bg-orange-50 dark:bg-orange-950/30 border-orange-200 dark:border-orange-800',
  'critical': 'bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-800',
  'past-due': 'bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-800',
  'no-data': 'bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700',
}

// ---------------------------------------------------------------------------
// Delete project (soft delete)
// ---------------------------------------------------------------------------
async function deleteProject() {
  if (!confirm('Delete this project? It will be soft-deleted and can be recovered by an admin.')) return
  try {
    await api.delete(`/projects/${projectId.value}`)
    await store.loadFromApi()
    router.push('/projects')
  } catch (e: any) {
    alert(e?.response?.data?.error?.message || 'Failed to delete')
  }
}

// ---------------------------------------------------------------------------
// Project Audits
// ---------------------------------------------------------------------------
const audits = ref<any[]>([])
const auditRunning = ref(false)
const auditDetailDialog = ref(false)
const selectedAudit = ref<any>(null)
const auditDetailLoading = ref(false)
const projectAuditRunning = ref(false)
const auditsExpanded = ref(true)
const auditListPage = ref(1)
const auditListPerPage = 10
const aiAnalysisRunning = ref(false)
const aiProvider = ref('claude')
const savingToSharePoint = ref(false)

async function saveAuditToSharePoint(auditId: string) {
  savingToSharePoint.value = true
  try {
    const res = await api.post(`/sharepoint/projects/${projectId.value}/audit/${auditId}/export`)
    const data = res.data?.data
    if (data?.webUrl) {
      alert(`Audit saved to SharePoint!\n\n${data.webUrl}`)
    }
  } catch (e: any) {
    alert(e?.response?.data?.error?.message || 'Failed to save to SharePoint')
  } finally {
    savingToSharePoint.value = false
  }
}
const aiModel = ref('claude-sonnet-4-20250514')
const deepAuditRunning = ref(false)
const deepAuditProgress = ref<any>(null)
const deepAuditEventSource = ref<EventSource | null>(null)

async function loadAudits() {
  try {
    const res = await api.get(`/projects/${projectId.value}/audits`)
    audits.value = res.data?.data || []
    // Auto-start polling if any audits are still running
    if (audits.value.some((a: any) => a.audit_status === 'running' || a.audit_status === 'pending')) {
      startAuditPolling()
    }
  } catch { /* ignore */ }
}

async function runAllExternalAudits() {
  if (!project.value) return
  const auditableLinks = links.value?.filter((l: any) => ['github', 'jira', 'confluence', 'sharepoint'].includes(l.link_type)) || []
  if (auditableLinks.length === 0) {
    alert('No auditable links found. Add GitHub, Jira, Confluence, or SharePoint links first.')
    return
  }
  auditRunning.value = true
  try {
    for (const link of auditableLinks) {
      const source = link.link_type === 'github' ? 'git' : link.link_type
      await api.post(`/projects/${projectId.value}/audits`, { source, sourceUrl: link.link_url })
    }
    await loadAudits()
    startAuditPolling()
  } catch (e: any) {
    await loadAudits()
  } finally {
    auditRunning.value = false
  }
}

async function runProjectAudit() {
  if (!project.value) return
  projectAuditRunning.value = true
  try {
    // Gather all project data for a comprehensive audit
    const p = project.value
    const projectData: Record<string, any> = {
      project: {
        name: p.project_name,
        code: p.project_code,
        status: p.project_status,
        description: p.project_description,
        startDate: p.project_start_date,
        endDate: p.project_end_date,
        percentComplete: p.project_percent_complete,
        priority: p.project_priority,
        scope: p.project_scope,
        category: p.project_category,
        risk: p.project_risk,
        branch: p.project_branch,
        isMissionCritical: p.project_is_mission_critical,
        demandNumber: p.project_demand_number,
      },
      team: leads.value.map((l: any) => ({
        name: l.lead_name, role: l.lead_role, isPrimary: l.lead_is_primary, isFte: l.lead_is_fte, organization: l.lead_organization
      })),
      budgets: budgets.value.map((b: any) => ({
        fiscalYear: b.budget_fiscal_year, source: b.budget_funding_source, type: b.budget_money_type,
        amount: b.budget_amount, spent: b.budget_spent, notes: b.budget_notes
      })),
      modules: modules.value.map((m: any) => ({
        name: m.module_name, status: m.module_status, percentComplete: m.module_percent_complete,
        startDate: m.module_start_date, endDate: m.module_end_date,
        plan: m.module_plan, progress: m.module_progress, blockers: m.module_blockers
      })),
      links: links.value.map((l: any) => ({ type: l.link_type, url: l.link_url, label: l.link_label })),
      linkedApplications: linkedApplications.value.map((a: any) => ({
        name: a.application_name, relationship: a.pa_relationship_type, description: a.pa_description
      })),
      linkedContracts: linkedContracts.value.map((c: any) => ({
        name: c.contract_name, vendor: c.contract_vendor, relationship: c.pc_relationship_type, description: c.pc_description
      })),
      updates: updates.value.slice(0, 20).map((u: any) => ({
        type: u.update_type, title: u.update_title, content: u.update_content?.substring(0, 500), date: u.created_at
      })),
      // Include summaries from existing audits (if any)
      priorAudits: audits.value.filter((a: any) => a.audit_status === 'completed').map((a: any) => ({
        source: a.audit_source, title: a.audit_title, summary: a.audit_summary, aiScore: a.audit_ai_score, date: a.created_at
      })),
    }

    // Create a manual audit with all the project data
    const res = await api.post(`/projects/${projectId.value}/audits`, {
      source: 'manual',
      sourceUrl: window.location.href,
    })
    const auditId = res.data?.data?.pk_project_audit
    if (!auditId) throw new Error('Failed to create audit record')

    // Update the audit with full project data
    // We use a direct approach — update the audit_data via the detail endpoint later
    // For now, just run the LLM analysis with the project data as context
    await api.post(`/projects/${projectId.value}/audits/${auditId}/analyze`, {
      provider: 'claude',
      model: 'claude-sonnet-4-20250514',
      prompt: `You are auditing a technology project. Analyze ALL of the following project data comprehensively.

## What to evaluate:
1. **Delivery Risk**: Is the project on track? Compare % complete vs timeline. Flag if behind.
2. **Team**: Is the team adequately resourced? Right mix of FTE vs contractors? Any single points of failure?
3. **Budget**: Is spending aligned with progress? Any budget risks?
4. **Scope & Dependencies**: Are linked applications and contracts appropriate? Missing dependencies?
5. **Code Quality** (if git audits exist): What do prior git audits tell us about the code?
6. **Modules**: Are module statuses realistic? Any blocked or at-risk modules?
7. **Stakeholder Updates**: Do recent updates paint a consistent picture with the data?
8. **Mission Criticality**: If mission critical, are there adequate safeguards?

Be specific. Reference actual data. Flag quantitative mismatches (e.g., "project says 80% done but only 2 of 8 modules are past development").

## Project Data:
${JSON.stringify(projectData, null, 2).substring(0, 60000)}`,
    }, { timeout: 300000 })

    await loadAudits()
  } catch (e: any) {
    await loadAudits()
    alert(e?.response?.data?.error?.message || 'Project audit failed')
  } finally {
    projectAuditRunning.value = false
  }
}

async function deleteAudit(auditId: string) {
  if (!confirm('Delete this audit? This cannot be undone.')) return
  try {
    await api.delete(`/projects/${projectId.value}/audits/${auditId}`)
    await loadAudits()
  } catch (e: any) {
    alert(e?.response?.data?.error?.message || 'Cannot delete — you can only delete audits you created')
  }
}

async function runSingleAudit(sourceUrl: string, source: string = 'git') {
  try {
    await api.post(`/projects/${projectId.value}/audits`, { source, sourceUrl })
    await loadAudits()
    startAuditPolling()
  } catch (e: any) {
    alert(e?.response?.data?.error?.message || 'Failed to queue audit')
  }
}

let auditPollTimer: ReturnType<typeof setInterval> | null = null

function startAuditPolling() {
  stopAuditPolling()
  auditPollTimer = setInterval(async () => {
    await loadAudits()
    // Stop polling when no audits are running
    const hasRunning = audits.value.some((a: any) => a.audit_status === 'running' || a.audit_status === 'pending')
    if (!hasRunning) stopAuditPolling()
  }, 5000) // Poll every 5 seconds
}

function stopAuditPolling() {
  if (auditPollTimer) { clearInterval(auditPollTimer); auditPollTimer = null }
}

async function runDeepAudit(sourceUrl?: string) {
  if (!project.value) return
  const url = sourceUrl || links.value?.find((l: any) => l.link_type === 'github')?.link_url
  if (!url) {
    alert('No GitHub repository linked. Add a GitHub link first.')
    return
  }
  deepAuditRunning.value = true
  deepAuditProgress.value = { phase: 'starting', detail: `Queuing deep audit for ${url.split('/').slice(-2).join('/')}...` }
  try {
    const res = await api.post(`/projects/${projectId.value}/deep-audit`, {
      sourceUrl: url,
      provider: 'claude',
      maxFiles: 200,
      maxContentKB: 500,
    })
    const auditId = res.data?.data?.pk_project_audit
    if (auditId) {
      connectDeepAuditSSE(auditId)
    }
    await loadAudits()
  } catch (e: any) {
    deepAuditProgress.value = { phase: 'error', detail: e?.response?.data?.error?.message || 'Failed to start deep audit' }
    deepAuditRunning.value = false
  }
}

function connectDeepAuditSSE(auditId: string) {
  const baseUrl = import.meta.env.VITE_API_BASE_URL || '/api'
  const es = new EventSource(`${baseUrl}/projects/${projectId.value}/deep-audit/${auditId}/stream`)
  deepAuditEventSource.value = es

  es.addEventListener('phase', (e: MessageEvent) => {
    const data = JSON.parse(e.data)
    deepAuditProgress.value = data
    if (data.status === 'completed' || data.status === 'failed') {
      loadAudits() // Refresh the audit list
    }
  })

  es.addEventListener('progress', (e: MessageEvent) => {
    deepAuditProgress.value = JSON.parse(e.data)
  })

  es.addEventListener('complete', (e: MessageEvent) => {
    deepAuditRunning.value = false
    deepAuditProgress.value = null
    es.close()
    deepAuditEventSource.value = null
    loadAudits()
  })

  es.addEventListener('error', (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data)
      deepAuditProgress.value = { phase: 'error', detail: data.message }
    } catch { /* SSE error without parseable data */ }
    deepAuditRunning.value = false
    es.close()
    deepAuditEventSource.value = null
    loadAudits()
  })

  es.onerror = () => {
    // SSE connection error — the audit may still be running
    deepAuditRunning.value = false
    deepAuditProgress.value = null
    es.close()
    deepAuditEventSource.value = null
  }
}

function deepAuditPhaseStatus(phase: string): 'completed' | 'active' | 'pending' {
  if (!deepAuditProgress.value) return 'pending'
  const phases = ['discovery', 'selection', 'loading', 'analysis', 'consolidation']
  const currentIdx = phases.indexOf(deepAuditProgress.value.phase)
  const phaseIdx = phases.indexOf(phase)
  if (phaseIdx < currentIdx) return 'completed'
  if (phaseIdx === currentIdx) return deepAuditProgress.value.status === 'completed' ? 'completed' : 'active'
  return 'pending'
}

function velocityBarPx(count: number, velocityMap: Record<string, number>): string {
  const vals = Object.values(velocityMap) as number[]
  const max = Math.max(...vals, 1)
  return `${Math.max(3, Math.round((count / max) * 100))}px`
}

function velocityEntries(audit: any): Array<{ month: string; count: number }> {
  const map = audit?.audit_data?.projectHealth?.velocityByMonth
  if (!map || typeof map !== 'object') return []
  return Object.entries(map).map(([month, count]) => ({ month, count: count as number }))
}

async function runAiAnalysis() {
  if (!selectedAudit.value) return
  aiAnalysisRunning.value = true
  try {
    const res = await api.post(
      `/projects/${projectId.value}/audits/${selectedAudit.value.pk_project_audit}/analyze`,
      { provider: aiProvider.value, model: aiModel.value },
      { timeout: 300000 }
    )
    // Update the selected audit with AI results
    if (res.data?.data) {
      selectedAudit.value = res.data.data
    }
    // Also refresh the audit list so the sidebar shows the AI score
    loadAudits()
  } catch (e: any) {
    alert(e?.response?.data?.error?.message || 'AI analysis failed')
  } finally {
    aiAnalysisRunning.value = false
  }
}

async function openAuditDetail(audit: any) {
  selectedAudit.value = audit
  auditDetailDialog.value = true
  // Load full audit data if we only have summary
  if (!audit.audit_data || typeof audit.audit_data === 'string') {
    auditDetailLoading.value = true
    try {
      const res = await api.get(`/projects/${projectId.value}/audits/${audit.pk_project_audit}`)
      selectedAudit.value = res.data?.data || audit
    } catch { /* keep what we have */ }
    auditDetailLoading.value = false
  }
}

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------
function startEdit() {
  if (!project.value) return
  editForm.value = {
    projectCode: project.value.project_code || '',
    name: project.value.project_name,
    description: project.value.project_description || '',
    ministryCode: project.value.ministry_code || '',
    status: project.value.project_status || 'discovery',
    startDate: project.value.project_start_date ? String(project.value.project_start_date).split('T')[0] : '',
    endDate: project.value.project_end_date ? String(project.value.project_end_date).split('T')[0] : '',
    goLiveDateType: project.value.project_go_live_date_type || '',
    percentComplete: project.value.project_percent_complete ?? 0,
    priority: project.value.project_priority || '',
    scope: project.value.project_scope || '',
    category: project.value.project_category || '',
    demandNumber: project.value.project_demand_number || '',
    ministryPriority: project.value.project_ministry_priority,
    risk: project.value.project_risk || '',
    additionalInfo: project.value.project_additional_info || '',
    branch: project.value.project_branch || '',
    isMissionCritical: project.value.project_is_mission_critical ?? false,
    isChallenge: project.value.project_is_challenge ?? false,
    challengeDifficulty: project.value.challenge_difficulty || 'medium',
    challengeMaxDays: project.value.challenge_max_days || 5,
    challengeMaxAcceptances: (project.value as any).challenge_max_acceptances ?? null,
  }
  editing.value = true
}

const CHALLENGE_POINTS: Record<string, number> = { easy: 100, medium: 250, hard: 500, expert: 1000 }

async function saveProject() {
  saving.value = true
  try {
    // Auto-set challenge points from difficulty
    const payload = { ...editForm.value }
    if (payload.isChallenge && payload.challengeDifficulty) {
      payload.challengePoints = CHALLENGE_POINTS[payload.challengeDifficulty] || 250
    }
    await api.put(`/projects/${projectId.value}`, payload)
    editing.value = false
    refresh()
  } catch (e: any) {
    alert(e?.response?.data?.error?.message || 'Failed to save')
  } finally {
    saving.value = false
  }
}

// ---------------------------------------------------------------------------
// Status options
// ---------------------------------------------------------------------------
const ministryOptions = computed(() =>
  store.ministries
    .map(m => ({ label: `${m.shortName} - ${m.name}`, value: m.shortName }))
    .sort((a, b) => a.label.localeCompare(b.label))
)

const statusOptions = [
  { label: 'Discovery', value: 'discovery' },
  { label: 'Requirements', value: 'requirements' },
  { label: 'Development', value: 'development' },
  { label: 'Testing', value: 'testing' },
  { label: 'Client Review', value: 'client_review' },
  { label: 'Client Acceptance', value: 'client_acceptance' },
  { label: 'Completed', value: 'completion' },
  { label: 'On Hold', value: 'on_hold' },
  { label: 'Cancelled', value: 'cancelled' },
]

const goLiveDateTypeOptions = [
  { label: 'None', value: '' },
  { label: 'Legislative', value: 'legislative' },
  { label: 'Mandated', value: 'mandated' },
  { label: 'Announced', value: 'announced' },
  { label: 'Objective', value: 'objective' },
]

// ---------------------------------------------------------------------------
// Modules CRUD
// ---------------------------------------------------------------------------
const moduleDialog = ref(false)
const moduleForm = ref<Record<string, any>>({})
const moduleEditing = ref<string | null>(null)

// Module detail (read-only) dialog
const moduleDetailVisible = ref(false)
const moduleDetailMod = ref<any>(null)

function openModuleDetailDialog(mod: any) {
  moduleDetailMod.value = mod
  moduleDetailVisible.value = true
}

function getModuleVelocityMetrics(moduleId: string) {
  if (!velocityData.value?.metrics) return null
  return velocityData.value.metrics.find((m: any) => m.fk_mvm_module === moduleId) || null
}

function getModuleVelocitySteps(moduleId: string) {
  const vel = getModuleVelocity(moduleId)
  return vel?.steps || null
}

const moduleStatusOptions = [
  { label: 'Requirements Gathering', value: 'requirements_gathering' },
  { label: 'Building', value: 'building' },
  { label: 'Client Review', value: 'client_review' },
  { label: 'Client Sign Off', value: 'client_sign_off' },
  { label: 'Delivered', value: 'delivered' },
  { label: 'Closed', value: 'closed' },
  { label: 'Cancelled', value: 'cancelled' },
]

function getModuleVelocity(moduleId: string) {
  if (!velocityData.value?.modules) return null
  return velocityData.value.modules.find((m: any) => m.moduleId === moduleId)
}

function velocityStepColor(status: string): string {
  const map: Record<string, string> = {
    not_started: 'bg-slate-200 dark:bg-slate-600', ready_to_start: 'bg-sky-200 dark:bg-sky-800', ai_working: 'bg-violet-300 dark:bg-violet-700',
    human_working: 'bg-blue-300 dark:bg-blue-700', ai_review: 'bg-violet-200 dark:bg-violet-800', human_review: 'bg-blue-200 dark:bg-blue-800',
    completed: 'bg-emerald-300 dark:bg-emerald-700', blocked: 'bg-red-300 dark:bg-red-700', hand_raised: 'bg-yellow-300 dark:bg-yellow-700 ring-2 ring-yellow-400',
  }
  return map[status] || 'bg-slate-200 dark:bg-slate-600'
}

function openModuleDialog(mod?: any) {
  if (mod) {
    moduleEditing.value = mod.pk_module
    moduleForm.value = {
      name: mod.module_name,
      description: mod.module_description || '',
      status: mod.module_status,
      startDate: mod.module_start_date ? String(mod.module_start_date).split('T')[0] : '',
      endDate: mod.module_end_date ? String(mod.module_end_date).split('T')[0] : '',
      percentComplete: mod.module_percent_complete ?? 0,
      plan: mod.module_plan || '',
      progress: mod.module_progress || '',
      blockers: mod.module_blockers || '',
      complexity: mod.module_complexity ?? 1.0,
      isMissionCritical: mod.module_is_mission_critical ?? false,
    }
  } else {
    moduleEditing.value = null
    moduleForm.value = { name: '', description: '', status: 'requirements_gathering', startDate: '', endDate: '', percentComplete: 0, plan: '', progress: '', blockers: '', complexity: 1.0, isMissionCritical: false }
  }
  moduleDialog.value = true
}

async function saveModule() {
  try {

    if (moduleEditing.value) {
      await api.put(`/projects/${projectId.value}/modules/${moduleEditing.value}`, moduleForm.value)
    } else {
      await api.post(`/projects/${projectId.value}/modules`, moduleForm.value)
    }
    moduleDialog.value = false
    refresh()
  } catch (e: any) {
    const msg = e?.response?.data?.error?.message || e?.response?.data?.error?.details?.map((d: any) => `${d.field}: ${d.message}`).join(', ') || e?.message || 'Failed to save module'
    alert(msg)
  }
}

async function deleteModule(id: string) {
  if (!confirm('Delete this module?')) return
  try {
    await api.delete(`/projects/${projectId.value}/modules/${id}`)
    refresh()
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Budgets CRUD
// ---------------------------------------------------------------------------
const budgetDialog = ref(false)
const budgetForm = ref<Record<string, any>>({})
const budgetEditing = ref<string | null>(null)

const fundingSourceOptions = [
  { label: 'TI', value: 'TI' },
  { label: 'Ministry', value: 'Ministry' },
  { label: 'Mixed', value: 'Mixed' },
  { label: 'Federal', value: 'Federal' },
  { label: 'Other', value: 'Other' },
]

const moneyTypeOptions = [
  { label: 'Salary', value: 'Salary' },
  { label: 'Operating', value: 'Operating' },
  { label: 'Capital', value: 'Capital' },
]

function openBudgetDialog(b?: any) {
  if (b) {
    budgetEditing.value = b.pk_project_budget
    budgetForm.value = { fiscalYear: b.budget_fiscal_year, fundingSource: b.budget_funding_source, moneyType: b.budget_money_type, amount: b.budget_amount, spent: b.budget_spent, notes: b.budget_notes || '' }
  } else {
    budgetEditing.value = null
    budgetForm.value = { fiscalYear: 'FY26-27', fundingSource: 'TI', moneyType: 'Operating', amount: 0, spent: 0, notes: '' }
  }
  budgetDialog.value = true
}

async function saveBudget() {
  try {

    if (budgetEditing.value) {
      await api.put(`/projects/${projectId.value}/budgets/${budgetEditing.value}`, budgetForm.value)
    } else {
      await api.post(`/projects/${projectId.value}/budgets`, budgetForm.value)
    }
    budgetDialog.value = false
    refresh()
  } catch (e: any) {
    alert(e?.response?.data?.error?.message || 'Failed to save budget')
  }
}

async function deleteBudget(id: string) {
  if (!confirm('Delete this budget line?')) return
  try {
    await api.delete(`/projects/${projectId.value}/budgets/${id}`)
    refresh()
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Links CRUD
// ---------------------------------------------------------------------------
const linkDialog = ref(false)
const linkForm = ref<Record<string, any>>({})

const linkTypeOptions = [
  { label: 'GitHub', value: 'github' },
  { label: 'Confluence', value: 'confluence' },
  { label: 'Jira', value: 'jira' },
  { label: 'SharePoint', value: 'sharepoint' },
  { label: 'Other', value: 'other' },
]

function openLinkDialog() {
  linkForm.value = { type: 'github', url: '', label: '', description: '' }
  linkDialog.value = true
}

async function saveLink() {
  try {
    await api.post(`/projects/${projectId.value}/links`, linkForm.value)
    linkDialog.value = false
    refresh()
  } catch (e: any) {
    alert(e?.response?.data?.error?.message || 'Failed to save link')
  }
}

async function deleteLink(id: string) {
  if (!confirm('Remove this link?')) return
  try {
    await api.delete(`/projects/${projectId.value}/links/${id}`)
    refresh()
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------
const updateDialog = ref(false)
const updateForm = ref<Record<string, any>>({})

const updateTypeOptions = [
  { label: 'Progress', value: 'progress' },
  { label: 'Blocker', value: 'blocker' },
  { label: 'Plan', value: 'plan' },
  { label: 'Risk', value: 'risk' },
  { label: 'Decision', value: 'decision' },
  { label: 'Milestone', value: 'milestone' },
]

function openUpdateDialog() {
  updateForm.value = { type: 'progress', title: '', content: '' }
  updateDialog.value = true
}

async function saveUpdate() {
  try {
    await api.post(`/projects/${projectId.value}/updates`, updateForm.value)
    updateDialog.value = false
    // Reload updates
    const res = await api.get(`/projects/${projectId.value}/updates`)
    if (res.data?.success) updates.value = res.data.data || []
  } catch (e: any) {
    alert(e?.response?.data?.error?.message || 'Failed to post update')
  }
}

// ---------------------------------------------------------------------------
// Leads / Team CRUD
// ---------------------------------------------------------------------------
const leadDialog = ref(false)
const leadForm = ref<Record<string, any>>({})
const leadEditing = ref<string | null>(null)
const personSearchQuery = ref('')
const personSearchResults = ref<any[]>([])
let personSearchTimeout: ReturnType<typeof setTimeout> | null = null

const roleOptions = [
  { label: 'Lead', value: 'lead' },
  { label: 'Delivery Director', value: 'delivery_director' },
  { label: 'Delivery Manager', value: 'delivery_manager' },
  { label: 'Developer', value: 'developer' },
  { label: 'Business Analyst', value: 'business_analyst' },
  { label: 'QA Tester', value: 'qa_tester' },
  { label: 'Designer', value: 'designer' },
  { label: 'Project Manager', value: 'project_manager' },
  { label: 'Product Owner', value: 'product_owner' },
  { label: 'Architect', value: 'architect' },
  { label: 'Data Analyst', value: 'data_analyst' },
  { label: 'DevOps', value: 'devops' },
  { label: 'Scrum Master', value: 'scrum_master' },
  { label: 'Stakeholder', value: 'stakeholder' },
  { label: 'Sponsor', value: 'sponsor' },
  { label: 'Team Member', value: 'team_member' },
  { label: 'Other', value: 'other' },
]

function openLeadDialog(l?: any) {
  if (l) {
    leadEditing.value = l.pk_project_lead
    leadForm.value = { name: l.lead_name, role: l.lead_role || 'team_member', isPrimary: l.lead_is_primary, isFte: l.lead_is_fte ?? true, organization: l.lead_organization || '', personId: l.fk_project_lead_person || null }
  } else {
    leadEditing.value = null
    leadForm.value = { name: '', role: 'team_member', isPrimary: false, isFte: true, organization: '', personId: null }
  }
  personSearchQuery.value = ''
  personSearchResults.value = []
  leadDialog.value = true
}

function onPersonSearch() {
  if (personSearchTimeout) clearTimeout(personSearchTimeout)
  const q = personSearchQuery.value.trim()
  if (q.length < 1) { personSearchResults.value = []; return }
  personSearchTimeout = setTimeout(async () => {
    try {
      const res = await api.get('/persons/search', { params: { q } })
      personSearchResults.value = res.data?.data || []
    } catch { personSearchResults.value = [] }
  }, 250)
}

function selectPerson(p: any) {
  leadForm.value.name = p.person_display_name
  leadForm.value.personId = p.pk_person
  leadForm.value.isFte = p.person_is_fte
  leadForm.value.organization = p.person_organization || ''
  personSearchQuery.value = ''
  personSearchResults.value = []
}

async function saveLead() {
  try {
    if (leadEditing.value) {
      await api.put(`/projects/${projectId.value}/leads/${leadEditing.value}`, leadForm.value)
    } else {
      await api.post(`/projects/${projectId.value}/leads`, leadForm.value)
    }
    leadDialog.value = false
    refresh()
  } catch (e: any) {
    alert(e?.response?.data?.error?.message || 'Failed to save')
  }
}

async function deleteLead(id: string) {
  if (!confirm('Remove this team member?')) return
  try {
    await api.delete(`/projects/${projectId.value}/leads/${id}`)
    refresh()
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Delete update
// ---------------------------------------------------------------------------
async function deleteProjectUpdate(updateId: string) {
  if (!confirm('Delete this update? The action will be recorded in the audit log.')) return
  try {
    await api.delete(`/projects/${projectId.value}/updates/${updateId}`)
    const res = await api.get(`/projects/${projectId.value}/updates`)
    if (res.data?.success) updates.value = res.data.data || []
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------
const auditLog = ref<any[]>([])
const auditTotal = ref(0)
const auditPage = ref(1)
const showAuditLog = ref(false)

async function loadAuditLog(page = 1) {
  auditPage.value = page
  try {
    const res = await api.get(`/projects/${projectId.value}/audit`, { params: { page, limit: 30 } })
    if (res.data?.success) {
      auditLog.value = res.data.data?.data || res.data.data || []
      auditTotal.value = res.data.data?.pagination?.total || auditLog.value.length
    }
  } catch { auditLog.value = [] }
  showAuditLog.value = true
}

// ---------------------------------------------------------------------------
// Module expand + module links
// ---------------------------------------------------------------------------
const expandedModules = ref<Set<string>>(new Set())
const moduleLinks = ref<Record<string, any[]>>({})

function toggleModuleExpand(moduleId: string) {
  if (expandedModules.value.has(moduleId)) {
    expandedModules.value.delete(moduleId)
  } else {
    expandedModules.value.add(moduleId)
    loadModuleLinks(moduleId)
  }
}

async function loadModuleLinks(moduleId: string) {
  try {
    const res = await api.get(`/projects/${projectId.value}/modules/${moduleId}/links`)
    if (res.data?.success) {
      moduleLinks.value[moduleId] = res.data.data || []
    }
  } catch { moduleLinks.value[moduleId] = [] }
}

const moduleLinkDialog = ref(false)
const moduleLinkForm = ref<Record<string, any>>({})
const moduleLinkModuleId = ref<string | null>(null)

function openModuleLinkDialog(moduleId: string) {
  moduleLinkModuleId.value = moduleId
  moduleLinkForm.value = { type: 'github', url: '', label: '', description: '' }
  moduleLinkDialog.value = true
}

async function saveModuleLink() {
  if (!moduleLinkModuleId.value) return
  try {
    await api.post(`/projects/${projectId.value}/modules/${moduleLinkModuleId.value}/links`, moduleLinkForm.value)
    moduleLinkDialog.value = false
    await loadModuleLinks(moduleLinkModuleId.value)
  } catch (e: any) {
    const msg = e?.response?.data?.error?.message || e?.message || 'Failed to save link'
    alert(msg)
  }
}

async function deleteModuleLink(moduleId: string, linkId: string) {
  if (!confirm('Remove this link?')) return
  try {
    await api.delete(`/projects/${projectId.value}/modules/${moduleId}/links/${linkId}`)
    await loadModuleLinks(moduleId)
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Speech-to-text
// ---------------------------------------------------------------------------
const hasSpeechRecognition = typeof window !== 'undefined' && ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window)
const isRecording = ref(false)
let recognition: any = null

function toggleSpeechRecognition() {
  if (isRecording.value) {
    recognition?.stop()
    isRecording.value = false
    return
  }

  const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
  if (!SpeechRecognition) return

  recognition = new SpeechRecognition()
  recognition.continuous = true
  recognition.interimResults = true
  recognition.lang = 'en-CA'

  let finalTranscript = updateForm.value.content || ''

  recognition.onresult = (event: any) => {
    let interim = ''
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const transcript = event.results[i][0].transcript
      if (event.results[i].isFinal) {
        finalTranscript += (finalTranscript ? ' ' : '') + transcript
        updateForm.value.content = finalTranscript
      } else {
        interim += transcript
      }
    }
    // Show interim results
    if (interim) {
      updateForm.value.content = finalTranscript + (finalTranscript ? ' ' : '') + interim
    }
  }

  recognition.onerror = () => { isRecording.value = false }
  recognition.onend = () => { isRecording.value = false }

  recognition.start()
  isRecording.value = true
}

function formatRole(role: string): string {
  return roleOptions.find(r => r.value === role)?.label || role?.replace(/_/g, ' ') || 'Team Member'
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function formatDate(d: string | null | undefined): string {
  if (!d) return 'TBD'
  return String(d).split('T')[0]
}

function formatCurrency(val: number | null | undefined): string {
  if (val === null || val === undefined) return 'N/A'
  return new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 }).format(Number(val))
}

function linkIcon(type: string): string {
  const map: Record<string, string> = { github: 'pi pi-github', confluence: 'pi pi-book', jira: 'pi pi-ticket', sharepoint: 'pi pi-folder', other: 'pi pi-link' }
  return map[type] || 'pi pi-link'
}

const p = computed(() => project.value)
const canEdit = computed(() => auth.isAuthenticated)

const totalBudget = computed(() => budgets.value.reduce((s, b) => s + Number(b.budget_amount || 0), 0))
const totalSpent = computed(() => budgets.value.reduce((s, b) => s + Number(b.budget_spent || 0), 0))
</script>

<template>
  <div class="min-h-screen pt-8 px-4 md:px-8">
    <div class="max-w-screen-2xl mx-auto">
      <button @click="router.back()" class="inline-flex items-center gap-1 text-sm font-geist text-slate-500 hover:text-indigo-600 mb-6 transition-colors">
        <ArrowLeft class="w-4 h-4" /> Back
      </button>

      <div v-if="loading" class="text-center py-20 text-slate-400 font-geist">Loading project...</div>
      <div v-else-if="!p" class="text-center py-20">
        <h2 class="text-2xl font-jakarta font-bold text-slate-400 mb-2">Project Not Found</h2>
        <router-link to="/projects" class="text-sm font-geist text-indigo-600">Browse all projects</router-link>
      </div>

      <template v-else>
        <!-- Lock + clone-policy controls used to be standalone banners above the
             card; they're now compact pills inside the header bar (below). -->
        <!-- ── Header (View Mode) ─────────────────────────────────────── -->
        <div v-if="!editing" class="bg-white rounded-2xl border border-slate-200 p-6 md:p-8 mb-6 relative overflow-hidden">
          <div class="absolute top-0 left-0 right-0 h-1.5 bg-indigo-600"></div>

          <!--
            Header bar — single horizontal flex with consistent vertical centering.
            All chip/badges + actions sit on one shared baseline (h-7 = 28px).
            Below `md` everything (badges + lock/clone-policy pills + action buttons)
            collapses into a hamburger menu so the row stays clean.
          -->
          <div class="flex items-center gap-2 mb-4 mt-1">
            <!-- LEFT GROUP: badges + inline lock/clone-policy pills.
                 Hidden below md (replaced by hamburger). -->
            <div class="hidden md:flex flex-wrap items-center gap-2 min-w-0">
              <span class="inline-flex items-center h-7 px-2 text-xs font-geist font-semibold uppercase rounded-full bg-indigo-50 text-indigo-600 whitespace-nowrap">{{ p.ministry_code }}</span>
              <span class="inline-flex items-center h-7 px-2 text-xs font-geist font-semibold rounded-full bg-slate-100 text-slate-600 whitespace-nowrap">{{ p.project_status?.replace(/_/g, ' ') }}</span>
              <span v-if="p.project_go_live_date_type" class="inline-flex items-center h-7 px-2 text-xs font-geist font-semibold rounded-full bg-amber-50 text-amber-600 whitespace-nowrap">{{ p.project_go_live_date_type }}</span>
              <span
                v-if="riskAssessment.level !== 'no-data'"
                class="inline-flex items-center h-7 px-2 text-xs font-geist font-semibold rounded-full whitespace-nowrap"
                :class="RISK_BG_CLASSES[riskAssessment.level] || ''"
                :style="{ color: riskAssessment.color }"
              >{{ riskAssessment.label }}</span>
              <span
                v-if="p.project_is_mission_critical"
                class="inline-flex items-center h-7 px-2 text-xs font-geist font-semibold rounded-full bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400 whitespace-nowrap"
              >Mission Critical</span>
              <span
                v-if="p.project_is_challenge"
                class="inline-flex items-center h-7 px-2 text-xs font-geist font-semibold rounded-full bg-amber-50 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400 whitespace-nowrap"
              >Challenge ({{ p.challenge_points || 0 }} pts)</span>

              <!-- Lineage indicator -->
              <span
                v-if="(p as any).fk_project_parent"
                class="inline-flex items-center h-7 px-2 text-[11px] font-geist text-violet-700 dark:text-violet-300 rounded-full bg-violet-50 dark:bg-violet-900/30 whitespace-nowrap"
                v-tooltip="`Cloned from ${(p as any).project_cloned_from_name || 'parent'}`"
              >
                ↳ clone
              </span>

              <!-- Version label (or inline editor) -->
              <template v-if="!editingVersionLabel">
                <span v-if="(p as any).project_version_label" class="inline-flex items-center h-7 px-2 text-xs font-geist font-semibold rounded-full bg-violet-50 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300 whitespace-nowrap">
                  {{ (p as any).project_version_label }}
                </span>
                <button
                  v-if="collabPerms?.canRename"
                  class="inline-flex items-center justify-center h-7 w-7 rounded-full text-slate-400 hover:text-indigo-600 hover:bg-slate-100 dark:hover:bg-slate-700"
                  @click="versionLabelDraft = (p as any).project_version_label || ''; editingVersionLabel = true"
                  title="Rename version"
                >
                  <Pencil class="w-3.5 h-3.5" />
                </button>
              </template>
              <template v-else>
                <input
                  v-model="versionLabelDraft"
                  class="h-7 text-xs px-2 rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900"
                  placeholder="Version label"
                  @keyup.enter="saveVersionLabel"
                />
                <button class="inline-flex items-center h-7 px-2 text-xs rounded bg-indigo-600 text-white hover:bg-indigo-700" @click="saveVersionLabel">Save</button>
                <button class="inline-flex items-center h-7 px-2 text-xs rounded bg-slate-200 dark:bg-slate-700" @click="editingVersionLabel = false">Cancel</button>
              </template>

              <!-- Cluster badge -->
              <VersionsBadge :project-id="projectId" />

              <!-- Lock state pill (visible to everyone when locked; click-to-acquire for owners when unlocked) -->
              <span
                v-if="(p as any).project_is_locked && (p as any).project_locked_by === auth.user?.id"
                class="inline-flex items-center h-7 px-2 gap-1 text-xs font-semibold rounded-full bg-rose-100 text-rose-800 whitespace-nowrap"
                v-tooltip="(p as any).project_lock_reason || 'You have a lock on this project'"
              >
                <Lock class="w-3 h-3" /> Locked by you
              </span>
              <span
                v-else-if="(p as any).project_is_locked"
                class="inline-flex items-center h-7 px-2 gap-1 text-xs font-semibold rounded-full bg-rose-50 text-rose-700 whitespace-nowrap"
                v-tooltip="(p as any).project_lock_reason || `Locked by ${lockedByName || 'another user'}`"
              >
                <Lock class="w-3 h-3" /> Locked{{ lockedByName ? ` · ${lockedByName}` : '' }}
              </span>
              <button
                v-else-if="collabPerms?.canToggleLock"
                @click="showLockDialog = true"
                class="inline-flex items-center h-7 px-2 gap-1 text-xs font-medium rounded-full bg-slate-100 hover:bg-slate-200 dark:bg-slate-700 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-200 whitespace-nowrap"
                v-tooltip="'Prevent other members from editing while you focus'"
              >
                <Lock class="w-3 h-3" /> Lock
              </button>
              <!-- Quick-release for own lock -->
              <button
                v-if="(p as any).project_is_locked && (p as any).project_locked_by === auth.user?.id"
                @click="releaseLock(false)"
                class="inline-flex items-center h-7 px-2 text-xs rounded-full bg-emerald-100 hover:bg-emerald-200 text-emerald-800 whitespace-nowrap"
              >
                Release
              </button>
              <!-- Admin force-unlock -->
              <button
                v-if="(p as any).project_is_locked && (p as any).project_locked_by !== auth.user?.id && collabPerms?.isAdmin"
                @click="releaseLock(true)"
                class="inline-flex items-center h-7 px-2 text-xs rounded-full bg-amber-100 hover:bg-amber-200 text-amber-800 whitespace-nowrap"
                v-tooltip="'Admin override — writes audit entry'"
              >
                Force-unlock
              </button>

              <!-- Clone-policy pill (always shown when disabled; admins can toggle either direction) -->
              <span
                v-if="(p as any).project_clone_disabled"
                class="inline-flex items-center h-7 px-2 gap-1 text-xs font-semibold rounded-full bg-amber-50 text-amber-700 whitespace-nowrap"
                v-tooltip="(p as any).project_clone_disabled_reason || 'Cloning has been disabled by an admin'"
              >
                🚫 Cloning disabled
              </span>
              <button
                v-if="collabPerms?.canTogglePolicy"
                @click="openClonePolicyDialog"
                class="inline-flex items-center h-7 px-2 text-xs font-medium rounded-full whitespace-nowrap"
                :class="(p as any).project_clone_disabled
                  ? 'bg-emerald-100 hover:bg-emerald-200 text-emerald-800'
                  : 'bg-slate-100 hover:bg-slate-200 dark:bg-slate-700 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-200'"
              >
                {{ (p as any).project_clone_disabled ? 'Re-enable cloning' : 'Disable cloning' }}
              </button>

              <!-- Project code (kept inline with the rest of the metadata) -->
              <span
                class="inline-flex items-center h-7 px-2 text-xs font-geist font-mono font-semibold rounded bg-slate-50 dark:bg-slate-800 text-slate-500"
                v-tooltip="'Project code'"
              >
                {{ p.project_code || p.pk_project?.substring(0, 8) }}
              </span>
            </div>

            <!-- SPACER — pushes the right group to the right edge on wide screens -->
            <div class="flex-1 hidden md:block"></div>

            <!-- RIGHT GROUP: action buttons (md+) or hamburger (mobile) -->
            <div class="flex items-center gap-2 ml-auto md:ml-0 flex-shrink-0">
              <!-- Inline action buttons — visible on md+ -->
              <div class="hidden md:flex items-center gap-2">
                <Button
                  v-if="collabPerms?.canClone && !(p as any).fk_project_parent"
                  size="small"
                  severity="secondary"
                  outlined
                  class="h-7"
                  @click="showCloneDialog = true"
                  v-tooltip="'Clone this project'"
                >
                  Clone <GitFork class="w-3.5 h-3.5 ml-1" />
                </Button>
                <Button
                  v-if="collaboration.clusters[projectId]?.versions && collaboration.clusters[projectId]!.versions.length > 1"
                  size="small"
                  severity="secondary"
                  outlined
                  class="h-7"
                  @click="router.push(`/projects/${projectId}/cluster`)"
                  v-tooltip="'View all versions in this cluster'"
                >
                  <Network class="w-3.5 h-3.5 mr-1" /> Cluster
                </Button>
                <Button v-if="canEdit" size="small" severity="secondary" outlined class="h-7" @click="startEdit">
                  Edit <Edit3 class="w-3.5 h-3.5 ml-1" />
                </Button>
                <Button v-if="canEdit" icon="pi pi-trash" size="small" severity="danger" outlined class="h-7 w-7 p-0" @click="deleteProject" v-tooltip="'Delete project'" />
              </div>

              <!-- Hamburger fallback — visible below md -->
              <button
                v-if="actionsMenuItems.length > 0"
                class="md:hidden inline-flex items-center justify-center h-7 w-7 rounded border border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700"
                @click="toggleActionsMenu"
                aria-haspopup="true"
                aria-controls="project-actions-menu"
                v-tooltip="'Project actions'"
              >
                <span class="sr-only">Project actions</span>
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16" /></svg>
              </button>
              <Menu ref="actionsMenu" id="project-actions-menu" :model="actionsMenuItems" :popup="true" />
            </div>
          </div>

          <h1 class="text-2xl md:text-3xl font-jakarta font-bold text-slate-900 mb-3">{{ p.project_name }}</h1>
          <p class="text-sm font-geist text-slate-600 leading-relaxed max-w-4xl mb-6">{{ p.project_description || 'No description.' }}</p>

          <div class="grid sm:grid-cols-2 lg:grid-cols-4 gap-4 text-sm font-geist">
            <div><div class="text-[10px] text-slate-400 uppercase">Ministry</div><div class="text-slate-700">{{ p.ministry_name || p.ministry_code }}</div></div>
            <div><div class="text-[10px] text-slate-400 uppercase">Timeline</div><div class="text-slate-700">{{ formatDate(p.project_start_date) }} → {{ formatDate(p.project_end_date) }}</div></div>
            <div><div class="text-[10px] text-slate-400 uppercase">Completion</div><div class="text-slate-700">{{ p.project_percent_complete ?? 0 }}%</div></div>
            <div><div class="text-[10px] text-slate-400 uppercase">Demand #</div><div class="text-slate-700">{{ p.project_demand_number || 'N/A' }}</div></div>
          </div>

          <!-- Progress bar -->
          <div v-if="p.project_percent_complete != null" class="mt-4">
            <div class="h-2.5 bg-slate-100 rounded-full overflow-hidden">
              <div class="h-full rounded-full bg-indigo-600 transition-all" :style="{ width: `${p.project_percent_complete}%` }"></div>
            </div>
          </div>
        </div>

        <!-- ── Delivery Risk Banner ─────────────────────────────────────── -->
        <div
          v-if="!editing && riskAssessment.level !== 'no-data'"
          class="rounded-2xl border p-5 mb-6"
          :class="RISK_BG_CLASSES[riskAssessment.level] || RISK_BG_CLASSES['no-data']"
        >
          <div class="flex items-start gap-3">
            <component :is="riskAssessment.level === 'on-track' || riskAssessment.level === 'completed' ? CheckCircle : riskAssessment.level === 'at-risk' ? AlertTriangle : ShieldAlert"
              class="w-6 h-6 flex-shrink-0 mt-0.5" :style="{ color: riskAssessment.color }" />
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 mb-1">
                <span class="text-sm font-jakarta font-bold text-slate-900 dark:text-slate-100">Delivery Risk</span>
                <span class="text-xs font-geist font-bold px-2 py-0.5 rounded-full" :style="{ backgroundColor: riskAssessment.color + '20', color: riskAssessment.color }">{{ riskAssessment.label }}</span>
              </div>
              <p class="text-sm font-geist text-slate-600 dark:text-slate-300">{{ riskAssessment.reason }}</p>
              <div v-if="riskAssessment.expectedPct !== null && riskAssessment.actualPct !== null" class="mt-2">
                <div class="flex items-center justify-between text-[10px] font-geist text-slate-500 dark:text-slate-400 mb-1">
                  <span>Actual: {{ riskAssessment.actualPct }}%</span>
                  <span>Expected: {{ riskAssessment.expectedPct }}%</span>
                </div>
                <div class="relative h-2.5 bg-white/60 dark:bg-slate-800/60 rounded-full overflow-hidden">
                  <div class="absolute top-0 bottom-0 border-r-2 border-dashed border-slate-400 z-10" :style="{ left: `${riskAssessment.expectedPct}%` }"></div>
                  <div class="h-full rounded-full" :style="{ width: `${riskAssessment.actualPct}%`, backgroundColor: riskAssessment.color }"></div>
                </div>
                <div class="flex gap-4 text-[10px] font-geist text-slate-400 mt-1">
                  <span v-if="riskAssessment.daysRemaining !== null">{{ riskAssessment.daysRemaining > 0 ? `${riskAssessment.daysRemaining} days remaining` : `${Math.abs(riskAssessment.daysRemaining)} days overdue` }}</span>
                  <span v-if="riskAssessment.velocityNeeded">Velocity needed: {{ riskAssessment.velocityNeeded }}x</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- ── Project Audits ─────────────────────────────────────── -->
        <div v-if="!editing" class="bg-white rounded-2xl border border-slate-200 p-6 mb-6">
          <!-- Header row -->
          <div class="flex items-center gap-3 mb-3">
            <button @click="auditsExpanded = !auditsExpanded" class="flex items-center gap-2 flex-1 min-w-0 text-left">
              <svg class="w-4 h-4 text-slate-400 transition-transform flex-shrink-0" :class="auditsExpanded ? 'rotate-90' : ''" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" /></svg>
              <h2 class="text-lg font-jakarta font-bold text-slate-900 flex items-center gap-2">
                Audits
                <span class="text-xs font-geist font-normal text-slate-400">({{ audits.length }})</span>
              </h2>
              <span v-if="audits.some((a: any) => a.audit_status === 'running')" class="text-[10px] font-geist px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-600 animate-pulse flex-shrink-0">
                {{ audits.filter((a: any) => a.audit_status === 'running').length }} running
              </span>
            </button>
            <button
              @click="runProjectAudit"
              :disabled="projectAuditRunning"
              class="flex items-center gap-1.5 px-4 py-2 text-xs font-geist font-medium rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors flex-shrink-0 whitespace-nowrap"
            >
              <Shield class="w-3.5 h-3.5" />
              {{ projectAuditRunning ? 'Analyzing...' : 'Project Audit' }}
            </button>
            <button
              @click="runDeepAudit()"
              :disabled="deepAuditRunning"
              class="flex items-center gap-1.5 px-4 py-2 text-xs font-geist font-medium rounded-lg border-2 border-indigo-600 text-indigo-600 hover:bg-indigo-50 disabled:opacity-50 transition-colors flex-shrink-0 whitespace-nowrap"
            >
              <Database class="w-3.5 h-3.5" />
              {{ deepAuditRunning ? 'Running...' : 'Deep Audit' }}
            </button>
          </div>
          <!-- Deep Audit Progress -->
          <div v-if="deepAuditProgress" class="mb-4 bg-indigo-50 rounded-xl p-4 border border-indigo-100">
            <div class="flex items-center gap-3 mb-2">
              <div class="w-2 h-2 rounded-full bg-indigo-500 animate-pulse"></div>
              <span class="text-xs font-jakarta font-bold text-indigo-800">Deep Audit in Progress</span>
            </div>

            <!-- Phase indicators -->
            <div class="flex items-center gap-1 mb-3">
              <div v-for="phase in ['discovery', 'selection', 'loading', 'analysis', 'consolidation']" :key="phase"
                class="flex-1 h-1.5 rounded-full transition-colors"
                :class="deepAuditPhaseStatus(phase) === 'completed' ? 'bg-emerald-400' : deepAuditPhaseStatus(phase) === 'active' ? 'bg-indigo-400 animate-pulse' : 'bg-slate-200'">
              </div>
            </div>
            <div class="flex justify-between text-[9px] font-geist text-slate-400 mb-2">
              <span>Discovery</span><span>Selection</span><span>Loading</span><span>Analysis</span><span>Final</span>
            </div>

            <!-- Current phase detail -->
            <div class="text-xs font-geist text-indigo-700">
              <span v-if="deepAuditProgress.phase === 'discovery' && deepAuditProgress.status === 'started'">Scanning repository file tree...</span>
              <span v-else-if="deepAuditProgress.phase === 'discovery' && deepAuditProgress.status === 'completed'">Found {{ deepAuditProgress.filteredFiles }} files ({{ deepAuditProgress.totalFiles }} total, {{ deepAuditProgress.stubFiles }} stubs)</span>
              <span v-else-if="deepAuditProgress.phase === 'selection'">AI selecting most relevant files for audit...</span>
              <span v-else-if="deepAuditProgress.phase === 'loading'">Loading files: {{ deepAuditProgress.current || 0 }}/{{ deepAuditProgress.total || '?' }} ({{ deepAuditProgress.loaded || 0 }} loaded)</span>
              <span v-else-if="deepAuditProgress.phase === 'analysis'">Analyzing batch {{ deepAuditProgress.current || '?' }}/{{ deepAuditProgress.total || '?' }}: {{ deepAuditProgress.detail || '' }}</span>
              <span v-else-if="deepAuditProgress.phase === 'consolidation'">Consolidating findings into final report...</span>
              <span v-else-if="deepAuditProgress.phase === 'error'" class="text-red-600">Error: {{ deepAuditProgress.detail }}</span>
              <span v-else>{{ deepAuditProgress.detail || 'Starting...' }}</span>
            </div>
          </div>
          <div v-if="audits.length === 0 && auditsExpanded" class="text-sm text-slate-400 font-geist text-center py-4 border border-dashed border-slate-200 rounded-xl">
            No audits run yet. Link external dependencies, then run an audit.
          </div>
          <div v-else-if="auditsExpanded" class="space-y-2">
            <div v-for="a in audits.slice((auditListPage - 1) * auditListPerPage, auditListPage * auditListPerPage)" :key="a.pk_project_audit"
              class="p-3 rounded-xl border transition-colors"
              :class="a.audit_status === 'running' ? 'border-indigo-200 bg-indigo-50/30 animate-pulse' : a.audit_status === 'failed' ? 'border-red-200 bg-red-50/30' : 'border-slate-100 hover:border-indigo-200 hover:bg-slate-50/50 cursor-pointer'"
              @click="a.audit_status === 'completed' && openAuditDetail(a)">
              <div class="flex items-center gap-2 mb-1">
                <span class="text-[10px] font-geist font-semibold px-2 py-0.5 rounded-full" :class="{
                  'bg-emerald-50 text-emerald-600': a.audit_source === 'git',
                  'bg-blue-50 text-blue-600': a.audit_source === 'jira',
                  'bg-purple-50 text-purple-600': a.audit_source === 'confluence',
                  'bg-amber-50 text-amber-600': a.audit_source === 'ai_analysis',
                  'bg-indigo-50 text-indigo-600': a.audit_source === 'deep-audit',
                  'bg-slate-100 text-slate-500': !['git','jira','confluence','ai_analysis','deep-audit'].includes(a.audit_source),
                }">{{ a.audit_source }}</span>
                <!-- Status badge -->
                <span v-if="a.audit_status === 'running'" class="text-[9px] font-geist px-1.5 py-0.5 rounded-full bg-indigo-100 text-indigo-600 animate-pulse">Extracting...</span>
                <span v-else-if="a.audit_status === 'failed'" class="text-[9px] font-geist px-1.5 py-0.5 rounded-full bg-red-100 text-red-600">Failed</span>
                <span v-else-if="a.audit_status === 'pending'" class="text-[9px] font-geist px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-600">Queued</span>
                <span class="text-xs font-geist text-slate-700 truncate flex-1">{{ a.audit_title }}</span>
                <button
                  v-if="a.audit_status === 'completed' || a.audit_status === 'failed'"
                  @click.stop="a.audit_source_url && runSingleAudit(a.audit_source_url, a.audit_source)"
                  class="text-[9px] font-geist px-1.5 py-0.5 rounded border border-slate-200 text-slate-400 hover:text-indigo-600 hover:border-indigo-300 transition-colors flex-shrink-0"
                  title="Re-run this audit"
                >Re-run</button>
                <button
                  v-if="a.created_by === auth.user?.id"
                  @click.stop="deleteAudit(a.pk_project_audit)"
                  class="text-[9px] font-geist px-1.5 py-0.5 rounded border border-slate-200 text-slate-400 hover:text-red-600 hover:border-red-300 transition-colors flex-shrink-0"
                  title="Delete this audit"
                >Delete</button>
                <span class="text-[10px] font-geist text-slate-400 flex-shrink-0">{{ new Date(a.created_at).toLocaleDateString() }}</span>
              </div>
              <div v-if="a.audit_ai_score != null" class="mt-1">
                <span class="text-[10px] font-geist text-slate-400">AI Score:</span>
                <span class="text-xs font-geist font-semibold" :class="a.audit_ai_score >= 70 ? 'text-emerald-600' : a.audit_ai_score >= 40 ? 'text-amber-600' : 'text-red-600'">{{ a.audit_ai_score }}%</span>
              </div>
              <p v-if="a.audit_summary && a.audit_status !== 'running'" class="text-[11px] font-geist text-slate-400 mt-0.5 truncate">{{ a.audit_summary }}</p>
            </div>
            <!-- Pagination -->
            <div v-if="audits.length > auditListPerPage" class="flex items-center justify-between pt-2 border-t border-slate-100 mt-2">
              <span class="text-[10px] font-geist text-slate-400">{{ (auditListPage - 1) * auditListPerPage + 1 }}–{{ Math.min(auditListPage * auditListPerPage, audits.length) }} of {{ audits.length }}</span>
              <div class="flex gap-1">
                <button @click="auditListPage = Math.max(1, auditListPage - 1)" :disabled="auditListPage <= 1" class="px-2 py-0.5 text-[10px] font-geist rounded border border-slate-200 hover:bg-slate-50 disabled:opacity-30">&lsaquo;</button>
                <button @click="auditListPage = Math.min(Math.ceil(audits.length / auditListPerPage), auditListPage + 1)" :disabled="auditListPage >= Math.ceil(audits.length / auditListPerPage)" class="px-2 py-0.5 text-[10px] font-geist rounded border border-slate-200 hover:bg-slate-50 disabled:opacity-30">&rsaquo;</button>
              </div>
            </div>
          </div>
        </div>

        <!-- ── Header (Edit Mode) ─────────────────────────────────────── -->
        <div v-else class="bg-white rounded-2xl border border-indigo-200 p-6 md:p-8 mb-6">
          <div class="flex items-center justify-between mb-6">
            <h2 class="text-lg font-jakarta font-bold text-slate-900">Edit Project</h2>
            <div class="flex gap-2">
              <Button size="small" severity="secondary" outlined @click="editing = false">Cancel</Button>
              <Button size="small" :loading="saving" @click="saveProject">Save</Button>
            </div>
          </div>
          <div class="grid md:grid-cols-2 gap-4">
            <div>
              <label class="text-xs font-geist text-slate-500 mb-1 block">Project Code</label>
              <InputText v-model="editForm.projectCode" class="w-full" placeholder="e.g. PRJ-0001 or DMND0001234" />
            </div>
            <div>
              <label class="text-xs font-geist text-slate-500 mb-1 block">Project Name <span class="text-red-500">*</span></label>
              <InputText v-model="editForm.name" class="w-full" :maxlength="500" />
            </div>
            <div class="md:col-span-2">
              <label class="text-xs font-geist text-slate-500 mb-1 block">Description</label>
              <Textarea v-model="editForm.description" rows="3" class="w-full" />
            </div>
            <div>
              <label class="text-xs font-geist text-slate-500 mb-1 block">Ministry <span class="text-red-500">*</span></label>
              <Select v-model="editForm.ministryCode" :options="ministryOptions" option-label="label" option-value="value" filter placeholder="Select ministry" class="w-full" />
            </div>
            <div>
              <label class="text-xs font-geist text-slate-500 mb-1 block">Status</label>
              <Select v-model="editForm.status" :options="statusOptions" option-label="label" option-value="value" class="w-full" />
            </div>
            <div>
              <label class="text-xs font-geist text-slate-500 mb-1 block">Go-Live Date Type</label>
              <Select v-model="editForm.goLiveDateType" :options="goLiveDateTypeOptions" option-label="label" option-value="value" class="w-full" />
            </div>
            <div>
              <label class="text-xs font-geist text-slate-500 mb-1 block">Start Date</label>
              <InputText v-model="editForm.startDate" type="date" max="9999-12-31" class="w-full" />
            </div>
            <div>
              <label class="text-xs font-geist text-slate-500 mb-1 block">End Date</label>
              <InputText v-model="editForm.endDate" type="date" max="9999-12-31" class="w-full" />
            </div>
            <div>
              <label class="text-xs font-geist text-slate-500 mb-1 block">% Complete</label>
              <InputNumber v-model="editForm.percentComplete" :min="0" :max="100" suffix="%" class="w-full" />
            </div>
            <div>
              <label class="text-xs font-geist text-slate-500 mb-1 block">Priority</label>
              <InputText v-model="editForm.priority" class="w-full" />
            </div>
            <div>
              <label class="text-xs font-geist text-slate-500 mb-1 block">Demand Number</label>
              <InputText v-model="editForm.demandNumber" class="w-full" />
            </div>
            <div>
              <label class="text-xs font-geist text-slate-500 mb-1 block">Branch</label>
              <InputText v-model="editForm.branch" class="w-full" />
            </div>
            <div class="md:col-span-2">
              <label class="text-xs font-geist text-slate-500 mb-1 block">Risk if Not Delivered</label>
              <Textarea v-model="editForm.risk" rows="2" class="w-full" />
            </div>
            <div class="md:col-span-2">
              <label class="text-xs font-geist text-slate-500 mb-1 block">Additional Info</label>
              <Textarea v-model="editForm.additionalInfo" rows="2" class="w-full" />
            </div>
            <div class="md:col-span-2 flex items-center gap-3">
              <label class="flex items-center gap-2 text-sm font-geist text-slate-700 dark:text-slate-300 cursor-pointer">
                <input type="checkbox" v-model="editForm.isMissionCritical" class="rounded accent-red-600" />
                <span class="font-medium">Mission Critical</span>
              </label>
              <span class="text-xs font-geist text-slate-400 dark:text-slate-500">Flag this project as mission critical for the organization</span>
            </div>
            <!-- Challenge settings (project_lead / admin only) -->
            <div class="md:col-span-2 border-t border-slate-100 dark:border-slate-800 pt-4 mt-2">
              <div class="flex items-center gap-3 mb-3">
                <label class="flex items-center gap-2 text-sm font-geist text-slate-700 dark:text-slate-300 cursor-pointer">
                  <input type="checkbox" v-model="editForm.isChallenge" class="rounded accent-amber-600" />
                  <span class="font-medium">Challenge</span>
                </label>
                <span class="text-xs font-geist text-slate-400 dark:text-slate-500">Post this as a Challenge on the Challenges board for runners to claim</span>
              </div>
              <div v-if="editForm.isChallenge" class="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div>
                  <label class="text-xs font-geist text-slate-500 dark:text-slate-400 mb-1 block">Difficulty &amp; Points</label>
                  <select v-model="editForm.challengeDifficulty" class="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800 text-sm font-geist text-slate-800 dark:text-slate-200">
                    <option value="easy">Easy (100 pts)</option>
                    <option value="medium">Medium (250 pts)</option>
                    <option value="hard">Hard (500 pts)</option>
                    <option value="expert">Expert (1,000 pts)</option>
                  </select>
                </div>
                <div>
                  <label class="text-xs font-geist text-slate-500 dark:text-slate-400 mb-1 block">Max Days to Complete</label>
                  <InputNumber v-model="editForm.challengeMaxDays" :min="1" :max="30" class="w-full" />
                </div>
                <div>
                  <label class="text-xs font-geist text-slate-500 dark:text-slate-400 mb-1 block">
                    Max Acceptances <span class="text-slate-400">(blank = unlimited)</span>
                  </label>
                  <InputNumber
                    v-model="editForm.challengeMaxAcceptances"
                    :min="1"
                    :max="1000"
                    :useGrouping="false"
                    placeholder="Unlimited"
                    showClear
                    class="w-full"
                  />
                  <p class="text-[10px] font-geist text-slate-400 mt-1">
                    Cap how many people can accept (clone) the challenge. Leave blank for unlimited; set a number for first-come, first-served.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="grid lg:grid-cols-3 gap-6 mb-8">
          <div class="lg:col-span-2 space-y-6">

            <!-- ── Modules ──────────────────────────────────────── -->
            <div class="bg-white rounded-2xl border border-slate-200 p-6">
              <div class="flex items-center justify-between mb-4">
                <h2 class="text-lg font-jakarta font-bold text-slate-900 flex items-center gap-2"><FolderOpen class="w-5 h-5 text-indigo-600" /> Modules / Milestones</h2>
                <Button v-if="canEdit" label="Add Module" icon="pi pi-plus" size="small" severity="secondary" outlined @click="openModuleDialog()" />
              </div>
              <div v-if="modules.length === 0" class="text-sm text-slate-400 font-geist py-4 text-center border border-dashed border-slate-200 rounded-xl">No modules yet.</div>
              <div v-else class="space-y-3">
                <div v-for="mod in modules" :key="mod.pk_module" class="rounded-xl border border-slate-200 overflow-hidden">
                  <!-- Module header row -->
                  <div class="flex items-center gap-3 p-3 hover:bg-slate-50 transition-colors cursor-pointer" @click="toggleModuleExpand(mod.pk_module)">
                    <div class="w-2.5 h-2.5 rounded-full flex-shrink-0" :class="mod.module_status === 'delivered' || mod.module_status === 'closed' ? 'bg-green-500' : mod.module_status === 'building' ? 'bg-blue-500' : 'bg-slate-300'"></div>
                    <div class="flex-1 min-w-0">
                      <div class="flex items-center gap-2">
                        <span class="text-sm font-geist font-medium text-slate-900 dark:text-slate-100 cursor-pointer hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors" @click.stop="openModuleDetailDialog(mod)">{{ mod.module_name }}</span>
                        <span v-if="mod.module_complexity && mod.module_complexity !== 1" class="text-[9px] font-geist px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-600 font-semibold">×{{ mod.module_complexity }}</span>
                        <span v-if="mod.module_is_mission_critical" class="text-[9px] font-geist px-1.5 py-0.5 rounded bg-red-50 text-red-600 font-semibold">Critical</span>
                      </div>
                      <div class="text-[10px] font-geist text-slate-400">{{ mod.module_status?.replace(/_/g, ' ') }} &middot; {{ mod.module_percent_complete ?? 0 }}%
                        <span v-if="mod.module_end_date"> &middot; Due {{ formatDate(mod.module_end_date) }}</span>
                        <span v-if="moduleLinks[mod.pk_module]?.length"> &middot; {{ moduleLinks[mod.pk_module].length }} link(s)</span>
                      </div>
                      <!-- Velocity step mini-bar -->
                      <div v-if="getModuleVelocity(mod.pk_module)" class="flex gap-0.5 mt-1">
                        <div v-for="step in getModuleVelocity(mod.pk_module).steps" :key="step.step_name"
                          class="h-1.5 flex-1 rounded-sm" :class="velocityStepColor(step.status)"
                          :title="`${step.step_name}: ${step.status}`"></div>
                      </div>
                    </div>
                    <div class="hidden sm:flex items-center gap-3">
                      <!-- Velocity score -->
                      <div v-if="getModuleVelocity(mod.pk_module)" class="text-center">
                        <div class="text-[9px] font-geist text-slate-400">Score</div>
                        <div class="text-xs font-jakarta font-bold text-indigo-600">{{ velocityData?.metrics?.find?.((m: any) => m.fk_mvm_module === mod.pk_module)?.velocity_score || 0 }}</div>
                      </div>
                      <!-- Percent bar -->
                      <div v-if="mod.module_percent_complete != null" class="flex items-center gap-2 w-24">
                        <div class="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                          <div class="h-full rounded-full bg-indigo-500" :style="{ width: `${mod.module_percent_complete}%` }"></div>
                        </div>
                        <span class="text-[10px] font-geist text-slate-500 w-8 text-right">{{ mod.module_percent_complete }}%</span>
                      </div>
                    </div>
                    <Button v-if="canEdit" icon="pi pi-pencil" size="small" severity="secondary" text rounded @click.stop="openModuleDialog(mod)" aria-label="Edit module" />
                    <Button v-if="canEdit" icon="pi pi-trash" size="small" severity="danger" text rounded @click.stop="deleteModule(mod.pk_module)" aria-label="Delete module" />
                    <i class="pi text-slate-400 text-xs" :class="expandedModules.has(mod.pk_module) ? 'pi-chevron-up' : 'pi-chevron-down'"></i>
                  </div>

                  <!-- Expanded: description, plan/progress/blockers, links -->
                  <div v-if="expandedModules.has(mod.pk_module)" class="border-t border-slate-100 p-3 bg-slate-50/50 space-y-3">
                    <p v-if="mod.module_description" class="text-xs font-geist text-slate-600">{{ mod.module_description }}</p>
                    <div v-if="mod.module_plan" class="text-xs font-geist"><span class="text-slate-400 font-semibold">Plan:</span> <span class="text-slate-600">{{ mod.module_plan }}</span></div>
                    <div v-if="mod.module_progress" class="text-xs font-geist"><span class="text-slate-400 font-semibold">Progress:</span> <span class="text-slate-600">{{ mod.module_progress }}</span></div>
                    <div v-if="mod.module_blockers" class="text-xs font-geist"><span class="text-red-400 font-semibold">Blockers:</span> <span class="text-slate-600">{{ mod.module_blockers }}</span></div>

                    <!-- Module links -->
                    <div class="pt-2 border-t border-slate-100">
                      <div class="flex items-center justify-between mb-2">
                        <span class="text-[10px] font-geist font-semibold text-slate-500 uppercase">Module Links</span>
                        <Button v-if="canEdit" label="Add Link" icon="pi pi-plus" size="small" severity="secondary" text @click="openModuleLinkDialog(mod.pk_module)" />
                      </div>
                      <div v-if="!moduleLinks[mod.pk_module]?.length" class="text-[10px] text-slate-400 font-geist">No links yet.</div>
                      <div v-else class="space-y-1">
                        <div v-for="link in moduleLinks[mod.pk_module]" :key="link.pk_module_link" class="flex items-center gap-2 text-xs font-geist group">
                          <span class="text-[9px] font-semibold px-1.5 py-0.5 rounded bg-slate-200 text-slate-600 uppercase">{{ link.link_type }}</span>
                          <a :href="link.link_url" target="_blank" rel="noopener" class="text-indigo-600 hover:text-indigo-700 truncate flex-1">{{ link.link_label || link.link_url }}</a>
                          <Button v-if="canEdit" icon="pi pi-trash" size="small" severity="danger" text rounded class="opacity-0 group-hover:opacity-100" @click="deleteModuleLink(mod.pk_module, link.pk_module_link)" aria-label="Remove link" />
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <!-- ── Links (GitHub, Confluence, Jira, SharePoint) ── -->
            <div class="bg-white rounded-2xl border border-slate-200 p-6">
              <div class="flex items-center justify-between mb-4">
                <h2 class="text-lg font-jakarta font-bold text-slate-900 flex items-center gap-2"><Link2 class="w-5 h-5 text-indigo-600" /> External Links</h2>
                <div class="flex items-center gap-2">
                  <button v-if="links.some((l: any) => ['github','jira','confluence','sharepoint'].includes(l.link_type))"
                    @click="runAllExternalAudits" :disabled="auditRunning"
                    class="text-[9px] font-geist px-2 py-1 rounded border border-slate-200 text-slate-500 hover:text-indigo-600 hover:border-indigo-300 hover:bg-indigo-50 transition-colors">
                    {{ auditRunning ? 'Running...' : 'Audit All' }}
                  </button>
                  <Button v-if="canEdit" label="Add Link" icon="pi pi-plus" size="small" severity="secondary" outlined @click="openLinkDialog()" />
                </div>
              </div>
              <div v-if="links.length === 0" class="text-sm text-slate-400 font-geist py-4 text-center border border-dashed border-slate-200 rounded-xl">No links yet. Add GitHub, Confluence, Jira, or SharePoint links.</div>
              <div v-else class="space-y-2">
                <div v-for="link in links" :key="link.pk_project_link" class="flex items-center gap-2 p-3 rounded-xl border border-slate-100">
                  <span class="text-[10px] font-geist font-semibold px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 uppercase flex-shrink-0">{{ link.link_type }}</span>
                  <a :href="link.link_url" target="_blank" rel="noopener" class="flex-1 min-w-0 text-sm font-geist text-indigo-600 hover:text-indigo-700 truncate">
                    {{ link.link_label || link.link_url }}
                    <ExternalLink class="inline w-3 h-3 ml-1" />
                  </a>
                  <button
                    v-if="['github', 'jira', 'confluence', 'sharepoint'].includes(link.link_type)"
                    @click.stop="runSingleAudit(link.link_url, link.link_type === 'github' ? 'git' : link.link_type)"
                    class="text-[9px] font-geist px-2 py-1 rounded border border-slate-200 text-slate-500 hover:text-indigo-600 hover:border-indigo-300 hover:bg-indigo-50 transition-colors flex-shrink-0"
                    title="Run audit on this resource"
                  >Audit</button>
                  <button
                    v-if="link.link_type === 'github'"
                    @click.stop="runDeepAudit(link.link_url)"
                    :disabled="deepAuditRunning"
                    class="text-[9px] font-geist px-2 py-1 rounded border border-indigo-300 text-indigo-500 hover:text-indigo-700 hover:border-indigo-500 hover:bg-indigo-50 transition-colors flex-shrink-0"
                    title="Run deep code audit (AI analyzes actual files)"
                  >Deep</button>
                  <Button v-if="canEdit" icon="pi pi-trash" size="small" severity="danger" text rounded @click="deleteLink(link.pk_project_link)" aria-label="Remove link" />
                </div>
              </div>
            </div>

            <!-- ── SharePoint ──────────────────────────────────── -->
            <SharePointPanel
              v-if="!editing"
              :project-id="projectId"
              :project-name="p.project_name || ''"
              :can-edit="canEdit"
              @refresh="refresh"
            />

            <!-- ── Risk ──────────────────────────────────────── -->
            <div v-if="p.project_risk" class="bg-white rounded-2xl border border-slate-200 p-6">
              <h2 class="text-lg font-jakarta font-bold text-slate-900 mb-3 flex items-center gap-2"><AlertTriangle class="w-5 h-5 text-amber-500" /> Risk if Not Delivered</h2>
              <p class="text-sm font-geist text-slate-600 leading-relaxed whitespace-pre-line">{{ p.project_risk }}</p>
            </div>

            <!-- ── Additional Info ───────────────────────────── -->
            <div v-if="p.project_additional_info" class="bg-white rounded-2xl border border-slate-200 p-6">
              <h2 class="text-lg font-jakarta font-bold text-slate-900 mb-3">Additional Information</h2>
              <p class="text-sm font-geist text-slate-600 leading-relaxed whitespace-pre-line">{{ p.project_additional_info }}</p>
            </div>

            <!-- ── Updates Log ───────────────────────────────── -->
            <div class="bg-white rounded-2xl border border-slate-200 p-6">
              <div class="flex items-center justify-between mb-4">
                <h2 class="text-lg font-jakarta font-bold text-slate-900 flex items-center gap-2"><RefreshCw class="w-5 h-5 text-indigo-600" /> Updates</h2>
                <Button v-if="canEdit" label="Post Update" icon="pi pi-plus" size="small" severity="secondary" outlined @click="openUpdateDialog()" />
              </div>
              <div v-if="updates.length === 0" class="text-sm text-slate-400 font-geist py-4 text-center border border-dashed border-slate-200 rounded-xl">No updates yet.</div>
              <div v-else class="space-y-3">
                <div v-for="u in updates" :key="u.pk_project_update" class="p-3 rounded-xl border border-slate-100 group">
                  <div class="flex items-center gap-2 mb-1">
                    <span class="text-[10px] font-geist font-semibold px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">{{ u.update_type }}</span>
                    <span class="text-[10px] font-geist text-slate-400">{{ new Date(u.created_at).toLocaleString() }}</span>
                    <span v-if="u.user_display_name" class="text-[10px] font-geist text-slate-400">&middot; {{ u.user_display_name }}</span>
                    <Button v-if="canEdit" icon="pi pi-trash" size="small" severity="danger" text rounded class="ml-auto opacity-0 group-hover:opacity-100" @click="deleteProjectUpdate(u.pk_project_update)" aria-label="Delete update" />
                  </div>
                  <div v-if="u.update_title" class="text-sm font-geist font-medium text-slate-900 mb-1">{{ u.update_title }}</div>
                  <p class="text-sm font-geist text-slate-600 whitespace-pre-line">{{ u.update_content }}</p>
                </div>
              </div>
            </div>

            <!-- ── Audit Log (paginated, immutable) ─────────── -->
            <div class="bg-white rounded-2xl border border-slate-200 p-6">
              <div class="flex items-center justify-between mb-4">
                <h2 class="text-lg font-jakarta font-bold text-slate-900 flex items-center gap-2">
                  <i class="pi pi-history text-slate-500"></i> Audit Log
                  <span v-if="showAuditLog" class="text-xs font-geist text-slate-400 font-normal">({{ auditTotal }} entries)</span>
                </h2>
                <Button :label="showAuditLog ? 'Refresh' : 'Load History'" icon="pi pi-refresh" size="small" severity="secondary" outlined @click="loadAuditLog(1)" />
              </div>
              <div v-if="!showAuditLog" class="text-sm text-slate-400 font-geist py-4 text-center border border-dashed border-slate-200 rounded-xl">
                Click "Load History" to see all changes. Audit entries are immutable and cannot be deleted.
              </div>
              <div v-else-if="auditLog.length === 0" class="text-sm text-slate-400 font-geist py-4 text-center">No audit entries found.</div>
              <template v-else>
                <div class="space-y-2 mb-4">
                  <div v-for="entry in auditLog" :key="entry.pk_audit_log" class="p-2 rounded-lg border border-slate-50 text-xs font-geist">
                    <div class="flex items-center gap-2 mb-1">
                      <span class="font-semibold text-slate-700">{{ entry.action }}</span>
                      <span class="text-slate-400">on {{ entry.table_name }}</span>
                      <span class="text-slate-400 ml-auto">{{ new Date(entry.created_at).toLocaleString() }}</span>
                    </div>
                    <div v-if="entry.user_display_name" class="text-[10px] text-slate-400">by {{ entry.user_display_name }}</div>
                    <div v-if="entry.new_data" class="text-[10px] text-green-600 mt-1">+ {{ JSON.stringify(entry.new_data) }}</div>
                    <div v-if="entry.old_data" class="text-[10px] text-red-500 mt-0.5">- {{ JSON.stringify(entry.old_data) }}</div>
                  </div>
                </div>
                <div v-if="auditTotal > 30" class="flex items-center justify-between text-xs font-geist text-slate-400">
                  <span>Page {{ auditPage }} of {{ Math.ceil(auditTotal / 30) }}</span>
                  <div class="flex gap-2">
                    <Button label="Prev" size="small" severity="secondary" text :disabled="auditPage <= 1" @click="loadAuditLog(auditPage - 1)" />
                    <Button label="Next" size="small" severity="secondary" text :disabled="auditPage >= Math.ceil(auditTotal / 30)" @click="loadAuditLog(auditPage + 1)" />
                  </div>
                </div>
              </template>
            </div>
          </div>

          <!-- ── Right Sidebar ───────────────────────────────── -->
          <div class="space-y-6">

            <!-- ── Linked Applications ──────────────────────── -->
            <div class="bg-white rounded-2xl border border-slate-200 p-6">
              <div class="flex items-center justify-between mb-3">
                <h2 class="text-sm font-jakarta font-bold text-slate-900">Applications</h2>
                <button v-if="canEdit" @click="appLinkDialog = true; appLinkForm = { applicationId: '', moduleId: null, relationshipType: 'other', description: '' }; applicationSearchQuery = ''; applicationSearchResults = []" class="text-xs font-geist text-indigo-600 hover:text-indigo-700">+ Link</button>
              </div>
              <div v-if="linkedApplications.length === 0" class="text-xs font-geist text-slate-400 py-2">No applications linked.</div>
              <div v-for="link in linkedApplications" :key="link.pk_project_application" class="flex items-start justify-between py-2 border-b border-slate-50 last:border-0">
                <div class="min-w-0">
                  <div class="text-sm font-geist text-slate-800 truncate">{{ link.application_name }}</div>
                  <div class="flex items-center gap-2 mt-0.5">
                    <span class="text-[10px] font-geist px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-600">{{ link.pa_relationship_type }}</span>
                    <span v-if="link.module_name" class="text-[10px] font-geist text-slate-400">{{ link.module_name }}</span>
                  </div>
                  <div v-if="link.pa_description" class="text-[11px] font-geist text-slate-400 mt-0.5">{{ link.pa_description }}</div>
                </div>
                <button v-if="canEdit" @click="removeAppLink(link.pk_project_application)" class="text-slate-300 hover:text-red-500 ml-2 flex-shrink-0" title="Unlink">
                  <X class="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            <!-- ── Linked Contracts ──────────────────────── -->
            <div class="bg-white rounded-2xl border border-slate-200 p-6">
              <div class="flex items-center justify-between mb-3">
                <h2 class="text-sm font-jakarta font-bold text-slate-900">Contracts</h2>
                <button v-if="canEdit" @click="contractLinkDialog = true; contractLinkForm = { contractId: '', moduleId: null, relationshipType: 'other', description: '' }; contractSearchQuery = ''; contractSearchResults = []" class="text-xs font-geist text-indigo-600 hover:text-indigo-700">+ Link</button>
              </div>
              <div v-if="linkedContracts.length === 0" class="text-xs font-geist text-slate-400 py-2">No contracts linked.</div>
              <div v-for="link in linkedContracts" :key="link.pk_project_contract" class="flex items-start justify-between py-2 border-b border-slate-50 last:border-0">
                <div class="min-w-0">
                  <div class="text-sm font-geist text-slate-800 truncate">{{ link.contract_name }}</div>
                  <div class="flex items-center gap-2 mt-0.5">
                    <span class="text-[10px] font-geist px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-600">{{ link.pc_relationship_type }}</span>
                    <span v-if="link.contract_vendor" class="text-[10px] font-geist text-slate-400">{{ link.contract_vendor }}</span>
                  </div>
                  <div v-if="link.pc_description" class="text-[11px] font-geist text-slate-400 mt-0.5">{{ link.pc_description }}</div>
                </div>
                <button v-if="canEdit" @click="removeContractLink(link.pk_project_contract)" class="text-slate-300 hover:text-red-500 ml-2 flex-shrink-0" title="Unlink">
                  <X class="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            <!-- Budgets -->
            <div class="bg-white rounded-2xl border border-slate-200 p-6">
              <div class="flex items-center justify-between mb-3">
                <h2 class="text-lg font-jakarta font-bold text-slate-900 flex items-center gap-2"><DollarSign class="w-5 h-5 text-teal-600" /> Budget</h2>
                <Button v-if="canEdit" icon="pi pi-plus" size="small" severity="secondary" text rounded @click="openBudgetDialog()" aria-label="Add budget line" />
              </div>
              <div class="space-y-2 mb-4">
                <div class="flex justify-between text-sm font-geist">
                  <span class="text-slate-400">Total Budget</span>
                  <span class="font-semibold text-slate-900">{{ formatCurrency(totalBudget) }}</span>
                </div>
                <div class="flex justify-between text-sm font-geist">
                  <span class="text-slate-400">Total Spent</span>
                  <span class="font-semibold text-slate-900">{{ formatCurrency(totalSpent) }}</span>
                </div>
                <div v-if="totalBudget > 0" class="h-2 bg-slate-100 rounded-full overflow-hidden">
                  <div class="h-full rounded-full" :class="totalSpent > totalBudget ? 'bg-red-500' : 'bg-teal-500'" :style="{ width: `${Math.min((totalSpent / totalBudget) * 100, 100)}%` }"></div>
                </div>
              </div>
              <!-- Per-fiscal-year breakdown -->
              <div v-if="budgets.length === 0" class="text-xs text-slate-400 font-geist text-center py-2 border border-dashed border-slate-200 rounded-lg">No budget lines.</div>
              <div v-else class="space-y-2">
                <div v-for="b in budgets" :key="b.pk_project_budget" class="p-2 rounded-lg border border-slate-100 text-xs font-geist">
                  <div class="flex items-center justify-between">
                    <span class="font-semibold text-slate-700">{{ b.budget_fiscal_year }}</span>
                    <div class="flex gap-1">
                      <Button v-if="canEdit" icon="pi pi-pencil" size="small" severity="secondary" text rounded @click="openBudgetDialog(b)" aria-label="Edit budget" />
                      <Button v-if="canEdit" icon="pi pi-trash" size="small" severity="danger" text rounded @click="deleteBudget(b.pk_project_budget)" aria-label="Delete budget" />
                    </div>
                  </div>
                  <div class="text-slate-500">{{ b.budget_funding_source }} &middot; {{ b.budget_money_type }}</div>
                  <div class="text-slate-600">{{ formatCurrency(b.budget_amount) }} budgeted, {{ formatCurrency(b.budget_spent) }} spent</div>
                </div>
              </div>
            </div>

            <!-- Metadata -->
            <div class="bg-white rounded-2xl border border-slate-200 p-6">
              <h2 class="text-lg font-jakarta font-bold text-slate-900 mb-3 flex items-center gap-2"><Database class="w-5 h-5 text-slate-500" /> Metadata</h2>
              <div class="space-y-2 text-sm font-geist">
                <div v-if="p.project_priority" class="flex justify-between"><span class="text-slate-400">Priority</span><span class="text-slate-700">{{ p.project_priority }}</span></div>
                <div v-if="p.project_ministry_priority" class="flex justify-between"><span class="text-slate-400">Ministry Priority</span><span class="text-slate-700">#{{ p.project_ministry_priority }}</span></div>
                <div v-if="p.project_branch" class="flex justify-between"><span class="text-slate-400">Branch</span><span class="text-slate-700">{{ p.project_branch }}</span></div>
                <div v-if="p.project_category" class="flex justify-between"><span class="text-slate-400">Category</span><span class="text-slate-700">{{ p.project_category }}</span></div>
                <div v-if="p.project_source" class="flex justify-between"><span class="text-slate-400">Source</span><span class="text-slate-700 text-xs">{{ p.project_source }}</span></div>
                <div class="flex justify-between"><span class="text-slate-400">Updated</span><span class="text-slate-700 text-xs">{{ p.updated_at ? new Date(p.updated_at).toLocaleString() : '—' }}</span></div>
              </div>
            </div>

            <!-- Leads & Team -->
            <div class="bg-white rounded-2xl border border-slate-200 p-6">
              <div class="flex items-center justify-between mb-3">
                <h2 class="text-lg font-jakarta font-bold text-slate-900 flex items-center gap-2"><Users class="w-5 h-5 text-indigo-600" /> Team ({{ leads.length }})</h2>
                <Button v-if="canEdit" label="Add Member" icon="pi pi-plus" size="small" severity="secondary" outlined @click="openLeadDialog()" />
              </div>
              <div v-if="leads.length === 0" class="text-xs text-slate-400 font-geist text-center py-3 border border-dashed border-slate-200 rounded-lg">No team members assigned.</div>
              <div v-else class="space-y-1.5">
                <div v-for="l in leads" :key="l.pk_project_lead" class="flex items-center gap-2 text-sm font-geist p-2 rounded-lg hover:bg-slate-50 group">
                  <User class="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
                  <span class="text-slate-700 font-medium">{{ l.lead_name }}</span>
                  <span v-if="l.lead_is_primary" class="text-[9px] px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-600 font-semibold">Primary</span>
                  <span class="text-[9px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">{{ formatRole(l.lead_role) }}</span>
                  <span v-if="l.lead_is_fte === false" class="text-[9px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-600">Contractor</span>
                  <span v-if="l.lead_organization" class="text-[9px] text-slate-400">{{ l.lead_organization }}</span>
                  <div class="ml-auto flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity" v-if="canEdit">
                    <Button icon="pi pi-pencil" size="small" severity="secondary" text rounded @click="openLeadDialog(l)" aria-label="Edit" />
                    <Button icon="pi pi-trash" size="small" severity="danger" text rounded @click="deleteLead(l.pk_project_lead)" aria-label="Remove" />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </template>

      <!-- ── Module Dialog ──────────────────────────────────────── -->
      <Dialog v-model:visible="moduleDialog" :header="moduleEditing ? 'Edit Module' : 'Add Module'" :modal="true" :style="{ width: '680px' }" :breakpoints="{ '768px': '95vw' }">
        <div class="grid gap-4">
          <div><label class="text-xs font-geist text-slate-500 mb-1 block">Name <span class="text-red-500">*</span></label><InputText v-model="moduleForm.name" class="w-full" :maxlength="500" /></div>
          <div><label class="text-xs font-geist text-slate-500 mb-1 block">Description</label><Textarea v-model="moduleForm.description" rows="2" class="w-full" /></div>
          <div class="grid grid-cols-2 gap-4">
            <div><label class="text-xs font-geist text-slate-500 mb-1 block">Status</label><Select v-model="moduleForm.status" :options="moduleStatusOptions" option-label="label" option-value="value" class="w-full" /></div>
            <div><label class="text-xs font-geist text-slate-500 mb-1 block">% Complete</label><InputNumber v-model="moduleForm.percentComplete" :min="0" :max="100" suffix="%" class="w-full" /></div>
          </div>
          <div class="grid grid-cols-2 gap-4">
            <div><label class="text-xs font-geist text-slate-500 mb-1 block">Start Date</label><InputText v-model="moduleForm.startDate" type="date" max="9999-12-31" class="w-full" /></div>
            <div><label class="text-xs font-geist text-slate-500 mb-1 block">End Date</label><InputText v-model="moduleForm.endDate" type="date" max="9999-12-31" class="w-full" /></div>
          </div>
          <div><label class="text-xs font-geist text-slate-500 mb-1 block">Plan</label><Textarea v-model="moduleForm.plan" rows="2" class="w-full" placeholder="AI or manual plan notes..." /></div>
          <div><label class="text-xs font-geist text-slate-500 mb-1 block">Progress</label><Textarea v-model="moduleForm.progress" rows="2" class="w-full" /></div>
          <div><label class="text-xs font-geist text-slate-500 mb-1 block">Blockers</label><Textarea v-model="moduleForm.blockers" rows="2" class="w-full" placeholder="Any blockers..." /></div>
          <div class="grid grid-cols-2 gap-4">
            <div><label class="text-xs font-geist text-slate-500 mb-1 block">Complexity (0–10)</label><InputNumber v-model="moduleForm.complexity" :min="0" :max="10" :step="0.25" :minFractionDigits="0" :maxFractionDigits="2" class="w-full" /></div>
            <div class="flex items-end gap-2 pb-1">
              <label class="flex items-center gap-2 cursor-pointer select-none">
                <input type="checkbox" v-model="moduleForm.isMissionCritical" class="accent-red-500 w-4 h-4" />
                <span class="text-xs font-geist text-slate-600">Mission Critical</span>
              </label>
            </div>
          </div>
        </div>
        <template #footer>
          <Button severity="secondary" outlined @click="moduleDialog = false">Cancel</Button>
          <Button @click="saveModule" :disabled="!moduleForm.name">Save</Button>
        </template>
      </Dialog>

      <!-- ── Module Detail Dialog (shared component) ──────────── -->
      <ModuleDetailDialog
        v-if="moduleDetailMod"
        v-model:visible="moduleDetailVisible"
        :module-id="moduleDetailMod.pk_module"
        :project-id="projectId"
        :project-name="project?.project_name || ''"
        :module-name="moduleDetailMod.module_name"
        :module-data="moduleDetailMod"
        :can-edit="canEdit"
        :velocity-steps="getModuleVelocitySteps(moduleDetailMod.pk_module)"
        :velocity-metrics="getModuleVelocityMetrics(moduleDetailMod.pk_module)"
        @refresh="refresh"
        @edit-module="moduleDetailVisible = false; openModuleDialog(moduleDetailMod)"
      />

      <!-- ── Budget Dialog ──────────────────────────────────────── -->
      <Dialog v-model:visible="budgetDialog" :header="budgetEditing ? 'Edit Budget Line' : 'Add Budget Line'" :modal="true" :style="{ width: '560px' }" :breakpoints="{ '768px': '95vw' }">
        <div class="grid gap-4">
          <div><label class="text-xs font-geist text-slate-500 mb-1 block">Fiscal Year <span class="text-red-500">*</span></label><InputText v-model="budgetForm.fiscalYear" class="w-full" placeholder="e.g. FY26-27" :maxlength="20" /></div>
          <div><label class="text-xs font-geist text-slate-500 mb-1 block">Funding Source <span class="text-red-500">*</span></label><Select v-model="budgetForm.fundingSource" :options="fundingSourceOptions" option-label="label" option-value="value" class="w-full" /></div>
          <div><label class="text-xs font-geist text-slate-500 mb-1 block">Money Type <span class="text-red-500">*</span></label><Select v-model="budgetForm.moneyType" :options="moneyTypeOptions" option-label="label" option-value="value" class="w-full" /></div>
          <div class="grid grid-cols-2 gap-4">
            <div><label class="text-xs font-geist text-slate-500 mb-1 block">Budget Amount</label><InputNumber v-model="budgetForm.amount" mode="currency" currency="CAD" locale="en-CA" class="w-full" /></div>
            <div><label class="text-xs font-geist text-slate-500 mb-1 block">Spent</label><InputNumber v-model="budgetForm.spent" mode="currency" currency="CAD" locale="en-CA" class="w-full" /></div>
          </div>
          <div><label class="text-xs font-geist text-slate-500 mb-1 block">Notes</label><Textarea v-model="budgetForm.notes" rows="2" class="w-full" /></div>
        </div>
        <template #footer>
          <Button severity="secondary" outlined @click="budgetDialog = false">Cancel</Button>
          <Button @click="saveBudget" :disabled="!budgetForm.fiscalYear || !budgetForm.fundingSource || !budgetForm.moneyType">Save</Button>
        </template>
      </Dialog>

      <!-- ── Link Dialog ──────────────────────────────────────── -->
      <Dialog v-model:visible="linkDialog" header="Add External Link" :modal="true" :style="{ width: '560px' }" :breakpoints="{ '768px': '95vw' }">
        <div class="grid gap-4">
          <div><label class="text-xs font-geist text-slate-500 mb-1 block">Type <span class="text-red-500">*</span></label><Select v-model="linkForm.type" :options="linkTypeOptions" option-label="label" option-value="value" class="w-full" /></div>
          <div>
            <label class="text-xs font-geist text-slate-500 mb-1 block">URL <span class="text-red-500">*</span></label>
            <InputText v-model="linkForm.url" class="w-full" placeholder="https://..." :maxlength="2000" :invalid="!!linkForm.url && !/^https?:\/\/.+/.test(linkForm.url)" />
            <small v-if="linkForm.url && !/^https?:\/\/.+/.test(linkForm.url)" class="text-red-500 text-xs mt-1 block">Must be a valid http:// or https:// URL</small>
          </div>
          <div><label class="text-xs font-geist text-slate-500 mb-1 block">Label</label><InputText v-model="linkForm.label" class="w-full" placeholder="Optional display label" :maxlength="255" /></div>
          <div><label class="text-xs font-geist text-slate-500 mb-1 block">Description</label><InputText v-model="linkForm.description" class="w-full" /></div>
        </div>
        <template #footer>
          <Button severity="secondary" outlined @click="linkDialog = false">Cancel</Button>
          <Button @click="saveLink" :disabled="!linkForm.url || !linkForm.type || !/^https?:\/\/.+/.test(linkForm.url)">Save</Button>
        </template>
      </Dialog>

      <!-- ── Update Dialog ──────────────────────────────────────── -->
      <Dialog v-model:visible="updateDialog" header="Post Update" :modal="true" :style="{ width: '560px' }" :breakpoints="{ '768px': '95vw' }">
        <div class="grid gap-4">
          <div><label class="text-xs font-geist text-slate-500 mb-1 block">Type</label><Select v-model="updateForm.type" :options="updateTypeOptions" option-label="label" option-value="value" class="w-full" /></div>
          <div><label class="text-xs font-geist text-slate-500 mb-1 block">Title</label><InputText v-model="updateForm.title" class="w-full" /></div>
          <div>
            <div class="flex items-center justify-between mb-1">
              <label class="text-xs font-geist text-slate-500">Content <span class="text-red-500">*</span></label>
              <button
                v-if="hasSpeechRecognition"
                @click="toggleSpeechRecognition"
                class="flex items-center gap-1 text-xs font-geist px-2 py-1 rounded-lg transition-colors"
                :class="isRecording ? 'bg-red-100 text-red-600 animate-pulse' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'"
                type="button"
              >
                <svg class="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm-1 1.93c-3.94-.49-7-3.85-7-7.93h2c0 3.31 2.69 6 6 6s6-2.69 6-6h2c0 4.08-3.06 7.44-7 7.93V20h4v2H8v-2h4v-4.07z"/></svg>
                {{ isRecording ? 'Stop' : 'Dictate' }}
              </button>
            </div>
            <Textarea v-model="updateForm.content" rows="4" class="w-full" :placeholder="isRecording ? 'Listening...' : 'Enter update content'" />
          </div>
        </div>
        <template #footer>
          <Button severity="secondary" outlined @click="updateDialog = false">Cancel</Button>
          <Button @click="saveUpdate" :disabled="!updateForm.content">Post</Button>
        </template>
      </Dialog>

      <!-- ── Module Link Dialog ──────────────────────────────── -->
      <Dialog v-model:visible="moduleLinkDialog" header="Add Module Link" :modal="true" :style="{ width: '520px' }" :breakpoints="{ '768px': '95vw' }">
        <div class="grid gap-4">
          <div><label class="text-xs font-geist text-slate-500 mb-1 block">Type <span class="text-red-500">*</span></label><Select v-model="moduleLinkForm.type" :options="linkTypeOptions" option-label="label" option-value="value" class="w-full" /></div>
          <div>
            <label class="text-xs font-geist text-slate-500 mb-1 block">URL <span class="text-red-500">*</span></label>
            <InputText v-model="moduleLinkForm.url" class="w-full" placeholder="https://..." :maxlength="2000" :invalid="!!moduleLinkForm.url && !/^https?:\/\/.+/.test(moduleLinkForm.url)" />
            <small v-if="moduleLinkForm.url && !/^https?:\/\/.+/.test(moduleLinkForm.url)" class="text-red-500 text-xs mt-1 block">Must be a valid http:// or https:// URL</small>
          </div>
          <div><label class="text-xs font-geist text-slate-500 mb-1 block">Label</label><InputText v-model="moduleLinkForm.label" class="w-full" placeholder="Optional display label" :maxlength="255" /></div>
          <div><label class="text-xs font-geist text-slate-500 mb-1 block">Description</label><InputText v-model="moduleLinkForm.description" class="w-full" /></div>
        </div>
        <template #footer>
          <Button label="Cancel" severity="secondary" outlined @click="moduleLinkDialog = false" />
          <Button label="Add Link" @click="saveModuleLink" :disabled="!moduleLinkForm.url || !moduleLinkForm.type || !/^https?:\/\/.+/.test(moduleLinkForm.url)" />
        </template>
      </Dialog>

      <!-- ── Lead / Team Member Dialog ─────────────────────────── -->
      <Dialog v-model:visible="leadDialog" :header="leadEditing ? 'Edit Team Member' : 'Add Team Member'" :modal="true" :style="{ width: '560px' }" :breakpoints="{ '768px': '95vw' }">
        <div class="grid gap-4">
          <!-- Typeahead search -->
          <div class="relative">
            <label class="text-xs font-geist text-slate-500 mb-1 block">Search existing people</label>
            <InputText v-model="personSearchQuery" class="w-full" placeholder="Type a name to search..." @input="onPersonSearch" />
            <div v-if="personSearchResults.length > 0" class="absolute z-10 mt-1 w-full bg-white border border-slate-200 rounded-xl shadow-lg max-h-48 overflow-y-auto">
              <button
                v-for="p in personSearchResults"
                :key="p.pk_person"
                class="w-full text-left px-3 py-2 text-sm font-geist hover:bg-slate-50 flex items-center gap-2 border-b border-slate-50 last:border-0"
                @click="selectPerson(p)"
              >
                <User class="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
                <div>
                  <div class="text-slate-700">{{ p.person_display_name }}</div>
                  <div class="text-[10px] text-slate-400">
                    {{ p.person_is_fte ? 'FTE' : 'Contractor' }}
                    <span v-if="p.person_organization"> &middot; {{ p.person_organization }}</span>
                  </div>
                </div>
              </button>
            </div>
          </div>
          <div>
            <label class="text-xs font-geist text-slate-500 mb-1 block">Name <span class="text-red-500">*</span></label>
            <InputText v-model="leadForm.name" class="w-full" placeholder="Or enter a new name" />
          </div>
          <div class="grid grid-cols-2 gap-4">
            <div>
              <label class="text-xs font-geist text-slate-500 mb-1 block">Role</label>
              <Select v-model="leadForm.role" :options="roleOptions" option-label="label" option-value="value" class="w-full" />
            </div>
            <div class="flex items-end gap-4 pb-1">
              <label class="flex items-center gap-2 text-sm font-geist text-slate-600 cursor-pointer">
                <input type="checkbox" v-model="leadForm.isPrimary" class="rounded" />
                Primary Lead
              </label>
              <label class="flex items-center gap-2 text-sm font-geist text-slate-600 cursor-pointer">
                <input type="checkbox" v-model="leadForm.isFte" class="rounded" />
                FTE
              </label>
            </div>
          </div>
          <div v-if="!leadForm.isFte">
            <label class="text-xs font-geist text-slate-500 mb-1 block">Organization (Contractor)</label>
            <InputText v-model="leadForm.organization" class="w-full" placeholder="e.g. CGI, Vantix" />
          </div>
        </div>
        <template #footer>
          <Button severity="secondary" outlined @click="leadDialog = false">Cancel</Button>
          <Button @click="saveLead" :disabled="!leadForm.name">Save</Button>
        </template>
      </Dialog>

      <!-- ── Application Link Dialog ──────────────────────────── -->
      <Dialog v-model:visible="appLinkDialog" header="Link Application" :modal="true" :style="{ width: '560px' }" :breakpoints="{ '768px': '95vw' }">
        <div class="grid gap-4">
          <div class="relative">
            <label class="text-xs font-geist text-slate-500 mb-1 block">Search Applications <span class="text-red-500">*</span></label>
            <InputText v-model="applicationSearchQuery" class="w-full" placeholder="Type to search applications..." @input="onAppSearch" />
            <div v-if="applicationSearchResults.length > 0" class="absolute z-10 mt-1 w-full bg-white border border-slate-200 rounded-xl shadow-lg max-h-48 overflow-y-auto">
              <button v-for="a in applicationSearchResults" :key="a.pk_application" class="w-full text-left px-3 py-2 text-sm font-geist hover:bg-slate-50 border-b border-slate-50 last:border-0" @click="appLinkForm.applicationId = a.pk_application; applicationSearchQuery = a.application_name; applicationSearchResults = []">
                <div class="text-slate-700">{{ a.application_name }}</div>
                <div class="text-[10px] text-slate-400">{{ a.application_type || '' }} &middot; {{ a.application_install_type || '' }}</div>
              </button>
            </div>
          </div>
          <div>
            <label class="text-xs font-geist text-slate-500 mb-1 block">Relationship Type <span class="text-red-500">*</span></label>
            <Select v-model="appLinkForm.relationshipType" :options="[{ label: 'Replacing', value: 'replacing' }, { label: 'Dependency', value: 'dependency' }, { label: 'Integration', value: 'integration' }, { label: 'API', value: 'api' }, { label: 'Supports', value: 'supports' }, { label: 'Other', value: 'other' }]" option-label="label" option-value="value" class="w-full" />
          </div>
          <div>
            <label class="text-xs font-geist text-slate-500 mb-1 block">Description</label>
            <InputText v-model="appLinkForm.description" class="w-full" placeholder="Why is this application linked?" />
          </div>
        </div>
        <template #footer>
          <Button severity="secondary" outlined @click="appLinkDialog = false">Cancel</Button>
          <Button @click="saveAppLink" :disabled="!appLinkForm.applicationId">Link</Button>
        </template>
      </Dialog>

      <!-- ── Contract Link Dialog ──────────────────────────── -->
      <Dialog v-model:visible="contractLinkDialog" header="Link Contract" :modal="true" :style="{ width: '560px' }" :breakpoints="{ '768px': '95vw' }">
        <div class="grid gap-4">
          <div class="relative">
            <label class="text-xs font-geist text-slate-500 mb-1 block">Search Contracts <span class="text-red-500">*</span></label>
            <InputText v-model="contractSearchQuery" class="w-full" placeholder="Type to search contracts..." @input="onContractSearch" />
            <div v-if="contractSearchResults.length > 0" class="absolute z-10 mt-1 w-full bg-white border border-slate-200 rounded-xl shadow-lg max-h-48 overflow-y-auto">
              <button v-for="c in contractSearchResults" :key="c.pk_contract" class="w-full text-left px-3 py-2 text-sm font-geist hover:bg-slate-50 border-b border-slate-50 last:border-0" @click="contractLinkForm.contractId = c.pk_contract; contractSearchQuery = c.contract_name; contractSearchResults = []">
                <div class="text-slate-700">{{ c.contract_name }}</div>
                <div class="text-[10px] text-slate-400">{{ c.contract_vendor || '' }} &middot; {{ c.contract_external_id || '' }}</div>
              </button>
            </div>
          </div>
          <div>
            <label class="text-xs font-geist text-slate-500 mb-1 block">Relationship Type <span class="text-red-500">*</span></label>
            <Select v-model="contractLinkForm.relationshipType" :options="[{ label: 'Funded By', value: 'funded_by' }, { label: 'Delivered Under', value: 'delivered_under' }, { label: 'Staffing / Resources', value: 'staffing' }, { label: 'Licensing', value: 'licensing' }, { label: 'Maintenance & Support', value: 'maintenance' }, { label: 'Infrastructure', value: 'infrastructure' }, { label: 'Consulting / Advisory', value: 'consulting' }, { label: 'Other', value: 'other' }]" option-label="label" option-value="value" class="w-full" />
          </div>
          <div>
            <label class="text-xs font-geist text-slate-500 mb-1 block">Description</label>
            <InputText v-model="contractLinkForm.description" class="w-full" placeholder="Why is this contract linked?" />
          </div>
        </div>
        <template #footer>
          <Button severity="secondary" outlined @click="contractLinkDialog = false">Cancel</Button>
          <Button @click="saveContractLink" :disabled="!contractLinkForm.contractId">Link</Button>
        </template>
      </Dialog>

      <!-- ── Audit Detail Dialog ──────────────────────────── -->
      <Dialog v-model:visible="auditDetailDialog" :header="selectedAudit?.audit_title || 'Audit Report'" :modal="true"
        :style="{ width: 'calc(100vw - 80px)', height: 'calc(100vh - 80px)' }" :breakpoints="{ '768px': '100vw' }"
        :contentStyle="{ overflow: 'auto', maxHeight: 'calc(100vh - 160px)' }">
        <template v-if="selectedAudit">
          <div v-if="auditDetailLoading" class="text-center py-12 text-slate-400 font-geist">Loading audit data...</div>
          <template v-else>
            <!-- Audit meta -->
            <div class="flex items-center gap-3 mb-6">
              <span class="text-[11px] font-geist font-semibold px-2 py-1 rounded-full" :class="{
                'bg-emerald-50 text-emerald-600': selectedAudit.audit_source === 'git',
                'bg-blue-50 text-blue-600': selectedAudit.audit_source === 'jira',
                'bg-slate-100 text-slate-600': true,
              }">{{ selectedAudit.audit_source?.toUpperCase() }}</span>
              <span class="text-xs font-geist text-slate-400">{{ new Date(selectedAudit.created_at).toLocaleString() }}</span>
              <span v-if="selectedAudit.audit_source_url" class="text-xs font-geist text-indigo-600"><a :href="selectedAudit.audit_source_url" target="_blank" class="hover:underline">{{ selectedAudit.audit_source_url }}</a></span>
            </div>

            <!-- Export buttons -->
            <div class="flex flex-wrap items-center gap-2 mb-4">
              <a :href="`/api/v1/projects/${projectId}/audits/${selectedAudit.pk_project_audit}/export/docx`"
                 class="flex items-center gap-1.5 px-3 py-1.5 text-xs font-geist rounded-lg border border-slate-200 dark:border-slate-600 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors">
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                Download DOCX
              </a>
              <a :href="`/api/v1/projects/${projectId}/audits/${selectedAudit.pk_project_audit}/export/md`"
                 class="flex items-center gap-1.5 px-3 py-1.5 text-xs font-geist rounded-lg border border-slate-200 dark:border-slate-600 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors">
                Download MD
              </a>
              <a :href="`/api/v1/projects/${projectId}/audits/${selectedAudit.pk_project_audit}/export/json`"
                 class="flex items-center gap-1.5 px-3 py-1.5 text-xs font-geist rounded-lg border border-slate-200 dark:border-slate-600 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors">
                Download JSON
              </a>
              <button
                @click="saveAuditToSharePoint(selectedAudit.pk_project_audit)"
                :disabled="savingToSharePoint"
                class="flex items-center gap-1.5 px-3 py-1.5 text-xs font-geist rounded-lg border border-sky-200 dark:border-sky-700 text-sky-600 dark:text-sky-400 hover:bg-sky-50 dark:hover:bg-sky-900/20 transition-colors disabled:opacity-50"
              >
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" /></svg>
                {{ savingToSharePoint ? 'Saving...' : 'Save to SharePoint' }}
              </button>
            </div>

            <!-- Git Analytics Dashboard -->
            <template v-if="selectedAudit.audit_source === 'git' && selectedAudit.audit_data">
              <!-- Summary cards -->
              <div class="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3 mb-6">
                <div class="bg-slate-50 rounded-xl p-3 text-center" v-if="selectedAudit.audit_data.meta">
                  <div class="text-[10px] font-geist text-slate-400 uppercase mb-1">Commits</div>
                  <div class="text-xl font-jakarta font-bold text-slate-900">{{ selectedAudit.audit_data.meta.totalCommitsProcessed || 0 }}</div>
                </div>
                <div class="bg-slate-50 rounded-xl p-3 text-center" v-if="selectedAudit.audit_data.projectHealth">
                  <div class="text-[10px] font-geist text-slate-400 uppercase mb-1">PRs</div>
                  <div class="text-xl font-jakarta font-bold text-slate-900">{{ selectedAudit.audit_data.projectHealth.totalPRs || 0 }}</div>
                </div>
                <div class="bg-slate-50 rounded-xl p-3 text-center" v-if="selectedAudit.audit_data.projectHealth">
                  <div class="text-[10px] font-geist text-slate-400 uppercase mb-1">Merged PRs</div>
                  <div class="text-xl font-jakarta font-bold text-emerald-600">{{ selectedAudit.audit_data.projectHealth.totalMergedPRs || 0 }}</div>
                </div>
                <div class="bg-slate-50 rounded-xl p-3 text-center" v-if="selectedAudit.audit_data.contributors">
                  <div class="text-[10px] font-geist text-slate-400 uppercase mb-1">Contributors</div>
                  <div class="text-xl font-jakarta font-bold text-indigo-600">{{ Object.keys(selectedAudit.audit_data.contributors).length }}</div>
                </div>
                <div class="bg-slate-50 rounded-xl p-3 text-center" v-if="selectedAudit.audit_data.projectHealth">
                  <div class="text-[10px] font-geist text-slate-400 uppercase mb-1">Branches</div>
                  <div class="text-xl font-jakarta font-bold text-slate-900">{{ selectedAudit.audit_data.projectHealth.totalBranches || 0 }}</div>
                </div>
                <div class="bg-slate-50 rounded-xl p-3 text-center" v-if="selectedAudit.audit_data.projectHealth?.avgCycleHours">
                  <div class="text-[10px] font-geist text-slate-400 uppercase mb-1">Avg PR Cycle</div>
                  <div class="text-xl font-jakarta font-bold text-slate-900">{{ Math.round(selectedAudit.audit_data.projectHealth.avgCycleHours) }}h</div>
                </div>
              </div>

              <!-- PR Type Distribution -->
              <div v-if="selectedAudit.audit_data.projectHealth?.prTypeDist" class="mb-6">
                <h3 class="text-sm font-jakarta font-bold text-slate-800 mb-3">PR Type Distribution</h3>
                <div class="flex flex-wrap gap-2">
                  <div v-for="(count, prType) in selectedAudit.audit_data.projectHealth.prTypeDist" :key="prType"
                    class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-geist"
                    :class="[
                      String(prType) === 'feature' ? 'bg-emerald-50 text-emerald-700' :
                      String(prType) === 'bug' ? 'bg-red-50 text-red-700' :
                      String(prType) === 'refactor' ? 'bg-blue-50 text-blue-700' :
                      String(prType) === 'docs' ? 'bg-purple-50 text-purple-700' :
                      'bg-slate-100 text-slate-600'
                    ]">
                    <span class="font-semibold">{{ count }}</span> {{ prType }}
                  </div>
                </div>
              </div>

              <!-- Contributors Table -->
              <div v-if="selectedAudit.audit_data.contributors" class="mb-6">
                <h3 class="text-sm font-jakarta font-bold text-slate-800 mb-3">Contributors ({{ Object.keys(selectedAudit.audit_data.contributors).length }})</h3>
                <div class="overflow-x-auto">
                  <table class="w-full text-left text-xs font-geist">
                    <thead class="bg-slate-50 border-b border-slate-200">
                      <tr class="text-[10px] text-slate-500 uppercase">
                        <th class="px-3 py-2">Contributor</th>
                        <th class="px-3 py-2 text-right">Score</th>
                        <th class="px-3 py-2 text-right">Commits</th>
                        <th class="px-3 py-2 text-right">+Lines</th>
                        <th class="px-3 py-2 text-right">-Lines</th>
                        <th class="px-3 py-2 text-right">PRs</th>
                        <th class="px-3 py-2 text-right">Reviews</th>
                        <th class="px-3 py-2 text-right">Msg Quality</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="(c, login) in selectedAudit.audit_data.contributors" :key="login" class="border-b border-slate-50 hover:bg-slate-50/50">
                        <td class="px-3 py-2">
                          <div class="flex items-center gap-2">
                            <img v-if="c.avatarUrl" :src="c.avatarUrl" class="w-5 h-5 rounded-full" />
                            <span class="font-medium text-slate-800">{{ c.displayName || login }}</span>
                          </div>
                        </td>
                        <td class="px-3 py-2 text-right">
                          <span class="font-semibold px-1.5 py-0.5 rounded text-[10px]" :class="(c.compositeScore || 0) >= 70 ? 'bg-emerald-50 text-emerald-700' : (c.compositeScore || 0) >= 40 ? 'bg-amber-50 text-amber-700' : 'bg-slate-100 text-slate-600'">{{ Math.round(c.compositeScore || 0) }}</span>
                        </td>
                        <td class="px-3 py-2 text-right text-slate-600">{{ c.commits?.length || 0 }}</td>
                        <td class="px-3 py-2 text-right text-emerald-600">+{{ (c.totalAdditions || 0).toLocaleString() }}</td>
                        <td class="px-3 py-2 text-right text-red-500">-{{ (c.totalDeletions || 0).toLocaleString() }}</td>
                        <td class="px-3 py-2 text-right text-slate-600">{{ c.totalPRsAuthored || 0 }}</td>
                        <td class="px-3 py-2 text-right text-slate-600">{{ c.totalPRsReviewed || 0 }}</td>
                        <td class="px-3 py-2 text-right text-slate-600">{{ Math.round(c.avgMsgQuality || 0) }}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>

              <!-- Velocity by Month -->
              <div v-if="velocityEntries(selectedAudit).length > 0" class="mb-6">
                <h3 class="text-sm font-jakarta font-bold text-slate-800 mb-3">Commit Velocity by Month</h3>
                <div class="bg-slate-50 rounded-xl p-4 overflow-x-auto">
                  <table style="width: 100%; border-collapse: collapse;">
                    <tr>
                      <td v-for="entry in velocityEntries(selectedAudit)" :key="'v'+entry.month"
                        style="vertical-align: bottom; text-align: center; padding: 0 2px;">
                        <div class="text-[8px] font-geist text-slate-500 mb-1">{{ entry.count }}</div>
                        <div class="mx-auto rounded-t-sm bg-indigo-400" style="width: 80%;"
                          :style="{ height: velocityBarPx(entry.count, selectedAudit.audit_data.projectHealth.velocityByMonth) }"></div>
                      </td>
                    </tr>
                    <tr>
                      <td v-for="entry in velocityEntries(selectedAudit)" :key="'m'+entry.month"
                        class="text-center text-[7px] font-geist text-slate-400 pt-1 border-t border-slate-200">
                        {{ entry.month.slice(-5) }}
                      </td>
                    </tr>
                  </table>
                </div>
              </div>
            </template>

            <!-- Deep Audit Dashboard -->
            <template v-if="selectedAudit.audit_source === 'deep-audit' && selectedAudit.audit_data?.scores">
              <!-- Score radar -->
              <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
                <div v-for="(score, key) in selectedAudit.audit_data.scores" :key="key" class="bg-slate-50 rounded-xl p-3 text-center">
                  <div class="text-[9px] font-geist text-slate-400 uppercase mb-1">{{ String(key).replace(/([A-Z])/g, ' $1').trim() }}</div>
                  <div class="text-xl font-jakarta font-bold" :class="Number(score) >= 70 ? 'text-emerald-600' : Number(score) >= 40 ? 'text-amber-600' : 'text-red-600'">{{ score }}</div>
                </div>
              </div>

              <!-- Summary -->
              <div v-if="selectedAudit.audit_data.summary" class="bg-slate-50 rounded-xl p-4 mb-4">
                <h3 class="text-sm font-jakarta font-bold text-slate-800 mb-2">Executive Summary</h3>
                <p class="text-xs font-geist text-slate-600 whitespace-pre-wrap">{{ selectedAudit.audit_data.summary }}</p>
              </div>

              <!-- Completeness Assessment -->
              <div v-if="selectedAudit.audit_data.completenessAssessment" class="bg-amber-50 rounded-xl p-4 mb-4">
                <h3 class="text-sm font-jakarta font-bold text-amber-800 mb-2">Completeness Assessment</h3>
                <p class="text-xs font-geist text-amber-700 whitespace-pre-wrap">{{ selectedAudit.audit_data.completenessAssessment }}</p>
              </div>

              <!-- Tech Stack -->
              <div v-if="selectedAudit.audit_data.techStack" class="mb-4">
                <h3 class="text-sm font-jakarta font-bold text-slate-800 mb-2">Technology Stack</h3>
                <div class="flex flex-wrap gap-2">
                  <span v-for="(pct, lang) in (selectedAudit.audit_data.techStack.languages || {})" :key="lang"
                    class="text-[10px] font-geist px-2 py-1 rounded-full bg-indigo-50 text-indigo-700">{{ lang }}: {{ pct }}%</span>
                  <span v-for="fw in (selectedAudit.audit_data.techStack.frameworks || [])" :key="fw"
                    class="text-[10px] font-geist px-2 py-1 rounded-full bg-emerald-50 text-emerald-700">{{ fw }}</span>
                </div>
              </div>

              <!-- Findings -->
              <div v-if="selectedAudit.audit_data.findings?.length" class="mb-4">
                <h3 class="text-sm font-jakarta font-bold text-slate-800 mb-2">Findings ({{ selectedAudit.audit_data.findings.length }})</h3>
                <div class="space-y-2">
                  <div v-for="(f, i) in selectedAudit.audit_data.findings" :key="i" class="bg-white rounded-lg border border-slate-100 p-3">
                    <div class="flex items-center gap-2 mb-1">
                      <span class="text-[9px] font-geist font-semibold px-1.5 py-0.5 rounded" :class="{
                        'bg-red-100 text-red-700': f.severity === 'critical',
                        'bg-amber-100 text-amber-700': f.severity === 'warning',
                        'bg-blue-100 text-blue-700': f.severity === 'info',
                      }">{{ f.severity }}</span>
                      <span class="text-[9px] font-geist text-slate-400">{{ f.category }}</span>
                      <span class="text-xs font-geist font-medium text-slate-800 flex-1">{{ f.title }}</span>
                    </div>
                    <p class="text-[11px] font-geist text-slate-600">{{ f.description }}</p>
                    <p v-if="f.evidence" class="text-[10px] font-geist text-slate-400 italic mt-1">{{ f.evidence }}</p>
                    <div v-if="f.files?.length" class="flex flex-wrap gap-1 mt-1">
                      <span v-for="file in f.files" :key="file" class="text-[9px] font-mono bg-slate-100 text-slate-500 px-1 rounded">{{ file }}</span>
                    </div>
                  </div>
                </div>
              </div>

              <!-- Recommendations -->
              <div v-if="selectedAudit.audit_data.recommendations" class="mb-4">
                <h3 class="text-sm font-jakarta font-bold text-slate-800 mb-2">Recommendations</h3>
                <div v-if="selectedAudit.audit_data.recommendations.mustFix?.length" class="mb-2">
                  <div class="text-[10px] font-geist font-semibold text-red-600 uppercase mb-1">Must Fix</div>
                  <ul class="space-y-0.5"><li v-for="(r, i) in selectedAudit.audit_data.recommendations.mustFix" :key="i" class="text-xs font-geist text-slate-700 flex items-start gap-1"><span class="text-red-400">&#x2022;</span> {{ r }}</li></ul>
                </div>
                <div v-if="selectedAudit.audit_data.recommendations.shouldFix?.length" class="mb-2">
                  <div class="text-[10px] font-geist font-semibold text-amber-600 uppercase mb-1">Should Fix</div>
                  <ul class="space-y-0.5"><li v-for="(r, i) in selectedAudit.audit_data.recommendations.shouldFix" :key="i" class="text-xs font-geist text-slate-700 flex items-start gap-1"><span class="text-amber-400">&#x2022;</span> {{ r }}</li></ul>
                </div>
                <div v-if="selectedAudit.audit_data.recommendations.niceToHave?.length">
                  <div class="text-[10px] font-geist font-semibold text-blue-600 uppercase mb-1">Nice to Have</div>
                  <ul class="space-y-0.5"><li v-for="(r, i) in selectedAudit.audit_data.recommendations.niceToHave" :key="i" class="text-xs font-geist text-slate-700 flex items-start gap-1"><span class="text-blue-400">&#x2022;</span> {{ r }}</li></ul>
                </div>
              </div>

              <!-- Stub Files -->
              <div v-if="selectedAudit.audit_data.stubFiles?.length" class="mb-4">
                <h3 class="text-sm font-jakarta font-bold text-slate-800 mb-2">Stub / Incomplete Files ({{ selectedAudit.audit_data.stubFiles.length }})</h3>
                <div class="text-[10px] font-mono text-slate-500 bg-slate-50 rounded-lg p-3 max-h-32 overflow-y-auto">
                  <div v-for="f in selectedAudit.audit_data.stubFiles" :key="f.path">{{ f.path }} ({{ f.size }}B)</div>
                </div>
              </div>

              <!-- Phases Summary -->
              <div v-if="selectedAudit.audit_data.phases" class="bg-slate-50 rounded-xl p-3">
                <h3 class="text-[10px] font-geist text-slate-400 uppercase mb-2">Audit Pipeline</h3>
                <div class="grid grid-cols-5 gap-2 text-center text-[9px] font-geist">
                  <div><div class="font-semibold text-slate-700">{{ selectedAudit.audit_data.phases.discovery?.filteredFiles || '?' }}</div>files scanned</div>
                  <div><div class="font-semibold text-slate-700">{{ selectedAudit.audit_data.phases.selection?.selectedFiles || '?' }}</div>AI selected</div>
                  <div><div class="font-semibold text-slate-700">{{ selectedAudit.audit_data.phases.loading?.loadedFiles || '?' }}</div>files loaded</div>
                  <div><div class="font-semibold text-slate-700">{{ selectedAudit.audit_data.phases.analysis?.batchesProcessed || '?' }}</div>LLM batches</div>
                  <div><div class="font-semibold text-emerald-600">&#x2713;</div>consolidated</div>
                </div>
              </div>
            </template>

            <!-- AI Analysis Section -->
            <div class="bg-indigo-50 dark:bg-indigo-950/20 rounded-xl p-4 mb-4">
              <div class="flex items-center justify-between mb-3">
                <h3 class="text-sm font-jakarta font-bold text-indigo-800 dark:text-indigo-300">
                  AI Analysis
                  <span v-if="selectedAudit.audit_ai_provider" class="text-[10px] font-geist font-normal text-indigo-500 ml-1">({{ selectedAudit.audit_ai_provider }} / {{ selectedAudit.audit_ai_model || 'default' }})</span>
                </h3>
              </div>

              <!-- Run AI Analysis controls -->
              <div class="flex items-center gap-3 mb-4">
                <Select v-model="aiProvider" :options="[
                  { label: 'Claude (Anthropic)', value: 'claude' },
                  { label: 'Gemini (Google)', value: 'gemini' },
                  { label: 'Grok (xAI)', value: 'grok' },
                ]" option-label="label" option-value="value" class="w-44" size="small" />
                <Select v-model="aiModel" :options="aiProvider === 'claude' ? [
                  { label: 'Claude Sonnet 4', value: 'claude-sonnet-4-20250514' },
                  { label: 'Claude Opus 4', value: 'claude-opus-4-20250514' },
                ] : aiProvider === 'gemini' ? [
                  { label: 'Gemini 2.0 Flash', value: 'gemini-2.0-flash' },
                  { label: 'Gemini 2.5 Pro', value: 'gemini-2.5-pro-preview-03-25' },
                ] : [
                  { label: 'Grok 3 Mini', value: 'grok-3-mini-fast' },
                  { label: 'Grok 3', value: 'grok-3' },
                ]" option-label="label" option-value="value" class="w-48" size="small" />
                <Button size="small" :loading="aiAnalysisRunning" @click="runAiAnalysis" :label="selectedAudit.audit_ai_analysis ? 'Re-run Analysis' : 'Run AI Analysis'" />
              </div>

              <div v-if="aiAnalysisRunning" class="text-center py-6 text-xs font-geist text-indigo-500">
                <div class="animate-pulse">Running AI analysis... This may take 30-60 seconds.</div>
              </div>

              <!-- AI Results -->
              <template v-if="selectedAudit.audit_ai_analysis && !aiAnalysisRunning">
                <div class="grid grid-cols-2 gap-3 mb-3">
                  <div class="bg-white dark:bg-slate-800 rounded-lg p-3 text-center">
                    <div class="text-[10px] text-slate-400 uppercase mb-1">Overall Score</div>
                    <div class="text-2xl font-jakarta font-bold" :class="selectedAudit.audit_ai_analysis.overallScore >= 70 ? 'text-emerald-600' : selectedAudit.audit_ai_analysis.overallScore >= 40 ? 'text-amber-600' : 'text-red-600'">{{ selectedAudit.audit_ai_analysis.overallScore }}<span class="text-sm text-slate-400">/100</span></div>
                  </div>
                  <div class="bg-white dark:bg-slate-800 rounded-lg p-3 text-center">
                    <div class="text-[10px] text-slate-400 uppercase mb-1">Completion Estimate</div>
                    <div class="text-2xl font-jakarta font-bold text-indigo-600">{{ selectedAudit.audit_ai_analysis.completionEstimate }}<span class="text-sm text-slate-400">%</span></div>
                  </div>
                </div>

                <div class="bg-white dark:bg-slate-800 rounded-lg p-3 mb-3">
                  <div class="text-[10px] font-geist text-slate-400 uppercase mb-1">Summary</div>
                  <p class="text-xs font-geist text-slate-700 dark:text-slate-300">{{ selectedAudit.audit_ai_analysis.summary }}</p>
                </div>

                <div v-if="selectedAudit.audit_ai_analysis.findings?.length" class="mb-3">
                  <div class="text-[10px] font-geist text-slate-400 uppercase mb-2">Findings ({{ selectedAudit.audit_ai_analysis.findings.length }})</div>
                  <div class="space-y-2">
                    <div v-for="(f, i) in selectedAudit.audit_ai_analysis.findings" :key="i" class="bg-white dark:bg-slate-800 rounded-lg p-3">
                      <div class="flex items-center gap-2 mb-1">
                        <span class="px-1.5 py-0.5 rounded text-[9px] font-geist font-semibold" :class="{
                          'bg-red-100 text-red-700': f.severity === 'critical',
                          'bg-amber-100 text-amber-700': f.severity === 'warning',
                          'bg-blue-100 text-blue-700': f.severity === 'info',
                        }">{{ f.severity }}</span>
                        <span class="text-[10px] font-geist text-slate-400">{{ f.category }}</span>
                      </div>
                      <p class="text-xs font-geist text-slate-700 dark:text-slate-300">{{ f.description }}</p>
                      <p v-if="f.evidence" class="text-[10px] font-geist text-slate-400 mt-1 italic">{{ f.evidence }}</p>
                    </div>
                  </div>
                </div>

                <div v-if="selectedAudit.audit_ai_analysis.recommendations?.length">
                  <div class="text-[10px] font-geist text-slate-400 uppercase mb-2">Recommendations</div>
                  <ul class="space-y-1">
                    <li v-for="(r, i) in selectedAudit.audit_ai_analysis.recommendations" :key="i" class="flex items-start gap-2 text-xs font-geist text-slate-700 dark:text-slate-300">
                      <span class="text-indigo-500 mt-0.5">•</span> {{ r }}
                    </li>
                  </ul>
                </div>
              </template>

              <div v-if="!selectedAudit.audit_ai_analysis && !aiAnalysisRunning" class="text-center py-4 text-xs font-geist text-indigo-400 border border-dashed border-indigo-200 dark:border-indigo-800 rounded-lg">
                No AI analysis yet. Select a provider and click "Run AI Analysis" to get project insights.
              </div>
            </div>

            <!-- Raw JSON fallback for non-git audits -->
            <div v-if="selectedAudit.audit_source !== 'git' && selectedAudit.audit_data" class="bg-slate-50 rounded-xl p-4">
              <h3 class="text-sm font-jakarta font-bold text-slate-800 mb-2">Audit Data</h3>
              <pre class="text-[10px] font-mono text-slate-600 overflow-x-auto max-h-96 whitespace-pre-wrap">{{ JSON.stringify(selectedAudit.audit_data, null, 2) }}</pre>
            </div>
          </template>
        </template>
      </Dialog>

      <!-- ── Versions panel (only renders when cluster has 2+ versions) ─ -->
      <div class="mt-6">
        <VersionsPanel :project-id="projectId" />
      </div>

      <!-- ── Members panel (always visible when project loaded) ──────── -->
      <div class="mt-6">
        <ProjectMembersPanel :project-id="projectId" />
      </div>

      <!-- ── Clone dialog ────────────────────────────────────────────── -->
      <CloneProjectDialog
        v-if="p"
        :project-id="projectId"
        :project-name="p.project_name"
        :visible="showCloneDialog"
        @update:visible="showCloneDialog = $event"
      />

      <!-- ── Lock-acquire dialog ─────────────────────────────────────── -->
      <Dialog v-model:visible="showLockDialog" header="Lock for focused work" :modal="true" :style="{ width: '460px' }">
        <p class="text-xs text-slate-500 mb-3">
          While locked, only you (and admins) can mutate this project, its modules, and its velocity board.
          Other members become read-only until you release the lock.
        </p>
        <label class="block text-xs text-slate-600 dark:text-slate-300 mb-1">Reason (optional)</label>
        <Textarea v-model="lockReasonDraft" rows="2" class="w-full" placeholder="e.g. running deep audit; do not modify" />
        <template #footer>
          <Button severity="secondary" outlined @click="showLockDialog = false">Cancel</Button>
          <Button severity="danger" @click="acquireLock">
            <Lock class="w-3.5 h-3.5 mr-1" /> Acquire lock
          </Button>
        </template>
      </Dialog>

      <!-- ── Clone-policy dialog (admin only) ───────────────────────── -->
      <Dialog
        v-model:visible="showClonePolicyDialog"
        :header="(p as any)?.project_clone_disabled ? 'Re-enable cloning' : 'Disable cloning'"
        :modal="true"
        :style="{ width: '480px' }"
      >
        <p class="text-xs text-slate-500 mb-4">
          <span v-if="!(p as any)?.project_clone_disabled">
            New clones will be blocked with a <code class="text-[10px]">403 CLONE_DISABLED</code> error,
            including for admins. Existing clones are unaffected. You can re-enable any time.
          </span>
          <span v-else>
            Anyone with <strong>runner+</strong> role will be able to clone this project again.
          </span>
        </p>

        <template v-if="!(p as any)?.project_clone_disabled">
          <label class="block text-xs text-slate-600 dark:text-slate-300 mb-1">Reason (optional)</label>
          <Textarea
            v-model="clonePolicyReasonDraft"
            rows="3"
            class="w-full"
            placeholder="e.g. gold-standard reference, do not fork"
          />
        </template>

        <template #footer>
          <Button severity="secondary" outlined :disabled="clonePolicySaving" @click="showClonePolicyDialog = false">
            Cancel
          </Button>
          <Button
            :severity="(p as any)?.project_clone_disabled ? 'success' : 'warning'"
            :loading="clonePolicySaving"
            @click="confirmClonePolicy"
          >
            {{ (p as any)?.project_clone_disabled ? 'Re-enable' : 'Disable' }}
          </Button>
        </template>
      </Dialog>
    </div>
  </div>
</template>
