<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Crown, Lock, Network, ChevronLeft } from 'lucide-vue-next'
import { useCollaborationStore } from '@/stores/collaboration'

const route = useRoute()
const router = useRouter()
const store = useCollaborationStore()

const projectId = computed(() => route.params.id as string)
const cluster = computed(() => store.clusters[projectId.value])

async function refresh() {
  await store.fetchCluster(projectId.value)
}

onMounted(refresh)
watch(projectId, refresh)

function statusColor(status: string | null): string {
  switch (status) {
    case 'completion': return 'bg-emerald-500'
    case 'client_acceptance':
    case 'client_review': return 'bg-blue-500'
    case 'testing':
    case 'development': return 'bg-violet-500'
    case 'requirements':
    case 'discovery': return 'bg-slate-400'
    case 'on_hold': return 'bg-amber-500'
    case 'cancelled': return 'bg-rose-500'
    default: return 'bg-slate-300'
  }
}
</script>

<template>
  <div class="container mx-auto px-4 py-6">
    <button
      class="text-xs text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 flex items-center gap-1 mb-4"
      @click="router.push(`/projects/${projectId}`)"
    >
      <ChevronLeft class="w-3.5 h-3.5" /> Back to project
    </button>

    <div v-if="!cluster" class="text-sm text-slate-500">Loading cluster…</div>

    <div v-else class="space-y-4">
      <header class="flex items-center gap-3">
        <Network class="w-6 h-6 text-violet-600 dark:text-violet-400" />
        <h1 class="text-xl font-semibold text-slate-900 dark:text-slate-100">
          Version cluster
        </h1>
        <span class="text-sm text-slate-500">{{ cluster.versions.length }} version{{ cluster.versions.length === 1 ? '' : 's' }}</span>
      </header>

      <div class="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 overflow-hidden">
        <table class="w-full text-sm">
          <thead class="bg-slate-50 dark:bg-slate-700/40 text-xs uppercase tracking-wider text-slate-600 dark:text-slate-300">
            <tr>
              <th class="text-left px-4 py-2">Version</th>
              <th class="text-left px-4 py-2">Owner</th>
              <th class="text-left px-4 py-2">Status</th>
              <th class="text-left px-4 py-2">Progress</th>
              <th class="text-left px-4 py-2">Members</th>
              <th class="text-left px-4 py-2">State</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="v in cluster.versions"
              :key="v.pk_project"
              class="border-t border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700/30 cursor-pointer"
              @click="router.push(`/projects/${v.pk_project}`)"
            >
              <td class="px-4 py-3">
                <div class="flex items-center gap-2">
                  <Crown v-if="!v.fk_project_parent" class="w-3.5 h-3.5 text-amber-500" />
                  <span v-else class="w-3.5 text-slate-400">↳</span>
                  <div>
                    <div class="font-medium text-slate-900 dark:text-slate-100">{{ v.project_name }}</div>
                    <div class="text-xs text-slate-500">
                      <span v-if="v.project_version_label">{{ v.project_version_label }}</span>
                      <span v-else-if="v.project_code">{{ v.project_code }}</span>
                      <span v-else>—</span>
                    </div>
                  </div>
                </div>
              </td>
              <td class="px-4 py-3 text-slate-700 dark:text-slate-300">
                {{ v.primary_owner_name || '—' }}
              </td>
              <td class="px-4 py-3">
                <span class="text-xs px-2 py-0.5 rounded-full bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-200">
                  {{ v.project_status || 'unknown' }}
                </span>
              </td>
              <td class="px-4 py-3">
                <div class="flex items-center gap-2">
                  <div class="w-32 h-1.5 rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden">
                    <div :class="statusColor(v.project_status)" class="h-full" :style="{ width: `${v.project_percent_complete ?? 0}%` }" />
                  </div>
                  <span class="text-xs text-slate-500 w-10 text-right">{{ v.project_percent_complete ?? 0 }}%</span>
                </div>
              </td>
              <td class="px-4 py-3 text-slate-700 dark:text-slate-300">
                {{ v.active_member_count }}
              </td>
              <td class="px-4 py-3">
                <Lock v-if="v.project_is_locked" class="w-4 h-4 text-rose-500" />
                <span v-else class="text-xs text-slate-400">unlocked</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>
