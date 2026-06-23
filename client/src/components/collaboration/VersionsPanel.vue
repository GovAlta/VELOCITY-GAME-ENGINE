<script setup lang="ts">
import { computed, onMounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { GitFork, Lock, Crown, ChevronRight, User } from 'lucide-vue-next'
import { useCollaborationStore } from '@/stores/collaboration'

const props = defineProps<{ projectId: string }>()

const router = useRouter()
const store = useCollaborationStore()
const cluster = computed(() => store.clusters[props.projectId])

async function refresh() {
  try { await store.fetchCluster(props.projectId) } catch { /* ignore */ }
}

onMounted(refresh)
watch(() => props.projectId, refresh)

// Versions in the cluster excluding "self" — i.e. the related projects.
const others = computed(() =>
  (cluster.value?.versions ?? []).filter(v => v.pk_project !== props.projectId),
)

const isThisAClone = computed(() =>
  cluster.value?.versions.find(v => v.pk_project === props.projectId)?.fk_project_parent != null,
)

function statusColorClass(status: string | null): string {
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
  <section
    v-if="cluster && others.length > 0"
    class="rounded-xl border border-violet-200 dark:border-violet-800 bg-violet-50/40 dark:bg-violet-950/20 p-5"
  >
    <header class="flex items-center justify-between mb-3">
      <h3 class="text-sm font-semibold text-violet-900 dark:text-violet-200 flex items-center gap-2">
        <GitFork class="w-4 h-4" />
        {{ isThisAClone ? 'Other versions in this cluster' : 'Versions of this project' }}
        <span class="text-xs font-normal text-violet-700 dark:text-violet-300">
          — {{ others.length }} other{{ others.length === 1 ? '' : 's' }}
        </span>
      </h3>
      <button
        @click="router.push(`/projects/${projectId}/cluster`)"
        class="text-xs px-3 py-1 rounded-lg bg-violet-200 hover:bg-violet-300 dark:bg-violet-900/50 dark:hover:bg-violet-900/70 text-violet-800 dark:text-violet-200 flex items-center gap-1"
      >
        Compare side-by-side <ChevronRight class="w-3.5 h-3.5" />
      </button>
    </header>

    <p class="text-xs text-violet-700 dark:text-violet-300 mb-3">
      <span v-if="isThisAClone">
        This project was cloned from a parent. Other people have also taken on this challenge — see how their attempts compare.
      </span>
      <span v-else>
        This project has been cloned by other people who are taking it on independently. Each clone is a fully separate attempt.
      </span>
    </p>

    <ul class="space-y-2">
      <li
        v-for="v in others"
        :key="v.pk_project"
        class="flex items-center gap-3 p-2 rounded-lg bg-white dark:bg-slate-800 hover:shadow-sm cursor-pointer border border-slate-200 dark:border-slate-700"
        @click="router.push(`/projects/${v.pk_project}`)"
      >
        <Crown v-if="!v.fk_project_parent" class="w-4 h-4 text-amber-500 flex-shrink-0" />
        <span v-else class="text-violet-400 text-xs flex-shrink-0 w-4 text-center">↳</span>

        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2 flex-wrap">
            <span class="text-sm font-medium text-slate-900 dark:text-slate-100 truncate">{{ v.project_name }}</span>
            <span v-if="!v.fk_project_parent" class="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-amber-100 text-amber-800">parent</span>
            <span v-if="v.project_version_label" class="text-[10px] text-violet-700 dark:text-violet-300 px-1.5 py-0.5 rounded bg-violet-100 dark:bg-violet-900/40">
              {{ v.project_version_label }}
            </span>
            <Lock v-if="v.project_is_locked" class="w-3 h-3 text-rose-500" v-tooltip="'Locked'" />
          </div>
          <div class="flex items-center gap-2 mt-0.5 text-xs text-slate-500">
            <User v-if="v.primary_owner_name" class="w-3 h-3" />
            <span v-if="v.primary_owner_name">{{ v.primary_owner_name }}</span>
            <span v-else class="italic">no owner (open)</span>
            <span v-if="v.active_member_count > 1">+{{ v.active_member_count - 1 }}</span>
          </div>
        </div>

        <div class="flex flex-col items-end gap-1 flex-shrink-0">
          <span class="text-xs text-slate-500">{{ v.project_status?.replace(/_/g, ' ') || '—' }}</span>
          <div class="flex items-center gap-1.5">
            <div class="w-20 h-1 rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden">
              <div :class="statusColorClass(v.project_status)" class="h-full" :style="{ width: `${v.project_percent_complete ?? 0}%` }" />
            </div>
            <span class="text-[10px] text-slate-500 w-7 text-right">{{ v.project_percent_complete ?? 0 }}%</span>
          </div>
        </div>
      </li>
    </ul>
  </section>
</template>
