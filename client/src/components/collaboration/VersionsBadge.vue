<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { Network, ChevronRight, Lock, Crown } from 'lucide-vue-next'
import { useRouter } from 'vue-router'
import { useCollaborationStore } from '@/stores/collaboration'

const props = defineProps<{ projectId: string }>()

const router = useRouter()
const store = useCollaborationStore()

const expanded = ref(false)
const cluster = computed(() => store.clusters[props.projectId])

async function refresh() {
  try {
    await store.fetchCluster(props.projectId)
  } catch {
    /* ignore — cluster fetch can fail silently */
  }
}

onMounted(refresh)
watch(() => props.projectId, refresh)

const others = computed(() => (cluster.value?.versions || []).filter(v => v.pk_project !== props.projectId))

function navigate(id: string) {
  router.push(`/projects/${id}`)
}
</script>

<template>
  <div v-if="cluster && cluster.versions.length > 1" class="relative">
    <button
      class="text-xs px-3 py-1.5 rounded-full bg-violet-100 hover:bg-violet-200 dark:bg-violet-900/40 dark:hover:bg-violet-900/60 text-violet-800 dark:text-violet-200 flex items-center gap-1.5"
      @click="expanded = !expanded"
    >
      <Network class="w-3.5 h-3.5" />
      {{ cluster.versions.length }} versions
      <ChevronRight class="w-3 h-3 transition-transform" :class="expanded ? 'rotate-90' : ''" />
    </button>

    <div
      v-if="expanded"
      class="absolute left-0 top-full mt-2 z-30 w-80 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 shadow-xl p-2"
    >
      <div class="text-[10px] uppercase tracking-wider text-slate-500 px-2 py-1">Cluster</div>
      <ul class="space-y-1 max-h-72 overflow-y-auto">
        <li v-if="cluster.parent" class="text-xs">
          <button
            class="w-full text-left p-2 rounded hover:bg-slate-50 dark:hover:bg-slate-700 flex items-center gap-2"
            @click="navigate(cluster.parent.pk_project)"
          >
            <Crown class="w-3 h-3 text-amber-500" />
            <span class="flex-1 truncate">
              <span class="font-semibold">{{ cluster.parent.project_name }}</span>
              <span class="ml-1 text-slate-500">— parent</span>
            </span>
            <Lock v-if="cluster.parent.project_is_locked" class="w-3 h-3 text-rose-500" />
            <span class="text-[10px] text-slate-500 ml-1">{{ cluster.parent.project_percent_complete ?? 0 }}%</span>
          </button>
        </li>
        <li v-for="v in others" :key="v.pk_project" class="text-xs">
          <button
            v-if="v.fk_project_parent"
            class="w-full text-left p-2 rounded hover:bg-slate-50 dark:hover:bg-slate-700 flex items-center gap-2"
            @click="navigate(v.pk_project)"
          >
            <span class="w-3 h-3 text-slate-300">↳</span>
            <span class="flex-1 truncate">
              {{ v.project_version_label || v.project_code || 'Untitled clone' }}
              <span v-if="v.primary_owner_name" class="ml-1 text-slate-500">— {{ v.primary_owner_name }}</span>
            </span>
            <Lock v-if="v.project_is_locked" class="w-3 h-3 text-rose-500" />
            <span class="text-[10px] text-slate-500 ml-1">{{ v.project_percent_complete ?? 0 }}%</span>
          </button>
        </li>
      </ul>
    </div>
  </div>
</template>
