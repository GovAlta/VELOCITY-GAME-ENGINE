import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import api from '@/lib/api'

export interface ProjectRecord {
  id: string
  projectCode: string | null
  name: string
  description: string
  ministryCode: string
  ministryName: string
  ministryMatchConfidence: number
  ministryRaw: string
  startDate: string | null
  endDate: string | null
  goLiveDateType: string | null
  status: string
  percentComplete: number | null
  priority: string
  budget: number | null
  spent: number | null
  scope: string
  category: string
  demandNumber: string
  ministryPriority: number | null
  risk: string
  additionalInfo: string
  branch: string
  projectLead: string
  teamMembers: string
  source: string
  _sourceSheet: string
  modules: string[]
  requirements: string[]
  repos: string[]
  documents: string[]
  phase: string
  potentialDuplicateOf?: string[]
  isDuplicate?: boolean
  duplicateOf?: string
  isMissionCritical?: boolean
  // Lineage (v5.0)
  fkProjectParent: string | null
  projectVersionLabel: string | null
  projectClonedFromName: string | null
  projectIsLocked: boolean
  projectCloneDisabled: boolean
}

export interface Ministry {
  shortName: string
  name: string
}

export interface DuplicatePair {
  project1: { id: string; name: string; source: string }
  project2: { id: string; name: string; source: string }
  similarity: number
  isExactMatch: boolean
}

const PHASE_ORDER = [
  'discovery',
  'requirements',
  'development',
  'testing',
  'clientReview',
  'clientAcceptance',
  'completion',
  'onHold',
  'cancelled',
] as const

const PHASE_LABELS: Record<string, string> = {
  discovery: 'Discovery',
  requirements: 'Requirements',
  development: 'Development',
  testing: 'Testing',
  clientReview: 'Client Review',
  clientAcceptance: 'Client Acceptance',
  completion: 'Completed',
  onHold: 'On Hold',
  cancelled: 'Cancelled',
}

const PHASE_COLORS: Record<string, string> = {
  discovery: '#8b5cf6',
  requirements: '#6366f1',
  development: '#0891b2',
  testing: '#f59e0b',
  clientReview: '#f97316',
  clientAcceptance: '#10b981',
  completion: '#059669',
  onHold: '#94a3b8',
  cancelled: '#ef4444',
}

export type RiskLevel = 'on-track' | 'at-risk' | 'behind' | 'critical' | 'past-due' | 'completed' | 'no-data'

export interface RiskInfo {
  level: RiskLevel
  label: string
  expectedPct: number | null
  actualPct: number | null
  gap: number | null
  daysRemaining: number | null
  velocityRatio: number | null
  reason: string
}

const RISK_COLORS: Record<RiskLevel, string> = {
  'completed': '#059669',
  'on-track': '#10b981',
  'at-risk': '#f59e0b',
  'behind': '#f97316',
  'critical': '#dc2626',
  'past-due': '#991b1b',
  'no-data': '#94a3b8',
}

const RISK_LABELS: Record<RiskLevel, string> = {
  'completed': 'Completed',
  'on-track': 'On Track',
  'at-risk': 'At Risk',
  'behind': 'Behind',
  'critical': 'Critical',
  'past-due': 'Past Due',
  'no-data': 'No Data',
}

export { PHASE_ORDER, PHASE_LABELS, PHASE_COLORS, RISK_COLORS, RISK_LABELS }

/**
 * Assess delivery risk for a project based on timeline vs % complete.
 */
