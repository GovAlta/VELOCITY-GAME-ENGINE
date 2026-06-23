<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { Crown, UserPlus, Trash2, ArrowRightLeft, Users } from 'lucide-vue-next'
import api from '@/lib/api'
import { useCollaborationStore, type ProjectMember, type MemberRole } from '@/stores/collaboration'
import { useAuthStore } from '@/stores/auth'

const props = defineProps<{ projectId: string }>()

const store = useCollaborationStore()
const auth = useAuthStore()

const showAddDialog = ref(false)
const lookupQuery = ref('')
const lookupResults = ref<Array<{ pk_user_account: string; user_email_address: string; user_display_name: string; avatar_url: string | null }>>([])
const lookupLoading = ref(false)
const newRole = ref<MemberRole>('collaborator')
const errorMsg = ref('')

const showTransferDialog = ref(false)
const transferTargetId = ref<string>('')

const members = computed<ProjectMember[]>(() => store.members[props.projectId] || [])
const perms = computed(() => store.permissions[props.projectId])

async function refresh() {
  await Promise.all([
    store.fetchMembers(props.projectId),
    store.fetchPermissions(props.projectId),
  ])
}

onMounted(refresh)
watch(() => props.projectId, refresh)

let searchTimeout: ReturnType<typeof setTimeout>
function searchUsers() {
  clearTimeout(searchTimeout)
  if (lookupQuery.value.trim().length < 2) {
    lookupResults.value = []
    return
  }
  lookupLoading.value = true
  searchTimeout = setTimeout(async () => {
    try {
      const r = await api.get('/users/lookup', { params: { q: lookupQuery.value, limit: 10 } })
      lookupResults.value = r.data?.data || []
    } catch (e: any) {
      errorMsg.value = e?.response?.data?.error?.message || 'Search failed'
    } finally {
      lookupLoading.value = false
    }
  }, 250)
}

async function addMember(userId: string) {
  errorMsg.value = ''
  try {
    await store.addMember(props.projectId, userId, newRole.value)
    showAddDialog.value = false
    lookupQuery.value = ''
    lookupResults.value = []
    newRole.value = 'collaborator'
  } catch (e: any) {
    errorMsg.value = e?.response?.data?.error?.message || 'Failed to add member'
  }
}

async function removeMember(member: ProjectMember) {
  if (!confirm(`Remove ${member.user_display_name} from this project?`)) return
  errorMsg.value = ''
  try {
    await store.removeMember(props.projectId, member.pk_project_member)
  } catch (e: any) {
    errorMsg.value = e?.response?.data?.error?.message || 'Failed to remove member'
  }
}

async function changeRole(member: ProjectMember, role: MemberRole) {
  errorMsg.value = ''
  try {
    await store.changeRole(props.projectId, member.pk_project_member, role)
  } catch (e: any) {
    errorMsg.value = e?.response?.data?.error?.message || 'Failed to change role'
  }
}

async function transferOwnership() {
  if (!transferTargetId.value) return
  errorMsg.value = ''
  try {
    await store.transferOwnership(props.projectId, transferTargetId.value)
    showTransferDialog.value = false
    transferTargetId.value = ''
  } catch (e: any) {
    errorMsg.value = e?.response?.data?.error?.message || 'Failed to transfer ownership'
  }
}

const otherMembers = computed(() =>
  members.value.filter(m => m.fk_pm_user !== auth.user?.id),
)

function ownerCount() {
  return members.value.filter(m => m.member_role === 'owner').length
}
</script>

