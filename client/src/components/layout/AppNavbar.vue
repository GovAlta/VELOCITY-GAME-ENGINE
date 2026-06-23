<script setup lang="ts">
import { ref, computed } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import {
  Menu, X, Zap, Settings, LogIn, LogOut, ChevronDown,
} from 'lucide-vue-next'
import ThemeSwitcher from './ThemeSwitcher.vue'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()
const route = useRoute()
const mobileOpen = ref(false)
const avatarError = ref(false)

interface NavItem {
  label: string
  to: string
}

interface NavGroup {
  label: string
  items: NavItem[]
}

// Top-level direct links
const hasVelocityAccess = computed(() => {
  const roles = auth.user?.roles || []
  return roles.includes('runner') || roles.includes('admin')
})

const directLinks = computed<NavItem[]>(() => [
  { label: 'Projects', to: '/projects' },
])

// Dropdown groups (reactive — updates when user roles change)
const navGroups = computed<NavGroup[]>(() => [
  ...(hasVelocityAccess.value ? [{
    label: 'Velocity',
    items: [
      { label: 'Game Board', to: '/velocity' },
      { label: 'Challenges', to: '/challenges' },
      { label: 'Leaderboard', to: '/leaderboard' },
    ],
  }] : []),
  {
    label: 'Insights',
    items: [
      { label: 'Canvas', to: '/canvas' },
      { label: 'Gantt Chart', to: '/gantt' },
      { label: 'Heatmap', to: '/heatmap' },
      { label: 'At Risk', to: '/at-risk' },
      { label: 'Duplicates', to: '/duplicates' },
    ],
  },
  ...(auth.user?.roles?.includes('project_lead') || auth.user?.roles?.includes('admin') ? [{
    label: 'Resources',
    items: [
      { label: 'Applications', to: '/applications' },
      { label: 'Contracts', to: '/contracts' },
      { label: 'Leads', to: '/leads' },
    ],
  }] : []),
  ...(auth.user?.roles?.includes('admin') ? [{
    label: 'Admin',
    items: [
      { label: 'User Management', to: '/admin/users' },
      { label: 'Settings', to: '/settings' },
    ],
  }] : []),
])

// All items flat (for mobile menu)
const allItems = computed<NavItem[]>(() => [
  ...directLinks.value,
  ...navGroups.value.flatMap(g => g.items),
])

// Track which dropdown is open
const openDropdown = ref<string | null>(null)
let closeTimer: ReturnType<typeof setTimeout>

function openGroup(label: string) {
  clearTimeout(closeTimer)
  openDropdown.value = label
}

function scheduleClose() {
  closeTimer = setTimeout(() => { openDropdown.value = null }, 150)
}

function cancelClose() {
  clearTimeout(closeTimer)
}

function isGroupActive(group: NavGroup): boolean {
  return group.items.some(item => route.path === item.to || route.path.startsWith(item.to + '/'))
}
</script>

