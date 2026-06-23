<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { Zap } from 'lucide-vue-next'

const route = useRoute()
const providers = ref<{ google: boolean; microsoft: boolean }>({ google: false, microsoft: false })
const loading = ref(true)
const error = ref<string | null>(null)

onMounted(async () => {
  // Check for error from OAuth callback
  const errParam = route.query.error as string | undefined
  if (errParam) {
    error.value = errParam === 'google_failed' ? 'Google sign-in failed. Please try again.'
      : errParam === 'microsoft_failed' ? 'Microsoft sign-in failed. Please try again.'
      : 'Sign-in failed. Please try again.'
  }

  // Fetch available SSO providers
  try {
    const res = await fetch('/api/v1/auth/providers')
    if (res.ok) {
      const data = await res.json()
      providers.value = data.data || data
    }
  } catch {
    // Default to showing both if endpoint unavailable
    providers.value = { google: true, microsoft: true }
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <div class="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-950 px-4">
    <div class="w-full max-w-md">
      <div class="text-center mb-8">
        <div class="w-16 h-16 rounded-2xl bg-indigo-600 flex items-center justify-center mx-auto mb-4">
          <Zap :size="32" class="text-white" />
        </div>
        <h1 class="text-3xl font-jakarta font-bold text-slate-900 dark:text-white">Velo</h1>
        <p class="text-sm font-geist text-slate-500 dark:text-slate-400 mt-1">Project Tool for AI</p>
      </div>

      <div class="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-700 p-8">
        <h2 class="text-lg font-jakarta font-bold text-slate-900 dark:text-white mb-2 text-center">Sign in to continue</h2>
        <p class="text-sm font-geist text-slate-500 dark:text-slate-400 mb-6 text-center">Sign in to continue.</p>

        <!-- Error message -->
        <div v-if="error" class="mb-4 px-4 py-2 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-sm font-geist text-red-700 dark:text-red-400 text-center">
          {{ error }}
        </div>

        <!-- Loading -->
        <div v-if="loading" class="text-center py-4 text-sm font-geist text-slate-400">
          Loading...
        </div>

        <div v-else class="space-y-3">
          <!-- Microsoft SSO -->
          <a
            v-if="providers.microsoft"
            href="/api/v1/auth/microsoft"
            class="w-full flex items-center justify-center gap-3 px-4 py-3 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-600 rounded-xl text-sm font-geist font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 hover:border-slate-400 dark:hover:border-slate-500 transition-all"
          >
            <svg class="w-5 h-5" viewBox="0 0 21 21">
              <rect x="1" y="1" width="9" height="9" fill="#F25022"/>
              <rect x="11" y="1" width="9" height="9" fill="#7FBA00"/>
              <rect x="1" y="11" width="9" height="9" fill="#00A4EF"/>
              <rect x="11" y="11" width="9" height="9" fill="#FFB900"/>
            </svg>
            Sign in with Microsoft
          </a>

          <!-- Google SSO -->
          <a
            v-if="providers.google"
            href="/api/v1/auth/google"
            class="w-full flex items-center justify-center gap-3 px-4 py-3 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-600 rounded-xl text-sm font-geist font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 hover:border-slate-400 dark:hover:border-slate-500 transition-all"
          >
            <svg class="w-5 h-5" viewBox="0 0 24 24">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/>
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
            </svg>
            Sign in with Google
          </a>

          <!-- No providers -->
          <p v-if="!providers.google && !providers.microsoft" class="text-sm font-geist text-slate-400 dark:text-slate-500 text-center py-4">
            No SSO providers configured. Contact your administrator.
          </p>
        </div>

        <p class="text-xs font-geist text-slate-400 dark:text-slate-500 mt-6 text-center">
          Velo
        </p>
      </div>
    </div>
  </div>
</template>