<template>
  <section class="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-5">
    <header class="flex items-center justify-between mb-4">
      <h3 class="text-sm font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-2">
        <Users class="w-4 h-4" /> Members
        <span v-if="members.length === 0" class="text-xs font-normal text-slate-500">— open project</span>
        <span v-else class="text-xs font-normal text-slate-500">— {{ members.length }} active</span>
      </h3>
      <div class="flex gap-2">
        <button
          v-if="perms?.canManageMembers"
          class="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white flex items-center gap-1"
          @click="showAddDialog = true"
        >
          <UserPlus class="w-3.5 h-3.5" /> Add member
        </button>
        <button
          v-if="perms?.isOwner && ownerCount() === 1 && otherMembers.length > 0"
          class="text-xs px-3 py-1.5 rounded-lg bg-amber-100 dark:bg-amber-900/30 text-amber-800 dark:text-amber-200 flex items-center gap-1"
          @click="showTransferDialog = true"
        >
          <ArrowRightLeft class="w-3.5 h-3.5" /> Transfer ownership
        </button>
      </div>
    </header>

    <div v-if="members.length === 0" class="text-sm text-slate-500 italic">
      No members. This is an open project — anyone with runner+ role can edit.
    </div>

    <template v-else>
      <p class="text-xs text-slate-500 italic mb-3">
        Claimed project — only listed members can make velocity moves. Admins must add themselves to play.
      </p>

    <ul class="space-y-2">
      <li
        v-for="m in members"
        :key="m.pk_project_member"
        class="flex items-center gap-3 p-2 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-700/50"
      >
        <div class="w-9 h-9 rounded-full bg-slate-200 dark:bg-slate-700 flex items-center justify-center text-xs font-semibold text-slate-700 dark:text-slate-200 overflow-hidden">
          <img v-if="m.avatar_url" :src="m.avatar_url" :alt="m.user_display_name" class="w-full h-full object-cover" />
          <span v-else>{{ m.user_display_name.split(' ').map(s => s[0]).join('').slice(0, 2).toUpperCase() }}</span>
        </div>
        <div class="flex-1 min-w-0">
          <div class="text-sm font-medium text-slate-900 dark:text-slate-100 truncate flex items-center gap-1.5">
            {{ m.user_display_name }}
            <Crown v-if="m.member_role === 'owner'" class="w-3.5 h-3.5 text-amber-500" />
          </div>
          <div class="text-xs text-slate-500 truncate">{{ m.user_email_address }}</div>
        </div>
        <div class="flex items-center gap-1">
          <select
            v-if="perms?.canManageMembers && m.fk_pm_user !== auth.user?.id"
            :value="m.member_role"
            @change="(e) => changeRole(m, (e.target as HTMLSelectElement).value as MemberRole)"
            class="text-xs px-2 py-1 rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900"
          >
            <option value="owner">Owner</option>
            <option value="collaborator">Collaborator</option>
          </select>
          <span v-else class="text-xs px-2 py-1 rounded bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300">
            {{ m.member_role }}
          </span>
          <button
            v-if="perms?.canManageMembers || m.fk_pm_user === auth.user?.id"
            class="p-1.5 rounded hover:bg-red-50 dark:hover:bg-red-900/30 text-red-600 dark:text-red-400"
            :title="m.fk_pm_user === auth.user?.id ? 'Leave project' : 'Remove member'"
            @click="removeMember(m)"
          >
            <Trash2 class="w-3.5 h-3.5" />
          </button>
        </div>
      </li>
    </ul>
    </template>

    <p v-if="errorMsg" class="mt-3 text-xs text-red-600 dark:text-red-400">{{ errorMsg }}</p>

    <!-- Add member dialog -->
    <div
      v-if="showAddDialog"
      class="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
      @click.self="showAddDialog = false"
    >
      <div class="bg-white dark:bg-slate-800 rounded-xl shadow-xl max-w-md w-full p-6">
        <h4 class="text-base font-semibold mb-3 text-slate-900 dark:text-slate-100">Add a member</h4>

        <input
          v-model="lookupQuery"
          @input="searchUsers"
          type="search"
          placeholder="Search by email or name…"
          class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 mb-3"
          autofocus
        />

        <div v-if="lookupLoading" class="text-xs text-slate-500 mb-2">Searching…</div>

        <ul class="max-h-60 overflow-y-auto space-y-1 mb-3">
          <li
            v-for="u in lookupResults"
            :key="u.pk_user_account"
            class="flex items-center gap-2 p-2 rounded hover:bg-slate-100 dark:hover:bg-slate-700 cursor-pointer"
            @click="addMember(u.pk_user_account)"
          >
            <div class="w-7 h-7 rounded-full bg-slate-200 dark:bg-slate-700 flex items-center justify-center text-[10px] font-semibold">
              {{ u.user_display_name.split(' ').map(s => s[0]).join('').slice(0, 2).toUpperCase() }}
            </div>
            <div class="flex-1 min-w-0">
              <div class="text-sm truncate">{{ u.user_display_name }}</div>
              <div class="text-xs text-slate-500 truncate">{{ u.user_email_address }}</div>
            </div>
          </li>
        </ul>

        <div class="flex items-center gap-2 mb-4">
          <label class="text-xs text-slate-600 dark:text-slate-300">Add as:</label>
          <select v-model="newRole" class="text-xs px-2 py-1 rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900">
            <option value="collaborator">Collaborator</option>
            <option value="owner">Owner</option>
          </select>
        </div>

        <div class="flex justify-end">
          <button class="text-sm px-4 py-1.5 rounded-lg bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-200" @click="showAddDialog = false">
            Cancel
          </button>
        </div>
      </div>
    </div>

    <!-- Transfer ownership dialog -->
    <div
      v-if="showTransferDialog"
      class="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
      @click.self="showTransferDialog = false"
    >
      <div class="bg-white dark:bg-slate-800 rounded-xl shadow-xl max-w-md w-full p-6">
        <h4 class="text-base font-semibold mb-2 text-slate-900 dark:text-slate-100">Transfer ownership</h4>
        <p class="text-xs text-slate-500 mb-4">
          You will become a collaborator. The new owner gains full control of this project.
        </p>
        <select v-model="transferTargetId" class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 mb-4">
          <option value="">Select a member…</option>
          <option v-for="m in otherMembers" :key="m.pk_project_member" :value="m.fk_pm_user">
            {{ m.user_display_name }} ({{ m.user_email_address }})
          </option>
        </select>
        <div class="flex justify-end gap-2">
          <button class="text-sm px-4 py-1.5 rounded-lg bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-200" @click="showTransferDialog = false">
            Cancel
          </button>
          <button
            :disabled="!transferTargetId"
            class="text-sm px-4 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-700 disabled:bg-slate-300 disabled:dark:bg-slate-600 text-white"
            @click="transferOwnership"
          >
            Transfer
          </button>
        </div>
      </div>
    </div>
  </section>
</template>
