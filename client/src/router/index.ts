import { createRouter, createWebHistory } from 'vue-router'
import type { RouteRecordRaw } from 'vue-router'

declare module 'vue-router' {
  interface RouteMeta {
    layout?: 'default' | 'blank'
    title?: string
  }
}

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    name: 'Dashboard',
    component: () => import('@/views/DashboardView.vue'),
    meta: { title: 'Dashboard' },
  },
  {
    path: '/projects',
    name: 'Projects',
    component: () => import('@/views/ProjectsCardView.vue'),
    meta: { title: 'Projects' },
  },
  {
    path: '/projects/:id',
    name: 'ProjectDetail',
    component: () => import('@/views/ProjectDetailView.vue'),
    meta: { title: 'Project Detail' },
  },
  {
    path: '/projects/:id/cluster',
    name: 'ProjectCluster',
    component: () => import('@/views/ClusterView.vue'),
    meta: { title: 'Version Cluster' },
  },
  {
    path: '/gantt',
    name: 'Gantt',
    component: () => import('@/views/GanttView.vue'),
    meta: { title: 'Gantt Chart' },
  },
  {
    path: '/canvas',
    name: 'Canvas',
    component: () => import('@/views/CanvasView.vue'),
    meta: { title: 'Canvas' },
  },
  {
    path: '/heatmap',
    name: 'Heatmap',
    component: () => import('@/views/HeatmapView.vue'),
    meta: { title: 'Ministry Heatmap' },
  },
  {
    path: '/heatmap/:ministry',
    name: 'HeatmapMinistry',
    component: () => import('@/views/HeatmapMinistryView.vue'),
    meta: { title: 'Ministry Health' },
  },
  {
    path: '/at-risk',
    name: 'AtRisk',
    component: () => import('@/views/AtRiskView.vue'),
    meta: { title: 'Projects at Risk' },
  },
  {
    path: '/leads',
    name: 'Leads',
    component: () => import('@/views/LeadsView.vue'),
    meta: { title: 'Delivery Leads' },
  },
  {
    path: '/velocity',
    name: 'Velocity',
    component: () => import('@/views/VelocityView.vue'),
    meta: { title: 'Velocity' },
  },
  {
    path: '/duplicates',
    name: 'Duplicates',
    component: () => import('@/views/DuplicatesView.vue'),
    meta: { title: 'Duplicate Detection' },
  },
  {
    path: '/applications',
    name: 'Applications',
    component: () => import('@/views/ApplicationsView.vue'),
    meta: { title: 'Applications (CMDB)' },
  },
  {
    path: '/contracts',
    name: 'Contracts',
    component: () => import('@/views/ContractsView.vue'),
    meta: { title: 'Contracts' },
  },
  {
    path: '/leaderboard',
    name: 'Leaderboard',
    component: () => import('@/views/LeaderboardView.vue'),
    meta: { title: 'Leaderboard' },
  },
  {
    path: '/challenges',
    name: 'Challenges',
    component: () => import('@/views/ChallengesView.vue'),
    meta: { title: 'Challenges' },
  },
  {
    path: '/login',
    name: 'Login',
    component: () => import('@/views/LoginView.vue'),
    meta: { title: 'Sign In', layout: 'blank' },
  },
  {
    path: '/auth/callback',
    name: 'AuthCallback',
    component: () => import('@/views/AuthCallbackView.vue'),
    meta: { title: 'Signing In...', layout: 'blank' },
  },
  {
    path: '/settings',
    name: 'Settings',
    component: () => import('@/views/SettingsView.vue'),
    meta: { title: 'Settings' },
  },
  {
    path: '/admin/users',
    name: 'AdminUsers',
    component: () => import('@/views/AdminUsersView.vue'),
    meta: { title: 'User Management' },
  },
  {
    path: '/:pathMatch(.*)*',
    name: 'NotFound',
    component: () => import('@/views/NotFoundPage.vue'),
    meta: { title: 'Not Found', layout: 'blank' },
  },
]

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes,
  scrollBehavior(to, _from, savedPosition) {
    if (savedPosition) return savedPosition
    if (to.hash) return { el: to.hash, behavior: 'smooth' }
    return { top: 0 }
  },
})

router.afterEach((to) => {
  document.title = to.meta.title ? `${to.meta.title} | Velo` : 'Velo - Project Tool for AI'
})

/**
 * Sanitize a redirect query param to prevent open-redirect attacks.
 * Returns the path if it's a safe relative path, otherwise null.
 */
export function sanitizeRedirect(redirect: unknown): string | null {
  if (typeof redirect !== 'string') return null
  const trimmed = redirect.trim()
  // Only allow relative paths (starting with /), reject protocol-relative or absolute URLs
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) return null
  return trimmed
}

export default router