export function assessRisk(p: ProjectRecord, today?: string): RiskInfo {
  const todayStr = today || new Date().toISOString().split('T')[0]

  if (p.phase === 'completion' || p.percentComplete === 100) {
    return { level: 'completed', label: 'Completed', expectedPct: 100, actualPct: p.percentComplete ?? 100, gap: 0, daysRemaining: 0, velocityRatio: null, reason: 'Project completed.' }
  }

  if (!p.startDate || !p.endDate) {
    return { level: 'no-data', label: 'No Data', expectedPct: null, actualPct: p.percentComplete, gap: null, daysRemaining: null, velocityRatio: null, reason: 'Missing start or end date.' }
  }

  const startMs = new Date(p.startDate).getTime()
  const endMs = new Date(p.endDate).getTime()
  const todayMs = new Date(todayStr).getTime()
  const totalDuration = endMs - startMs
  const elapsed = todayMs - startMs
  const remaining = endMs - todayMs
  const daysRemaining = Math.ceil(remaining / (1000 * 60 * 60 * 24))

  const timeRatio = totalDuration > 0 ? Math.max(0, Math.min(elapsed / totalDuration, 1)) : 1
  const expectedPct = Math.round(timeRatio * 100)
  const actualPct = p.percentComplete ?? 0

  if (p.percentComplete === null) {
    if (daysRemaining < 0) {
      return { level: 'past-due', label: 'Past Due', expectedPct, actualPct: null, gap: null, daysRemaining, velocityRatio: null, reason: `Due ${Math.abs(daysRemaining)} days ago, no completion data.` }
    }
    return { level: 'no-data', label: 'No Data', expectedPct, actualPct: null, gap: null, daysRemaining, velocityRatio: null, reason: 'No percent complete reported.' }
  }

  if (daysRemaining < 0) {
    return { level: 'past-due', label: 'Past Due', expectedPct: 100, actualPct, gap: 100 - actualPct, daysRemaining, velocityRatio: null, reason: `Due ${Math.abs(daysRemaining)} days ago at ${actualPct}%.` }
  }

  const gap = expectedPct - actualPct
  const pctRemaining = 100 - actualPct
  const daysElapsed = Math.max(1, Math.ceil(elapsed / (1000 * 60 * 60 * 24)))
  const currentVelocity = actualPct / daysElapsed
  const neededVelocity = daysRemaining > 0 ? pctRemaining / daysRemaining : Infinity
  const velocityRatio = currentVelocity > 0 ? Math.round((neededVelocity / currentVelocity) * 100) / 100 : (pctRemaining > 0 ? Infinity : 1)

  if (gap <= 5 && velocityRatio <= 1.2) {
    return { level: 'on-track', label: 'On Track', expectedPct, actualPct, gap, daysRemaining, velocityRatio, reason: `${actualPct}% vs ${expectedPct}% expected.` }
  }
  if (gap <= 20 && velocityRatio <= 2) {
    return { level: 'at-risk', label: 'At Risk', expectedPct, actualPct, gap, daysRemaining, velocityRatio, reason: `${actualPct}% vs ${expectedPct}% expected. Needs ${velocityRatio}x velocity.` }
  }
  if (gap <= 40 && velocityRatio <= 4) {
    return { level: 'behind', label: 'Behind', expectedPct, actualPct, gap, daysRemaining, velocityRatio, reason: `${actualPct}% vs ${expectedPct}% expected. Needs ${velocityRatio}x velocity.` }
  }
  return { level: 'critical', label: 'Critical', expectedPct, actualPct, gap, daysRemaining, velocityRatio: velocityRatio === Infinity ? null : velocityRatio, reason: `${actualPct}% vs ${expectedPct}% expected. Severe delivery risk.` }
}

function mapDbStatusToPhase(status: string): string {
  const map: Record<string, string> = {
    'discovery': 'discovery',
    'requirements': 'requirements',
    'development': 'development',
    'testing': 'testing',
    'client_review': 'clientReview',
    'client_acceptance': 'clientAcceptance',
    'completion': 'completion',
    'on_hold': 'onHold',
    'cancelled': 'cancelled',
  }
  return map[status] || status
}

