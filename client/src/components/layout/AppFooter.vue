<script setup lang="ts">
import { Zap } from 'lucide-vue-next'
</script>

<template>
  <footer class="border-t border-slate-200 bg-slate-50 mt-16" role="contentinfo">
    <div class="max-w-screen-2xl mx-auto px-4 md:px-8 py-8">
      <div class="flex flex-col sm:flex-row items-center justify-between gap-4">
        <div class="flex items-center gap-3">
          <div class="w-6 h-6 rounded bg-indigo-600 flex items-center justify-center">
            <Zap :size="14" class="text-white" />
          </div>
          <span class="font-jakarta font-bold text-sm text-slate-900">Velo</span>
          <span class="text-xs text-slate-400">Project Tool for AI</span>
        </div>
        <p class="text-xs text-slate-400">
          &copy; {{ new Date().getFullYear() }} Velo
        </p>
      </div>
    </div>
  </footer>
</template>
