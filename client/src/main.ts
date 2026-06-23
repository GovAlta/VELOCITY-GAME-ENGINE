import { createApp } from 'vue'
import { createPinia } from 'pinia'
import PrimeVue from 'primevue/config'
import Aura from '@primeuix/themes/aura'
import ToastService from 'primevue/toastservice'
import ConfirmationService from 'primevue/confirmationservice'
import Tooltip from 'primevue/tooltip'

/**
 * Default tooltip placement to `top` instead of PrimeVue's built-in `right`.
 *
 * Why: tooltips on right-edge elements (hamburger, delete buttons, etc.) used
 * to render in the narrow gap between the element and the viewport edge,
 * forcing the browser to word-wrap the text into a tall squished column.
 * PrimeVue's auto-flip only triggers when the tooltip is *fully* out of bounds,
 * not when it's merely cramped.
 *
 * How: PrimeVue's directive resolves the position by reading `binding.modifiers`
 * via `Tooltip.methods.getModifiers(options)`. We monkey-patch that one method
 * to inject `{ top: true }` when no position modifier was passed. Per-call
 * overrides keep working: `v-tooltip.right="..."`, `v-tooltip.bottom="..."`, etc.
 */
{
  const t = Tooltip as any
  if (t?.methods?.getModifiers && !t.methods.__topDefaultPatched) {
    const original = t.methods.getModifiers
    t.methods.getModifiers = function (options: any) {
      const m = original.call(this, options) || {}
      if (!m.top && !m.bottom && !m.left && !m.right) {
        return { ...m, top: true }
      }
      return m
    }
    t.methods.__topDefaultPatched = true
  }
}
import 'primeicons/primeicons.css'
import './assets/main.css'
import App from './App.vue'
import router from './router'
import { useTheme } from '@/composables/useTheme'

const { initTheme } = useTheme()
initTheme()

const app = createApp(App)
const pinia = createPinia()

app.use(pinia)

app.use(PrimeVue, {
  theme: {
    preset: Aura,
    options: {
      prefix: 'p',
      darkModeSelector: '.dark-mode',
    },
  },
})

app.use(ToastService)
app.use(ConfirmationService)
app.directive('tooltip', Tooltip)
app.use(router)

app.config.errorHandler = (err, _instance, info) => {
  console.error('[Global Error]', err, info)
}

app.mount('#app')

// Bootstrap auth — try to fetch current user (non-blocking)
import { useAuthStore } from '@/stores/auth'
import { fetchCsrfToken } from '@/lib/api'
const authStore = useAuthStore()
Promise.all([authStore.fetchUser(), fetchCsrfToken()]).catch(() => {})
