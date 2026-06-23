import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import api from '@/lib/api'

export const ROLE_HIERARCHY = ['guest', 'viewer', 'user', 'editor', 'manager', 'admin', 'super_admin'] as const
export type Role = typeof ROLE_HIERARCHY[number]

export interface User {
  id: string
  email: string
  name: string
  role: Role
  roles?: string[]
  avatarUrl?: string
}

export const useAuthStore = defineStore('auth', () => {
  const user = ref<User | null>(null)
  const loading = ref(false)
  const initialized = ref(false)

  const isAuthenticated = computed(() => !!user.value)

  function hasMinRole(minRole: Role): boolean {
    if (!user.value) return false
    return ROLE_HIERARCHY.indexOf(user.value.role) >= ROLE_HIERARCHY.indexOf(minRole)
  }

  const isAdmin = computed(() => hasMinRole('admin'))
  const isManager = computed(() => hasMinRole('manager'))
  const isEditor = computed(() => hasMinRole('editor'))

  async function fetchUser(): Promise<void> {
    loading.value = true
    try {
      // Use fetch() instead of axios to avoid browser console errors
      // when the backend is unavailable (XHR logs all non-2xx as errors)
      const res = await fetch('/api/v1/auth/me', { credentials: 'include' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      // Server returns { success: true, data: { id, email, displayName, role, avatarUrl } }
      const d = json?.data || json
      if (d?.id || d?.email) {
        user.value = {
          id: d.id || d.pk_user_account,
          email: d.email || d.user_email_address,
          name: d.displayName || d.user_display_name || d.name || '',
          role: d.role || d.user_role_name || 'user',
          roles: d.roles || [d.role || d.user_role_name || 'user'],
          avatarUrl: d.avatarUrl || d.avatar_url || undefined,
        }
      } else {
        user.value = null
      }
    } catch {
      user.value = null
    } finally {
      loading.value = false
      initialized.value = true
    }
  }

  async function login(provider: 'google' | 'microsoft'): Promise<void> {
    window.location.href = `/api/v1/auth/${provider}`
  }

  async function loginWithCredentials(email: string, password: string): Promise<void> {
    loading.value = true
    try {
      const { data } = await api.post<User>('/auth/login', { email, password })
      user.value = data
      initialized.value = true
    } finally {
      loading.value = false
    }
  }

  async function register(name: string, email: string, password: string): Promise<void> {
    loading.value = true
    try {
      const { data } = await api.post<User>('/auth/register', { name, email, password })
      user.value = data
      initialized.value = true
    } finally {
      loading.value = false
    }
  }

  async function logout(): Promise<void> {
    try {
      await api.post('/auth/logout')
    } finally {
      user.value = null
    }
  }

  // Listen for token expiry events from API interceptor
  if (typeof window !== 'undefined') {
    window.addEventListener('auth:expired', () => {
      user.value = null
    })
  }

  // Idle session timeout (ASVS V3.3.1)
  const IDLE_TIMEOUT_MS = 30 * 60 * 1000 // 30 minutes
  let idleTimer: ReturnType<typeof setTimeout> | null = null

  function resetIdleTimer(): void {
    if (idleTimer) clearTimeout(idleTimer)
    if (!user.value) return
    idleTimer = setTimeout(() => {
      logout()
      window.location.href = '/login?reason=timeout'
    }, IDLE_TIMEOUT_MS)
  }

  function startIdleTracking(): void {
    const events = ['mousedown', 'keydown', 'touchstart', 'scroll'] as const
    events.forEach((evt) => window.addEventListener(evt, resetIdleTimer, { passive: true }))
    resetIdleTimer()
  }

  function stopIdleTracking(): void {
    const events = ['mousedown', 'keydown', 'touchstart', 'scroll'] as const
    events.forEach((evt) => window.removeEventListener(evt, resetIdleTimer))
    if (idleTimer) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
  }

  if (typeof window !== 'undefined') {
    watch(isAuthenticated, (authed) => {
      if (authed) startIdleTracking()
      else stopIdleTracking()
    })
  }

  return {
    user, loading, initialized,
    isAuthenticated, isAdmin, isManager, isEditor,
    hasMinRole,
    fetchUser, login, loginWithCredentials, register, logout, resetIdleTimer,
  }
})
