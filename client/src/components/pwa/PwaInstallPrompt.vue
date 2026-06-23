<script setup lang="ts">
import { usePwaInstall } from '@/composables/usePwa'
import Button from 'primevue/button'
import { Download } from 'lucide-vue-next'

const { isInstallable, promptInstall, dismissInstall } = usePwaInstall()
</script>

<template>
  <Transition
    enter-active-class="transition-transform duration-300 ease-out"
    enter-from-class="translate-y-full"
    enter-to-class="translate-y-0"
    leave-active-class="transition-transform duration-200 ease-in"
    leave-from-class="translate-y-0"
    leave-to-class="translate-y-full"
  >
    <div
      v-if="isInstallable"
      role="alert"
      class="fixed bottom-4 left-4 right-4 sm:left-auto sm:right-4 sm:w-96 z-[60] bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl shadow-xl p-4"
    >
      <div class="flex items-start gap-3">
        <div class="flex-shrink-0 w-10 h-10 rounded-lg bg-indigo-100 dark:bg-indigo-900/30 flex items-center justify-center">
          <Download class="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
        </div>
        <div class="flex-1 min-w-0">
          <p class="text-sm font-semibold text-surface-900 dark:text-surface-0">
            Install App
          </p>
          <p class="text-xs text-surface-500 mt-0.5">
            Install this application for quick access and offline use.
          </p>
          <div class="flex gap-2 mt-3">
            <Button
              label="Install"
              size="small"
              @click="promptInstall"
              aria-label="Install application"
            />
            <Button
              label="Not now"
              size="small"
              severity="secondary"
              text
              @click="dismissInstall"
              aria-label="Dismiss install prompt"
            />
          </div>
        </div>
      </div>
    </div>
  </Transition>
</template>