<template>
  <header class="sticky top-0 z-50 bg-white/80 dark:bg-slate-900/80 backdrop-blur-lg border-b border-slate-200/60 dark:border-slate-700/60">
    <div class="max-w-screen-2xl mx-auto px-4 md:px-8">
      <div class="flex items-center justify-between h-16">
        <RouterLink
          to="/"
          class="flex items-center gap-3 group"
          aria-label="Go to dashboard"
          data-testid="nav-logo"
        >
          <div class="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center">
            <Zap :size="18" class="text-white" />
          </div>
          <span class="font-jakarta font-bold text-lg text-slate-900 dark:text-white group-hover:text-indigo-600 transition-colors">
            Velo
          </span>
          <span class="hidden sm:inline text-xs font-geist text-slate-400 border-l border-slate-200 pl-3 ml-1">
            Project Tool for AI
          </span>
        </RouterLink>

        <nav class="hidden lg:flex items-center gap-1" aria-label="Main navigation" data-testid="nav-menu">
          <!-- Direct links -->
          <RouterLink
            v-for="item in directLinks"
            :key="item.label"
            :to="item.to"
            class="px-3 py-2 rounded-lg text-sm font-geist text-slate-600 hover:text-indigo-600 hover:bg-slate-50 transition-colors"
            active-class="text-indigo-600 bg-indigo-50"
          >
            {{ item.label }}
          </RouterLink>

          <!-- Dropdown groups -->
          <div
            v-for="group in navGroups"
            :key="group.label"
            class="relative"
            @mouseenter="openGroup(group.label)"
            @mouseleave="scheduleClose"
          >
            <button
              class="flex items-center gap-1 px-3 py-2 rounded-lg text-sm font-geist transition-colors"
              :class="isGroupActive(group) || openDropdown === group.label ? 'text-indigo-600 bg-indigo-50' : 'text-slate-600 hover:text-indigo-600 hover:bg-slate-50'"
              @click="openDropdown = openDropdown === group.label ? null : group.label"
            >
              {{ group.label }}
              <ChevronDown class="w-3.5 h-3.5 transition-transform" :class="openDropdown === group.label ? 'rotate-180' : ''" />
            </button>
            <Transition
              enter-active-class="transition ease-out duration-100"
              enter-from-class="opacity-0 scale-95 -translate-y-1"
              enter-to-class="opacity-100 scale-100 translate-y-0"
              leave-active-class="transition ease-in duration-75"
              leave-from-class="opacity-100 scale-100"
              leave-to-class="opacity-0 scale-95"
            >
              <div
                v-if="openDropdown === group.label"
                class="absolute top-full left-0 mt-1 w-48 bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-lg py-1 z-50"
                @mouseenter="cancelClose"
                @mouseleave="scheduleClose"
              >
                <RouterLink
                  v-for="item in group.items"
                  :key="item.label"
                  :to="item.to"
                  class="block px-4 py-2 text-sm font-geist text-slate-600 hover:text-indigo-600 hover:bg-slate-50 transition-colors"
                  active-class="text-indigo-600 bg-indigo-50"
                  @click="openDropdown = null"
                >
                  {{ item.label }}
                </RouterLink>
              </div>
            </Transition>
          </div>
        </nav>

        <div class="flex items-center gap-3">
          <ThemeSwitcher data-testid="theme-switcher" />

          <!-- Auth: user info + sign out, or sign in -->
          <template v-if="auth.isAuthenticated">
            <RouterLink to="/settings" class="hidden sm:flex items-center gap-2 px-2 py-1 rounded-lg hover:bg-slate-50 transition-colors" v-tooltip="'Settings'">
              <img v-if="auth.user?.avatarUrl && !avatarError" :src="auth.user.avatarUrl" :alt="auth.user.name" class="w-7 h-7 rounded-full" @error="avatarError = true" />
              <div v-else class="w-7 h-7 rounded-full bg-indigo-100 dark:bg-indigo-900 flex items-center justify-center text-xs font-bold text-indigo-600 dark:text-indigo-300">
                {{ auth.user?.name?.charAt(0) || '?' }}
              </div>
              <span class="hidden lg:inline text-xs font-geist text-slate-600 max-w-24 truncate">{{ auth.user?.name }}</span>
            </RouterLink>
            <button
              @click="auth.logout().then(() => $router.push('/login'))"
              class="hidden sm:flex items-center gap-1.5 px-3 py-1.5 border border-slate-200 rounded-lg text-xs font-geist text-slate-600 hover:bg-slate-50 hover:text-red-600 hover:border-red-200 transition-colors"
              aria-label="Sign out"
            >
              <LogOut class="w-3.5 h-3.5" />
              Sign Out
            </button>
          </template>
          <template v-else>
            <RouterLink to="/login" class="hidden sm:flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 text-white rounded-lg text-xs font-geist font-medium hover:bg-indigo-700 transition-colors">
              <LogIn class="w-3.5 h-3.5" />
              Sign In
            </RouterLink>
          </template>
          <button
            class="lg:hidden p-2 rounded-lg hover:bg-slate-100 transition-colors"
            @click="mobileOpen = !mobileOpen"
            :aria-expanded="mobileOpen"
            aria-controls="mobile-menu"
            aria-label="Toggle navigation menu"
            data-testid="mobile-menu-toggle"
          >
            <Menu v-if="!mobileOpen" :size="20" class="text-slate-600" />
            <X v-else :size="20" class="text-slate-600" />
          </button>
        </div>
      </div>

      <Transition
        enter-active-class="transition ease-out duration-200"
        enter-from-class="opacity-0 -translate-y-1"
        enter-to-class="opacity-100 translate-y-0"
        leave-active-class="transition ease-in duration-150"
        leave-from-class="opacity-100 translate-y-0"
        leave-to-class="opacity-0 -translate-y-1"
      >
        <nav
          v-if="mobileOpen"
          id="mobile-menu"
          class="lg:hidden pb-4 border-t border-slate-100 pt-4"
          aria-label="Mobile navigation"
        >
          <div class="flex flex-col gap-1">
            <RouterLink
              v-for="item in directLinks"
              :key="item.label"
              :to="item.to"
              class="px-3 py-2 rounded-lg text-slate-600 hover:bg-slate-50 hover:text-indigo-600 transition-colors font-geist text-sm"
              active-class="text-indigo-600 bg-indigo-50"
              @click="mobileOpen = false"
            >
              {{ item.label }}
            </RouterLink>
            <template v-for="group in navGroups" :key="group.label">
              <div class="px-3 pt-3 pb-1 text-[10px] font-geist font-semibold text-slate-400 uppercase tracking-wider">{{ group.label }}</div>
              <RouterLink
                v-for="item in group.items"
                :key="item.label"
                :to="item.to"
                class="px-3 py-2 rounded-lg text-slate-600 hover:bg-slate-50 hover:text-indigo-600 transition-colors font-geist text-sm pl-5"
                active-class="text-indigo-600 bg-indigo-50"
                @click="mobileOpen = false"
              >
                {{ item.label }}
              </RouterLink>
            </template>
            <div class="border-t border-slate-100 mt-2 pt-2">
              <template v-if="auth.isAuthenticated">
                <RouterLink to="/settings" class="px-3 py-2 rounded-lg text-slate-600 hover:bg-slate-50 hover:text-indigo-600 transition-colors font-geist text-sm flex items-center gap-2" @click="mobileOpen = false">
                  <Settings class="w-4 h-4" /> Settings
                </RouterLink>
                <div class="px-3 py-2 text-xs font-geist text-slate-400">{{ auth.user?.name }} ({{ auth.user?.email }})</div>
                <button
                  class="w-full px-3 py-2 rounded-lg text-left text-red-600 hover:bg-red-50 transition-colors font-geist text-sm flex items-center gap-2"
                  @click="auth.logout().then(() => { mobileOpen = false; $router.push('/login') })"
                >
                  <LogOut class="w-4 h-4" /> Sign Out
                </button>
              </template>
              <RouterLink v-else to="/login" class="px-3 py-2 rounded-lg bg-indigo-600 text-white text-center font-geist text-sm block" @click="mobileOpen = false">
                Sign In
              </RouterLink>
            </div>
          </div>
        </nav>
      </Transition>
    </div>
  </header>
</template>
