<script setup lang="ts">
import { computed, ref } from 'vue'
import { useProjectStore } from '@/stores/projects'
import { useAuthStore } from '@/stores/auth'
import api from '@/lib/api'
import Button from 'primevue/button'
import { Link2, ArrowRight, Check, X } from 'lucide-vue-next'

const store = useProjectStore()
const auth = useAuthStore()

const sortedDuplicates = computed(() => {
  return [...store.duplicates].sort((a, b) => b.similarity - a.similarity)
})

const merging = ref<number | null>(null)

async function mergeInto(survivorId: string, victimId: string, idx: number) {
  if (!confirm('Merge the second project into the first? All team, budgets, links, modules, and updates will transfer. The duplicate will be soft-deleted.')) return
  merging.value = idx
  try {
    await api.post(`/projects/${survivorId}/merge`, { mergeProjectId: victimId })
    await store.loadFromApi()
  } catch (e: any) {
    alert(e?.response?.data?.error?.message || 'Merge failed')
  } finally {
    merging.value = null
  }
}

async function dismiss(idx: number) {
  // Just removes from the local list (duplicates are from static data — DB-backed dismiss would need a reviewed flag)
  store.duplicates.splice(idx, 1)
}
</script>

<template>
  <div class="min-h-screen pt-8 px-4 md:px-8">
    <div class="max-w-screen-2xl mx-auto">
      <div class="mb-8">
        <h1 class="text-3xl font-jakarta font-bold text-slate-900 mb-2 flex items-center gap-3">
          <Link2 class="w-8 h-8 text-amber-500" />
          Duplicate Detection
        </h1>
        <p class="text-slate-500 font-geist">
          {{ sortedDuplicates.length }} potential duplicate pairs detected via fuzzy name matching (&ge;75% similarity).
          <template v-if="auth.isAuthenticated"> Use the merge buttons to combine duplicates.</template>
        </p>
      </div>

      <div v-if="sortedDuplicates.length === 0" class="text-center py-20 text-slate-400 font-geist">
        No duplicate pairs remaining.
      </div>

      <div class="space-y-4">
        <div
          v-for="(dup, i) in sortedDuplicates"
          :key="i"
          class="bg-white rounded-2xl border p-5"
          :class="dup.isExactMatch ? 'border-red-200' : 'border-amber-200'"
        >
          <div class="flex items-center gap-2 mb-3">
            <span
              class="text-[10px] font-geist font-semibold px-2 py-0.5 rounded-full"
              :class="dup.isExactMatch ? 'bg-red-50 text-red-600' : 'bg-amber-50 text-amber-600'"
            >
              {{ dup.isExactMatch ? 'EXACT MATCH' : 'FUZZY MATCH' }}
            </span>
            <span class="text-xs font-geist text-slate-400">
              {{ Math.round(dup.similarity * 100) }}% similar
            </span>
            <div class="ml-auto flex gap-2" v-if="auth.isAuthenticated">
              <Button
                label="Not a duplicate"
                icon="pi pi-times"
                size="small"
                severity="secondary"
                text
                @click="dismiss(i)"
              />
            </div>
          </div>

          <div class="grid md:grid-cols-[1fr_auto_1fr] gap-3 items-stretch">
            <!-- Project 1 -->
            <router-link
              :to="`/projects/${dup.project1.id}`"
              class="block p-4 rounded-xl border border-slate-100 hover:border-indigo-200 hover:bg-slate-50 transition-all"
            >
              <div class="text-sm font-jakarta font-bold text-slate-900 mb-1 hover:text-indigo-600">
                {{ dup.project1.name }}
              </div>
              <div class="text-[10px] font-geist text-slate-400">
                {{ dup.project1.id }} &middot; {{ dup.project1.source }}
              </div>
            </router-link>

            <!-- Merge buttons (center column) -->
            <div class="flex flex-col items-center justify-center gap-2 py-2" v-if="auth.isAuthenticated">
              <Button
                v-tooltip="'Merge right into left (keep left)'"
                icon="pi pi-arrow-left"
                size="small"
                severity="info"
                rounded
                :loading="merging === i"
                @click="mergeInto(dup.project1.id, dup.project2.id, i)"
                aria-label="Merge right into left"
              />
              <Button
                v-tooltip="'Merge left into right (keep right)'"
                icon="pi pi-arrow-right"
                size="small"
                severity="info"
                rounded
                :loading="merging === i"
                @click="mergeInto(dup.project2.id, dup.project1.id, i)"
                aria-label="Merge left into right"
              />
            </div>

            <!-- Project 2 -->
            <router-link
              :to="`/projects/${dup.project2.id}`"
              class="block p-4 rounded-xl border border-slate-100 hover:border-indigo-200 hover:bg-slate-50 transition-all"
            >
              <div class="text-sm font-jakarta font-bold text-slate-900 mb-1 hover:text-indigo-600">
                {{ dup.project2.name }}
              </div>
              <div class="text-[10px] font-geist text-slate-400">
                {{ dup.project2.id }} &middot; {{ dup.project2.source }}
              </div>
            </router-link>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