export const useProjectStore = defineStore('projects', () => {
  const allProjects = ref<ProjectRecord[]>([])
  const ministries = ref<Ministry[]>([])
  const duplicates = ref<DuplicatePair[]>([])
  const metadata = ref<Record<string, unknown>>({})
  const apiAvailable = ref(false)
  const loading = ref(false)

  /**
   * Load projects from API (database).
   *
   * Ministries load INDEPENDENTLY of projects so an empty project list (e.g.
   * fresh database) still populates the ministry dropdown used by the
   * "create project" dialog.
   */
  async function loadFromApi(): Promise<void> {
    loading.value = true
    // Always attempt ministries — independent of whether projects exist.
    try {
      const mRes = await api.get('/ministries')
      if (mRes.data?.success && Array.isArray(mRes.data.data)) {
        ministries.value = mRes.data.data.map((m: Record<string, unknown>) => ({
          shortName: m.ministry_code,
          name: m.ministry_name,
        }))
      }
    } catch { /* ministries fetch failure shouldn't block project load */ }

    try {
      const res = await api.get('/projects', { params: { limit: 500 } })
      if (res.data?.success) {
        allProjects.value = (res.data.data || []).map((p: Record<string, unknown>) => ({
          id: p.pk_project,
          projectCode: p.project_code || null,
          name: p.project_name,
          description: p.project_description || '',
          ministryCode: p.ministry_code || '',
          ministryName: p.ministry_name || '',
          ministryMatchConfidence: 1,
          ministryRaw: '',
          startDate: p.project_start_date ? String(p.project_start_date).split('T')[0] : null,
          endDate: p.project_end_date ? String(p.project_end_date).split('T')[0] : null,
          goLiveDateType: p.project_go_live_date_type,
          status: p.project_status || '',
          percentComplete: p.project_percent_complete,
          priority: p.project_priority || '',
          budget: null,
          spent: null,
          scope: p.project_scope || '',
          category: p.project_category || '',
          demandNumber: p.project_demand_number || '',
          ministryPriority: p.project_ministry_priority,
          risk: p.project_risk || '',
          additionalInfo: p.project_additional_info || '',
          branch: p.project_branch || '',
          projectLead: (p.lead_names as string) || (p.primary_lead as string) || '',
          teamMembers: '',
          source: p.project_source || '',
          _sourceSheet: p.project_source_sheet || '',
          modules: [],
          requirements: [],
          repos: [],
          documents: [],
          phase: mapDbStatusToPhase(String(p.project_status || 'discovery')),
          potentialDuplicateOf: undefined,
          isDuplicate: p.project_is_duplicate as boolean,
          duplicateOf: undefined,
          isMissionCritical: p.project_is_mission_critical as boolean,
          fkProjectParent: (p.fk_project_parent as string | null) ?? null,
          projectVersionLabel: (p.project_version_label as string | null) ?? null,
          projectClonedFromName: (p.project_cloned_from_name as string | null) ?? null,
          projectIsLocked: !!p.project_is_locked,
          projectCloneDisabled: !!p.project_clone_disabled,
        }))
        apiAvailable.value = true
      }
    } catch {
      apiAvailable.value = false
    } finally {
      loading.value = false
    }
  }

  // Auto-load from API on store creation
  loadFromApi()

  // Filters
  const searchQuery = ref('')
  const selectedMinistries = ref<string[]>([])
  const selectedPhases = ref<string[]>([])
  const selectedSources = ref<string[]>([])
  const showDuplicates = ref(true)
  const selectedGoLiveDateType = ref<string[]>([])
  const missionCriticalOnly = ref(false)

  // Computed: unique values for filters
  const uniqueMinistries = computed(() => {
    const map = new Map<string, { code: string; name: string; count: number }>()
    for (const p of allProjects.value) {
      const existing = map.get(p.ministryCode)
      if (existing) {
        existing.count++
      } else {
        map.set(p.ministryCode, { code: p.ministryCode, name: p.ministryName, count: 1 })
      }
    }
    return [...map.values()].sort((a, b) => b.count - a.count)
  })

  const uniqueSources = computed(() => {
    const set = new Set<string>()
    allProjects.value.forEach(p => set.add(p.source))
    return [...set].sort()
  })

  const uniqueGoLiveDateTypes = computed(() => {
    const set = new Set<string>()
    allProjects.value.forEach(p => {
      if (p.goLiveDateType) set.add(p.goLiveDateType)
    })
    return [...set].sort()
  })

  // Filtered projects
  const filteredProjects = computed(() => {
    let result = allProjects.value

    // Hide duplicates if toggle is off
    if (!showDuplicates.value) {
      result = result.filter(p => !p.isDuplicate)
    }

    // Search
    if (searchQuery.value) {
      const q = searchQuery.value.toLowerCase()
      result = result.filter(p =>
        p.name.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q) ||
        p.ministryName.toLowerCase().includes(q) ||
        p.ministryCode.toLowerCase().includes(q) ||
        p.demandNumber.toLowerCase().includes(q) ||
        p.projectLead.toLowerCase().includes(q)
      )
    }

    // Ministry filter
    if (selectedMinistries.value.length > 0) {
      result = result.filter(p => selectedMinistries.value.includes(p.ministryCode))
    }

    // Phase filter
    if (selectedPhases.value.length > 0) {
      result = result.filter(p => selectedPhases.value.includes(p.phase))
    }

    // Source filter
    if (selectedSources.value.length > 0) {
      result = result.filter(p => selectedSources.value.includes(p.source))
    }

    // Go-live date type filter
    if (selectedGoLiveDateType.value.length > 0) {
      result = result.filter(p => p.goLiveDateType && selectedGoLiveDateType.value.includes(p.goLiveDateType))
    }

    // Mission critical filter
    if (missionCriticalOnly.value) {
      result = result.filter(p => p.isMissionCritical)
    }

    return result
  })

  // Stats
  const stats = computed(() => {
    const total = filteredProjects.value.length
    const withDates = filteredProjects.value.filter(p => p.startDate && p.endDate).length
    const byPhase: Record<string, number> = {}
    const byMinistry: Record<string, number> = {}
    let totalBudget = 0
    let totalSpent = 0
    let completedCount = 0

    for (const p of filteredProjects.value) {
      byPhase[p.phase] = (byPhase[p.phase] || 0) + 1
      byMinistry[p.ministryCode] = (byMinistry[p.ministryCode] || 0) + 1
      if (p.budget) totalBudget += p.budget
      if (p.spent) totalSpent += p.spent
      if (p.phase === 'completion') completedCount++
    }

    const avgCompletion = filteredProjects.value.reduce((sum, p) => sum + (p.percentComplete || 0), 0) / (total || 1)

    return { total, withDates, byPhase, byMinistry, totalBudget, totalSpent, completedCount, avgCompletion }
  })

  function getProjectById(id: string): ProjectRecord | undefined {
    return allProjects.value.find(p => p.id === id)
  }

  function clearFilters(): void {
    searchQuery.value = ''
    selectedMinistries.value = []
    selectedPhases.value = []
    selectedSources.value = []
    selectedGoLiveDateType.value = []
    missionCriticalOnly.value = false
  }

  return {
    allProjects,
    ministries,
    duplicates,
    metadata,
    apiAvailable,
    loading,
    searchQuery,
    selectedMinistries,
    selectedPhases,
    selectedSources,
    selectedGoLiveDateType,
    showDuplicates,
    missionCriticalOnly,
    filteredProjects,
    uniqueMinistries,
    uniqueSources,
    uniqueGoLiveDateTypes,
    stats,
    getProjectById,
    clearFilters,
    loadFromApi,
    PHASE_ORDER,
    PHASE_LABELS,
    PHASE_COLORS,
  }
})
