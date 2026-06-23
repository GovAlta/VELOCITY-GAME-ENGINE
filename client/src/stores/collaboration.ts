import { defineStore } from 'pinia'
import { ref } from 'vue'
import api from '@/lib/api'

export type MemberRole = 'owner' | 'collaborator'

export interface ProjectMember {
  pk_project_member: string
  fk_pm_project: string
  fk_pm_user: string
  member_role: MemberRole
  added_by: string | null
  added_at: string
  removed_at: string | null
  is_active: boolean
  user_email_address: string
  user_display_name: string
  avatar_url: string | null
}

export interface ProjectPermissions {
  projectId: string
  isOpen: boolean
  isClaimed: boolean
  isLocked: boolean
  lockedBy: string | null
  isMember: boolean
  isOwner: boolean
  isAdmin: boolean
  cloneDisabled: boolean
  canRead: boolean
  canWriteProject: boolean
  canMakeVelocityMoves: boolean
  canManageMembers: boolean
  canRename: boolean
  canToggleLock: boolean
  canTogglePolicy: boolean
  canClone: boolean
}

export interface VersionRow {
  pk_project: string
  project_name: string
  project_code: string | null
  project_version_label: string | null
  project_status: string | null
  project_percent_complete: number | null
  project_is_locked: boolean
  project_locked_by: string | null
  fk_project_parent: string | null
  project_cloned_at: string | null
  project_cloned_by: string | null
  active_member_count: number
  primary_owner_email: string | null
  primary_owner_name: string | null
}

export interface Cluster {
  parent: VersionRow | null
  versions: VersionRow[]
}

export const useCollaborationStore = defineStore('collaboration', () => {
  // Per-project caches keyed by projectId
  const members = ref<Record<string, ProjectMember[]>>({})
  const permissions = ref<Record<string, ProjectPermissions>>({})
  const clusters = ref<Record<string, Cluster>>({})
  const loading = ref(false)
  const lastError = ref<string | null>(null)

  function clear(projectId: string) {
    delete members.value[projectId]
    delete permissions.value[projectId]
    delete clusters.value[projectId]
  }

  // ─── Permissions ─────────────────────────────────────────

  async function fetchPermissions(projectId: string): Promise<ProjectPermissions | null> {
    try {
      const r = await api.get(`/projects/${projectId}/permissions`)
      const p = r.data?.data as ProjectPermissions
      permissions.value[projectId] = p
      return p
    } catch (err: any) {
      lastError.value = err?.response?.data?.error?.message || err.message
      return null
    }
  }

  // ─── Members ─────────────────────────────────────────────

  async function fetchMembers(projectId: string): Promise<ProjectMember[]> {
    const r = await api.get(`/projects/${projectId}/members`)
    members.value[projectId] = r.data?.data || []
    return members.value[projectId]
  }

  async function addMember(projectId: string, userId: string, role: MemberRole = 'collaborator') {
    const r = await api.post(`/projects/${projectId}/members`, { userId, role })
    await fetchMembers(projectId)
    await fetchPermissions(projectId)
    return r.data?.data
  }

  async function removeMember(projectId: string, membershipId: string) {
    await api.delete(`/projects/${projectId}/members/${membershipId}`)
    await fetchMembers(projectId)
    await fetchPermissions(projectId)
  }

  async function changeRole(projectId: string, membershipId: string, role: MemberRole) {
    const r = await api.patch(`/projects/${projectId}/members/${membershipId}`, { role })
    await fetchMembers(projectId)
    await fetchPermissions(projectId)
    return r.data?.data
  }

  async function transferOwnership(projectId: string, toUserId: string) {
    await api.post(`/projects/${projectId}/transfer-ownership`, { toUserId })
    await fetchMembers(projectId)
    await fetchPermissions(projectId)
  }

  // ─── Lock ────────────────────────────────────────────────

  async function lockProject(projectId: string, reason?: string) {
    const r = await api.post(`/projects/${projectId}/lock`, { reason })
    await fetchPermissions(projectId)
    return r.data?.data
  }

  async function unlockProject(projectId: string, force = false) {
    await api.post(`/projects/${projectId}/unlock`, { force })
    await fetchPermissions(projectId)
  }

  // ─── Clone ───────────────────────────────────────────────

  async function cloneProject(
    sourceId: string,
    options: { versionLabel?: string | null; copyLinks?: boolean; copyBudgets?: boolean } = {},
  ) {
    const r = await api.post(`/projects/${sourceId}/clone`, options)
    return r.data?.data as { pk_project: string; project_code: string | null; project_name: string }
  }

  async function fetchCluster(projectId: string): Promise<Cluster> {
    const r = await api.get(`/projects/${projectId}/cluster`)
    const c = r.data?.data as Cluster
    clusters.value[projectId] = c
    return c
  }

  // ─── Version label ───────────────────────────────────────

  async function renameVersion(projectId: string, label: string | null) {
    const r = await api.put(`/projects/${projectId}/version-label`, { label })
    return r.data?.data
  }

  // ─── Clone policy (admin) ────────────────────────────────

  async function setClonePolicy(projectId: string, disabled: boolean, reason?: string | null) {
    const r = await api.patch(`/projects/${projectId}/clone-policy`, {
      disabled,
      reason: reason ?? null,
    })
    await fetchPermissions(projectId)
    return r.data?.data
  }

  return {
    members, permissions, clusters, loading, lastError,
    clear,
    fetchPermissions,
    fetchMembers, addMember, removeMember, changeRole, transferOwnership,
    lockProject, unlockProject,
    cloneProject, fetchCluster,
    renameVersion,
    setClonePolicy,
  }
})
