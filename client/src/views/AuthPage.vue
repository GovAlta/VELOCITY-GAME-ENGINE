<script setup lang="ts">
import { ref } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { BarChart3, ArrowLeft } from 'lucide-vue-next'
import { FormKit } from '@formkit/vue'
import Button from 'primevue/button'
import Tabs from 'primevue/tabs'
import TabList from 'primevue/tablist'
import Tab from 'primevue/tab'
import TabPanels from 'primevue/tabpanels'
import TabPanel from 'primevue/tabpanel'
import { useAuthStore } from '@/stores/auth'
import { sanitizeRedirect } from '@/router'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const activeTab = ref<string>('signin')
const submitting = ref(false)

/**
 * After successful auth, navigate to the redirect param if it's a safe relative path.
 */
function navigateAfterAuth(): void {
  const safe = sanitizeRedirect(route.query.redirect)
  router.replace(safe || '/')
}

async function onSignIn(data: Record<string, unknown>) {
  submitting.value = true
  try {
    await auth.loginWithCredentials(data.email as string, data.password as string)
    navigateAfterAuth()
  } catch {
    // Error handled by API interceptor / global error handler
  } finally {
    submitting.value = false
  }
}

async function onCreateAccount(data: Record<string, unknown>) {
  submitting.value = true
  try {
    await auth.register(data.name as string, data.email as string, data.password as string)
    navigateAfterAuth()
  } catch {
    // Error handled by API interceptor / global error handler
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="min-h-screen flex items-center justify-center bg-slate-50 px-4 py-12">
    <div class="w-full max-w-md">
      <!-- Logo & Branding -->
      <div class="text-center mb-8">
        <RouterLink to="/" class="inline-flex items-center gap-2 mb-6">
          <div class="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center">
            <BarChart3 class="w-5 h-5 text-white" />
          </div>
          <span class="text-xl font-jakarta font-bold text-slate-900">App Template</span>
        </RouterLink>
        <h1 class="text-2xl font-jakarta font-bold text-slate-900 mb-1">Welcome back</h1>
        <p class="text-sm text-slate-500 font-geist">Sign in to your account or create a new one</p>
      </div>

      <!-- Auth Card -->
      <div class="bg-white border border-slate-200 rounded-2xl p-6 sm:p-8 shadow-sm">
        <Tabs :value="activeTab" @update:value="(val: unknown) => activeTab = String(val)">
          <TabList class="mb-6">
            <Tab value="signin" data-testid="auth-tab-login">Sign In</Tab>
            <Tab value="register" data-testid="auth-tab-register">Create Account</Tab>
          </TabList>

          <TabPanels>
            <!-- Sign In Panel -->
            <TabPanel value="signin">
              <!-- SSO Buttons -->
              <div class="space-y-3 mb-6">
                <Button
                  label="Continue with Google"
                  outlined
                  class="w-full justify-center"
                  aria-label="Sign in with Google"
                  @click="auth.login('google')"
                >
                  <template #icon>
                    <svg class="w-5 h-5 mr-2" viewBox="0 0 24 24">
                      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
                      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
                    </svg>
                  </template>
                </Button>
                <Button
                  label="Continue with Microsoft"
                  outlined
                  class="w-full justify-center"
                  aria-label="Sign in with Microsoft"
                  @click="auth.login('microsoft')"
                >
                  <template #icon>
                    <svg class="w-5 h-5 mr-2" viewBox="0 0 24 24" fill="#00A4EF">
                      <path d="M11.4 24H0V12.6h11.4V24zM24 24H12.6V12.6H24V24zM11.4 11.4H0V0h11.4v11.4zM24 11.4H12.6V0H24v11.4z"/>
                    </svg>
                  </template>
                </Button>
              </div>

              <!-- OR Separator -->
              <div class="relative my-6">
                <div class="absolute inset-0 flex items-center">
                  <div class="w-full border-t border-slate-200"></div>
                </div>
                <div class="relative flex justify-center">
                  <span class="bg-white px-4 text-xs text-slate-400 font-geist uppercase">or</span>
                </div>
              </div>

              <!-- Sign In Form -->
              <FormKit
                type="form"
                :actions="false"
                aria-label="Sign in form"
                data-testid="login-form"
                @submit="onSignIn"
              >
                <div class="space-y-4">
                  <FormKit
                    type="email"
                    name="email"
                    label="Email"
                    placeholder="you@example.com"
                    validation="required|email"
                  />
                  <FormKit
                    type="password"
                    name="password"
                    label="Password"
                    placeholder="Enter your password"
                    validation="required|length:12"
                  />
                  <Button
                    type="submit"
                    label="Sign In"
                    class="w-full justify-center"
                    severity="contrast"
                    :loading="submitting"
                    :disabled="submitting"
                    data-testid="login-submit"
                  />
                </div>
              </FormKit>

              <!-- Forgot Password -->
              <p class="text-center mt-4">
                <a href="#" class="text-sm font-geist text-indigo-600 hover:text-indigo-700 font-medium">
                  Forgot password?
                </a>
              </p>
            </TabPanel>

            <!-- Create Account Panel -->
            <TabPanel value="register">
              <FormKit
                type="form"
                :actions="false"
                aria-label="Create account form"
                data-testid="register-form"
                @submit="onCreateAccount"
              >
                <div class="space-y-4">
                  <FormKit
                    type="text"
                    name="name"
                    label="Full Name"
                    placeholder="Jane Doe"
                    validation="required"
                  />
                  <FormKit
                    type="email"
                    name="email"
                    label="Email"
                    placeholder="you@example.com"
                    validation="required|email"
                  />
                  <FormKit
                    type="password"
                    name="password"
                    label="Password"
                    placeholder="Create a password"
                    validation="required|length:12"
                  />
                  <FormKit
                    type="password"
                    name="password_confirm"
                    label="Confirm Password"
                    placeholder="Confirm your password"
                    validation="required|confirm"
                  />
                  <Button
                    type="submit"
                    label="Create Account"
                    class="w-full justify-center"
                    severity="contrast"
                    :loading="submitting"
                    :disabled="submitting"
                    data-testid="register-submit"
                  />
                </div>
              </FormKit>
            </TabPanel>
          </TabPanels>
        </Tabs>
      </div>

      <!-- Back to Home -->
      <div class="text-center mt-6">
        <RouterLink
          to="/"
          class="inline-flex items-center gap-1 text-sm font-geist text-slate-500 hover:text-indigo-600 transition-colors"
        >
          <ArrowLeft class="w-4 h-4" />
          Back to home
        </RouterLink>
      </div>
    </div>
  </div>
</template>
