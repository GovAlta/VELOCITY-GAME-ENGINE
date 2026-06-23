<script setup lang="ts">
import { computed, ref, watch, nextTick } from 'vue'
import { useRoute } from 'vue-router'
import Toast from 'primevue/toast'
import AppNavbar from '@/components/layout/AppNavbar.vue'
import AppFooter from '@/components/layout/AppFooter.vue'

const route = useRoute()
const layout = computed(() => route.meta.layout || 'default')

const routeAnnouncement = ref('')

watch(
  () => route.fullPath,
  () => {
    nextTick(() => {
      routeAnnouncement.value = `Navigated to ${route.meta.title || route.name?.toString() || 'page'}`
    })
  },
)
</script>

<template>
  <a href="#main-content" class="skip-nav" data-testid="skip-nav">Skip to main content</a>
  <div id="route-announcer" class="sr-only" aria-live="polite" aria-atomic="true">{{ routeAnnouncement }}</div>
  <Toast position="top-right" />

  <template v-if="layout === 'default'">
    <div class="min-h-screen flex flex-col overflow-x-hidden">
      <AppNavbar />
      <main id="main-content" class="flex-1" data-testid="main-content">
        <router-view />
      </main>
      <AppFooter />
    </div>
  </template>

  <template v-else-if="layout === 'blank'">
    <main id="main-content" class="min-h-screen" data-testid="main-content">
      <router-view />
    </main>
  </template>
</template>
