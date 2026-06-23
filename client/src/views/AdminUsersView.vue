<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import api from '@/lib/api'
import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import { Users, Shield, ShieldCheck, Play, User, Trash2, Check, X, RefreshCw } from 'lucide-vue-next'

interface UserRecord {
  pk_user_account: string
  user_email_address: string
  user_display_name: string
  user_role_name: string
  roles: string[]
  is_active: boolean
  last_login_at: string | null
  created_at: string
  sso_provider_name: string
  avatar_url: string | null
}

const ALL_ROLES = ['user', 'project_lead', 'runner', 'admin'] as const
const ROLE_LABELS: Record<string, { label: string; color: string; icon: any }> = {
  user: { label: 'User', color: 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300', icon: User },
  project_lead: { label: 'Project Lead', color: 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300', icon: ShieldCheck },
  runner: { label: 'Runner', color: 'bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300', icon: Play },
  admin: { label: 'Admin', color: 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300', icon: Shield },
}

const users = ref<UserRecord[]>([])
const loading = ref(true)
const searchQuery = ref('')
const selectedUser = ref<UserRecord | null>(null)
const roleDialogVisible = ref(false)
const saving = ref(false)

const filteredUsers = computed(() => {
  if (!searchQuery.value) return users.value
  const q = searchQuery.value.toLowerCase()
  return users.value.filter(u =>
    u.user_email_address.toLowerCase().includes(q) ||
    u.user_display_name.toLowerCase().includes(q) ||
    u.roles.some(r => r.includes(q))
  )
})

async function fetchUsers() {
  loading.value = true
  try {
    const res = await api.get('/users')
    users.value = res.data?.data || []
  } catch (e: any) {
    console.error('Failed to load users', e)
  } finally {
    loading.value = false
  }
}

function openRoleDialog(user: UserRecord) {
  selectedUser.value = { ...user, roles: [...user.roles] }
  roleDialogVisible.value = true
}

async function toggleRole(role: string) {
  if (!selectedUser.value) return
  saving.value = true
  try {
    if (selectedUser.value.roles.includes(role)) {
      await api.delete(`/users/${selectedUser.value.pk_user_account}/roles/${role}`)
      selectedUser.value.roles = selectedUser.value.roles.filter(r => r !== role)
    } else {
      await api.post(`/users/${selectedUser.value.pk_user_account}/roles`, { role })
      selectedUser.value.roles.push(role)
    }
    // Update the main list
    const idx = users.value.findIndex(u => u.pk_user_account === selectedUser.value!.pk_user_account)
    if (idx >= 0) users.value[idx].roles = [...selectedUser.value.roles]
  } catch (e: any) {
    alert(e?.response?.data?.error?.message || 'Failed to update role')
  } finally {
    saving.value = false
  }
}

async function toggleActive(user: UserRecord) {
  const newActive = !user.is_active
  if (!newActive && !confirm(`Disable ${user.user_email_address}? They will not be able to log in.`)) return
  try {
    await api.patch(`/users/${user.pk_user_account}/active`, { active: newActive })
    user.is_active = newActive
  } catch (e: any) {
    alert(e?.response?.data?.error?.message || 'Failed to update account status')
  }
}

// Pre-register
const preRegDialogVisible = ref(false)
const preRegEmail = ref('')
const preRegName = ref('')
const preRegRoles = ref<string[]>(['user'])
const preRegSaving = ref(false)

function togglePreRegRole(role: string) {
  if (preRegRoles.value.includes(role)) {
    preRegRoles.value = preRegRoles.value.filter(r => r !== role)
  } else {
    preRegRoles.value.push(role)
  }
  if (preRegRoles.value.length === 0) preRegRoles.value.push('user')
}

async function submitPreRegister() {
  if (!preRegEmail.value.trim() || !preRegEmail.value.includes('@')) return
  preRegSaving.value = true
  try {
    await api.post('/users', {
      email: preRegEmail.value.trim(),
      displayName: preRegName.value.trim() || undefined,
      roles: preRegRoles.value,
    })
    preRegDialogVisible.value = false
    preRegEmail.value = ''
    preRegName.value = ''
    preRegRoles.value = ['user']
    await fetchUsers()
  } catch (e: any) {
    alert(e?.response?.data?.error?.message || 'Failed to pre-register user')
  } finally {
    preRegSaving.value = false
  }
}

function formatDate(d: string | null): string {
  if (!d) return 'Never'
  return new Date(d).toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

onMounted(fetchUsers)
</script>

<template>
  <div class="min-h-screen pt-8 px-4 md:px-8">
    <div class="max-w-screen-xl mx-auto">
      <!-- Header -->
      <div class="mb-8">
        <h1 class="text-3xl font-jakarta font-bold text-slate-900 dark:text-white mb-2 flex items-center gap-3">
          <Users class="w-8 h-8 text-indigo-600" />
          User Management
        </h1>
        <p class="text-slate-500 dark:text-slate-400 font-geist">
          Manage user accounts and role assignments.
          <span v-if="!loading" class="text-slate-400 dark:text-slate-500">{{ users.length }} users</span>
        </p>
      </div>

      <!-- Search + Refresh -->
      <div class="flex items-center gap-3 mb-6">
        <div class="relative flex-1 max-w-md">
          <input
            v-model="searchQuery"
            type="text"
            placeholder="Search by name, email, or role..."
            class="w-full px-4 py-2 pl-10 rounded-xl border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800 text-sm font-geist text-slate-800 dark:text-slate-200 focus:outline-none focus:border-indigo-400"
          />
          <Users class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
        </div>
        <button @click="fetchUsers" class="p-2 rounded-lg border border-slate-200 dark:border-slate-600 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors">
          <RefreshCw class="w-4 h-4 text-slate-500 dark:text-slate-400" :class="{ 'animate-spin': loading }" />
        </button>
        <button
          @click="preRegDialogVisible = true"
          class="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-indigo-600 text-white text-xs font-geist font-medium hover:bg-indigo-700 transition-colors"
        >
          <User class="w-3.5 h-3.5" />
          Pre-Register User
        </button>
      </div>

      <!-- Loading -->
      <div v-if="loading" class="text-center py-20 text-slate-400 font-geist">Loading users...</div>

      <!-- Users table -->
      <div v-else class="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-700 overflow-hidden">
        <table class="w-full">
          <thead>
            <tr class="bg-slate-50 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700">
              <th class="px-4 py-3 text-left text-[10px] font-geist font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">User</th>
              <th class="px-4 py-3 text-left text-[10px] font-geist font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">Roles</th>
              <th class="px-4 py-3 text-left text-[10px] font-geist font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">Status</th>
              <th class="px-4 py-3 text-left text-[10px] font-geist font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">Last Login</th>
              <th class="px-4 py-3 text-right text-[10px] font-geist font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">Actions</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="u in filteredUsers"
              :key="u.pk_user_account"
              class="border-b border-slate-50 dark:border-slate-800 hover:bg-slate-50/50 dark:hover:bg-slate-800/50 transition-colors"
            >
              <td class="px-4 py-3">
                <div class="flex items-center gap-3">
                  <div class="w-8 h-8 rounded-full bg-indigo-100 dark:bg-indigo-900 flex items-center justify-center text-xs font-bold text-indigo-600 dark:text-indigo-300 flex-shrink-0">
                    {{ u.user_display_name?.charAt(0) || '?' }}
                  </div>
                  <div class="min-w-0">
                    <div class="text-sm font-geist font-medium text-slate-900 dark:text-white truncate">{{ u.user_display_name }}</div>
                    <div class="text-xs font-geist text-slate-400 dark:text-slate-500 truncate">{{ u.user_email_address }}</div>
                  </div>
                </div>
              </td>
              <td class="px-4 py-3">
                <div class="flex flex-wrap gap-1">
                  <span
                    v-for="role in u.roles"
                    :key="role"
                    class="text-[10px] font-geist font-semibold px-2 py-0.5 rounded-full"
                    :class="ROLE_LABELS[role]?.color || 'bg-slate-100 text-slate-500'"
                  >
                    {{ ROLE_LABELS[role]?.label || role }}
                  </span>
                </div>
              </td>
              <td class="px-4 py-3">
                <span
                  v-if="u.sso_provider_name === 'pending'"
                  class="text-[10px] font-geist font-semibold px-2 py-0.5 rounded-full bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300"
                >
                  Pre-Registered
                </span>
                <span
                  v-else
                  class="text-[10px] font-geist font-semibold px-2 py-0.5 rounded-full"
                  :class="u.is_active
                    ? 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300'
                    : 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300'"
                >
                  {{ u.is_active ? 'Active' : 'Disabled' }}
                </span>
              </td>
              <td class="px-4 py-3 text-xs font-geist text-slate-500 dark:text-slate-400">
                {{ formatDate(u.last_login_at) }}
              </td>
              <td class="px-4 py-3 text-right">
                <div class="flex items-center justify-end gap-1">
                  <button
                    @click="openRoleDialog(u)"
                    class="px-2 py-1 text-[11px] font-geist rounded-lg border border-slate-200 dark:border-slate-600 text-slate-500 dark:text-slate-400 hover:text-indigo-600 dark:hover:text-indigo-400 hover:border-indigo-300 transition-colors"
                  >
                    Edit Roles
                  </button>
                  <button
                    @click="toggleActive(u)"
                    class="px-2 py-1 text-[11px] font-geist rounded-lg border transition-colors"
                    :class="u.is_active
                      ? 'border-slate-200 dark:border-slate-600 text-slate-500 dark:text-slate-400 hover:text-red-600 hover:border-red-300'
                      : 'border-emerald-200 dark:border-emerald-700 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-900/20'"
                  >
                    {{ u.is_active ? 'Disable' : 'Enable' }}
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Pre-register dialog -->
      <Dialog
        v-model:visible="preRegDialogVisible"
        header="Pre-Register User"
        :modal="true"
        :style="{ width: '500px' }"
        :breakpoints="{ '768px': '90vw' }"
      >
        <div class="space-y-4">
          <p class="text-xs font-geist text-slate-500 dark:text-slate-400">
            Create a user record before they log in. When they sign in via SSO for the first time, their pre-assigned roles will be applied automatically.
          </p>
          <div>
            <label class="text-xs font-geist text-slate-500 dark:text-slate-400 mb-1 block">Email Address <span class="text-red-500">*</span></label>
            <input
              v-model="preRegEmail"
              type="email"
              placeholder="user@example.com"
              class="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800 text-sm font-geist text-slate-800 dark:text-slate-200 focus:outline-none focus:border-indigo-400"
            />
          </div>
          <div>
            <label class="text-xs font-geist text-slate-500 dark:text-slate-400 mb-1 block">Display Name</label>
            <input
              v-model="preRegName"
              type="text"
              placeholder="Optional — defaults to email prefix"
              class="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800 text-sm font-geist text-slate-800 dark:text-slate-200 focus:outline-none focus:border-indigo-400"
            />
          </div>
          <div>
            <label class="text-xs font-geist text-slate-500 dark:text-slate-400 mb-2 block">Roles</label>
            <div class="space-y-2">
              <button
                v-for="role in ALL_ROLES"
                :key="role"
                @click="togglePreRegRole(role)"
                class="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl border transition-colors text-left"
                :class="preRegRoles.includes(role)
                  ? 'border-indigo-300 dark:border-indigo-600 bg-indigo-50 dark:bg-indigo-900/20'
                  : 'border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800'"
              >
                <component
                  :is="ROLE_LABELS[role]?.icon || User"
                  class="w-4 h-4 flex-shrink-0"
                  :class="preRegRoles.includes(role) ? 'text-indigo-600 dark:text-indigo-400' : 'text-slate-400'"
                />
                <span class="text-sm font-geist" :class="preRegRoles.includes(role) ? 'text-indigo-700 dark:text-indigo-300 font-medium' : 'text-slate-600 dark:text-slate-400'">
                  {{ ROLE_LABELS[role]?.label || role }}
                </span>
                <Check v-if="preRegRoles.includes(role)" class="w-4 h-4 text-indigo-600 dark:text-indigo-400 ml-auto flex-shrink-0" />
              </button>
            </div>
          </div>
        </div>
        <template #footer>
          <Button severity="secondary" outlined @click="preRegDialogVisible = false" label="Cancel" />
          <button
            @click="submitPreRegister"
            :disabled="!preRegEmail.trim() || !preRegEmail.includes('@') || preRegSaving"
            class="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-geist font-medium hover:bg-indigo-700 disabled:opacity-50 transition-colors"
          >
            {{ preRegSaving ? 'Creating...' : 'Pre-Register' }}
          </button>
        </template>
      </Dialog>

      <!-- Role editing dialog -->
      <Dialog
        v-model:visible="roleDialogVisible"
        :header="`Edit Roles — ${selectedUser?.user_display_name || ''}`"
        :modal="true"
        :style="{ width: '480px' }"
        :breakpoints="{ '768px': '90vw' }"
      >
        <template v-if="selectedUser">
          <p class="text-xs font-geist text-slate-500 dark:text-slate-400 mb-4">{{ selectedUser.user_email_address }}</p>
          <div class="space-y-2">
            <button
              v-for="role in ALL_ROLES"
              :key="role"
              @click="toggleRole(role)"
              :disabled="saving"
              class="w-full flex items-center gap-3 px-4 py-3 rounded-xl border transition-colors"
              :class="selectedUser.roles.includes(role)
                ? 'border-indigo-300 dark:border-indigo-600 bg-indigo-50 dark:bg-indigo-900/20'
                : 'border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800'"
            >
              <component
                :is="ROLE_LABELS[role]?.icon || User"
                class="w-5 h-5 flex-shrink-0"
                :class="selectedUser.roles.includes(role) ? 'text-indigo-600 dark:text-indigo-400' : 'text-slate-400 dark:text-slate-500'"
              />
              <div class="flex-1 text-left">
                <div class="text-sm font-geist font-medium" :class="selectedUser.roles.includes(role) ? 'text-indigo-700 dark:text-indigo-300' : 'text-slate-700 dark:text-slate-300'">
                  {{ ROLE_LABELS[role]?.label || role }}
                </div>
                <div class="text-[11px] font-geist text-slate-400 dark:text-slate-500">
                  <template v-if="role === 'user'">Read-only viewer — can see projects and data but cannot modify anything</template>
                  <template v-else-if="role === 'runner'">Can DO work — velocity game, SharePoint, Git, audits, step artifacts</template>
                  <template v-else-if="role === 'project_lead'">Can SET UP work — create/edit projects, modules, CMDB, persons + everything runner can do</template>
                  <template v-else-if="role === 'admin'">System admin — user management, settings + everything project_lead can do</template>
                </div>
              </div>
              <Check v-if="selectedUser.roles.includes(role)" class="w-5 h-5 text-indigo-600 dark:text-indigo-400 flex-shrink-0" />
            </button>
          </div>
        </template>
        <template #footer>
          <Button severity="secondary" outlined @click="roleDialogVisible = false" label="Done" />
        </template>
      </Dialog>
    </div>
  </div>
</template>
