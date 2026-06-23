<script setup lang="ts">
import { onMounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { Zap } from 'lucide-vue-next'

const router = useRouter()
const route = useRoute()
const auth = useAuthStore()

onMounted(async () => {
  // SSO callback — server has set cookies, now fetch user
  await auth.fetchUser()
  if (auth.isAuthenticated) {
    router.replace('/')
  } else {
    router.replace('/login?error=auth_failed')
  }
})
</script>

<template>
  <div class="min-h-screen flex items-center justify-center bg-slate-50">
    <div class="text-center">
      <div class="w-12 h-12 rounded-xl bg-indigo-600 flex items-center justify-center mx-auto mb-4 animate-pulse">
        <Zap :size="24" class="text-white" />
      </div>
      <p class="text-sm font-geist text-slate-500">Signing you in...</p>
    </div>
  </div>
</template>
