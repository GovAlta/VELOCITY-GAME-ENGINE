<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useAuthStore } from '@/stores/auth'
import api from '@/lib/api'
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import { Key, Copy, Trash2, User, Shield, ExternalLink, Github } from 'lucide-vue-next'

const auth = useAuthStore()

interface ApiKeyItem {
  id: string
  name: string
  prefix: string
  scopes: string[]
  expiresAt: string | null
  lastUsedAt: string | null
  revokedAt: string | null
  createdAt: string
}

const settingsAvatarError = ref(false)
const apiKeys = ref<ApiKeyItem[]>([])
const newKeyName = ref('')
const newKeyFull = ref<string | null>(null)
const loadingKeys = ref(false)

// GitHub PAT + Domain management
const patConfigured = ref(false)
const patInput = ref('')
const domainInput = ref('https://github.com')
const githubDomain = ref('')
const githubOrg = ref('')
const patLoading = ref(false)
const patSaving = ref(false)
const patMessage = ref<{ type: 'success' | 'error'; text: string } | null>(null)

async function loadPatStatus() {
  patLoading.value = true
  try {
    const res = await api.get('/settings/pat/status')
    const d = res.data?.data ?? res.data ?? {}
    patConfigured.value = d.configured ?? false
    githubDomain.value = d.domain || 'github.com'
    githubOrg.value = d.org || ''
    // Reconstruct URL for display
    domainInput.value = githubOrg.value
      ? `https://${githubDomain.value}/${githubOrg.value}`
      : githubDomain.value !== 'github.com' ? `https://${githubDomain.value}` : 'https://github.com'
  } catch {
    patConfigured.value = false
  } finally {
    patLoading.value = false
  }
}

async function saveDomain() {
  if (!domainInput.value.trim()) return
  patSaving.value = true
  patMessage.value = null
  try {
    const saveRes = await api.put('/settings/github-domain', { domain: domainInput.value.trim() })
    const saved = saveRes.data?.data ?? {}
    githubDomain.value = saved.domain || ''
    githubOrg.value = saved.org || ''
    patMessage.value = { type: 'success', text: `Saved: domain=${saved.domain}, org=${saved.org || 'none'}` }
  } catch (e: any) {
    patMessage.value = { type: 'error', text: e?.response?.data?.error?.message || 'Failed to save domain.' }
  } finally {
    patSaving.value = false
  }
}

async function savePat() {
  if (!patInput.value.trim()) return
  patSaving.value = true
  patMessage.value = null
  try {
    await api.put('/settings/pat', { pat: patInput.value.trim() })
    patConfigured.value = true
    patInput.value = ''
    patMessage.value = { type: 'success', text: 'PAT saved successfully.' }
  } catch (e: any) {
    patMessage.value = { type: 'error', text: e?.response?.data?.error?.message || 'Failed to save PAT.' }
  } finally {
    patSaving.value = false
  }
}

async function removePat() {
  if (!confirm('Remove your GitHub PAT? Git-based audits will stop working until a new PAT is added.')) return
  patSaving.value = true
  patMessage.value = null
  try {
    await api.delete('/settings/pat')
    patConfigured.value = false
    patInput.value = ''
    patMessage.value = { type: 'success', text: 'PAT removed.' }
  } catch (e: any) {
    patMessage.value = { type: 'error', text: e?.response?.data?.error?.message || 'Failed to remove PAT.' }
  } finally {
    patSaving.value = false
  }
}

async function loadApiKeys() {
  loadingKeys.value = true
  try {
    const res = await api.get('/api-keys')
    apiKeys.value = (res.data?.data || []).filter((k: ApiKeyItem) => !k.revokedAt)
  } catch {
    apiKeys.value = []
  } finally {
    loadingKeys.value = false
  }
}

async function createApiKey() {
  if (!newKeyName.value.trim()) return
  try {
    const res = await api.post('/api-keys', { name: newKeyName.value.trim() })
    // Backend returns { data: { key: "velo_xxx...", id, name, prefix, ... } }
    const d = res.data?.data
    if (d?.key) {
      newKeyFull.value = d.key
    }
    newKeyName.value = ''
    await loadApiKeys()
  } catch (e: any) {
    alert(e?.response?.data?.error?.message || 'Failed to create API key')
  }
}

async function revokeApiKey(id: string) {
  if (!confirm('Revoke this API key? It will stop working immediately.')) return
  try {
    await api.delete(`/api-keys/${id}`)
    await loadApiKeys()
  } catch (e: any) {
    alert(e?.response?.data?.error?.message || 'Failed to revoke key')
  }
}

function copyKey() {
  if (newKeyFull.value) {
    navigator.clipboard.writeText(newKeyFull.value)
  }
}

onMounted(() => {
  loadApiKeys()
  loadPatStatus()
})
</script>

<template>
  <div class="min-h-screen pt-8 px-4 md:px-8">
    <div class="max-w-screen-xl mx-auto">
      <h1 class="text-3xl font-jakarta font-bold text-slate-900 mb-8">Settings</h1>

      <!-- Profile -->
      <div class="bg-white rounded-2xl border border-slate-200 p-6 mb-6">
        <h2 class="text-lg font-jakarta font-bold text-slate-900 mb-4 flex items-center gap-2">
          <User class="w-5 h-5 text-indigo-600" />
          Profile
        </h2>
        <div v-if="auth.user" class="flex items-center gap-4">
          <img v-if="auth.user.avatarUrl && !settingsAvatarError" :src="auth.user.avatarUrl" :alt="auth.user.name" class="w-12 h-12 rounded-full" @error="settingsAvatarError = true" />
          <div v-else class="w-12 h-12 rounded-full bg-indigo-100 dark:bg-indigo-900 flex items-center justify-center text-indigo-600 dark:text-indigo-300 font-bold text-lg">
            {{ auth.user.name?.charAt(0) }}
          </div>
          <div>
            <div class="font-jakarta font-bold text-slate-900 dark:text-white">{{ auth.user.name }}</div>
            <div class="text-sm font-geist text-slate-500 dark:text-slate-400">{{ auth.user.email }}</div>
            <div class="text-xs font-geist text-slate-400 dark:text-slate-500 mt-0.5">Roles: {{ auth.user.roles?.join(', ') || auth.user.role }}</div>
          </div>
        </div>
        <div v-else class="text-sm font-geist text-slate-400">
          Not signed in. <router-link to="/login" class="text-indigo-600 hover:text-indigo-700">Sign in</router-link>
        </div>
      </div>

      <!-- API Keys -->
      <div class="bg-white rounded-2xl border border-slate-200 p-6 mb-6">
        <h2 class="text-lg font-jakarta font-bold text-slate-900 mb-2 flex items-center gap-2">
          <Key class="w-5 h-5 text-indigo-600" />
          API Keys
        </h2>
        <p class="text-sm font-geist text-slate-500 mb-6">
          Generate API keys for programmatic access. Keys delegate your full access level.
          Use the <code class="text-xs bg-slate-100 px-1 rounded">X-API-Key: velo_xxx...</code> header or
          <code class="text-xs bg-slate-100 px-1 rounded">Authorization: Bearer velo_xxx...</code> header.
        </p>

        <!-- New key alert -->
        <div v-if="newKeyFull" class="bg-green-50 border border-green-200 rounded-xl p-4 mb-6">
          <p class="text-sm font-geist font-semibold text-green-800 mb-2">
            <Shield class="inline w-4 h-4 mr-1" /> API key created. Copy it now — it won't be shown again.
          </p>
          <div class="flex items-center gap-2">
            <code class="flex-1 text-xs bg-white border border-green-200 rounded-lg px-3 py-2 font-mono text-green-900 break-all select-all">
              {{ newKeyFull }}
            </code>
            <Button size="small" severity="success" outlined @click="copyKey" label="Copy" icon="pi pi-copy" />
          </div>
          <Button size="small" severity="secondary" text class="mt-2" @click="newKeyFull = null" label="Dismiss" />
        </div>

        <!-- Create form -->
        <div v-if="auth.isAuthenticated" class="flex items-center gap-2 mb-6">
          <InputText v-model="newKeyName" placeholder="Key name (e.g. Claude Code)" class="flex-1" />
          <Button label="Generate Key" icon="pi pi-key" @click="createApiKey" :disabled="!newKeyName.trim()" />
        </div>

        <!-- Key list -->
        <div v-if="apiKeys.length === 0 && !loadingKeys" class="text-sm text-slate-400 font-geist text-center py-6 border border-dashed border-slate-200 rounded-xl">
          No API keys yet.
        </div>
        <div v-else class="space-y-2">
          <div v-for="key in apiKeys" :key="key.id" class="flex items-center gap-4 p-3 rounded-xl border border-slate-100">
            <Key class="w-4 h-4 text-slate-400 flex-shrink-0" />
            <div class="flex-1 min-w-0">
              <div class="text-sm font-geist font-medium text-slate-900">{{ key.name }}</div>
              <div class="text-[10px] font-geist text-slate-400">
                <code>{{ key.prefix }}...</code> &middot;
                Created {{ key.createdAt ? new Date(key.createdAt).toLocaleDateString() : 'N/A' }}
                <span v-if="key.lastUsedAt"> &middot; Last used {{ new Date(key.lastUsedAt).toLocaleDateString() }}</span>
                <span v-if="key.expiresAt"> &middot; Expires {{ new Date(key.expiresAt).toLocaleDateString() }}</span>
              </div>
            </div>
            <Button icon="pi pi-trash" size="small" severity="danger" text rounded @click="revokeApiKey(key.id)" v-tooltip="'Revoke'" aria-label="Revoke key" />
          </div>
        </div>
      </div>

      <!-- GitHub Integration -->
      <div class="bg-white rounded-2xl border border-slate-200 p-6 mb-6">
        <h2 class="text-lg font-jakarta font-bold text-slate-900 mb-2 flex items-center gap-2">
          <Github class="w-5 h-5 text-indigo-600" />
          GitHub Integration
        </h2>
        <p class="text-sm font-geist text-slate-500 mb-6">
          Add your GitHub Personal Access Token (PAT) to enable repository analytics, code audits, and AI-powered project insights.
        </p>

        <!-- Status indicator -->
        <div class="flex items-center gap-2 mb-4">
          <span class="w-2.5 h-2.5 rounded-full" :class="patConfigured ? 'bg-emerald-500' : 'bg-slate-300'"></span>
          <span class="text-sm font-geist" :class="patConfigured ? 'text-emerald-700' : 'text-slate-500'">
            {{ patLoading ? 'Checking...' : patConfigured ? 'PAT configured' : 'No PAT configured' }}
          </span>
        </div>

        <!-- PAT + Domain form -->
        <div v-if="auth.isAuthenticated" class="space-y-3">
          <div>
            <label class="text-xs font-geist text-slate-500 dark:text-slate-400 mb-1 block">GitHub URL</label>
            <div class="flex items-center gap-2 max-w-lg">
              <InputText
                v-model="domainInput"
                placeholder="https://github.com/MyOrg"
                class="flex-1"
              />
              <button
                @click="saveDomain"
                :disabled="patSaving"
                class="px-3 py-2 text-xs font-geist font-medium rounded-lg border border-slate-200 dark:border-slate-600 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors disabled:opacity-50"
              >
                Save
              </button>
            </div>
            <p class="text-[11px] font-geist text-slate-400 dark:text-slate-500 mt-1">
              Enter your GitHub URL including the organization, e.g. <code>https://github.com/your-org</code>.
              Velo extracts the domain and org automatically. Repos are created under this org.
            </p>
            <div v-if="githubOrg" class="flex items-center gap-2 mt-1.5 text-[11px] font-geist text-emerald-600 dark:text-emerald-400">
              <span class="w-2 h-2 rounded-full bg-emerald-500"></span>
              Domain: <code>{{ githubDomain }}</code> &middot; Org: <code>{{ githubOrg }}</code>
            </div>
          </div>
          <div class="flex items-center gap-2">
            <InputText
              v-model="patInput"
              :placeholder="patConfigured ? '••••••••' : 'ghp_xxxxxxxxxxxx'"
              type="password"
              class="flex-1"
            />
            <Button
              label="Save PAT"
              icon="pi pi-save"
              size="small"
              @click="savePat"
              :disabled="!patInput.trim()"
              :loading="patSaving"
            />
            <Button
              v-if="patConfigured"
              label="Remove PAT"
              icon="pi pi-trash"
              size="small"
              severity="danger"
              outlined
              @click="removePat"
              :loading="patSaving"
            />
          </div>

          <!-- Feedback message -->
          <div v-if="patMessage" class="text-sm font-geist" :class="patMessage.type === 'success' ? 'text-emerald-600' : 'text-red-600'">
            {{ patMessage.text }}
          </div>

          <p class="text-xs font-geist text-slate-400">
            Your PAT is encrypted at rest (AES-256). It's used by all Velo GitHub operations — repo creation, commits, PRs, branches, and code audits. API users never see or need your PAT; Velo injects it automatically.
          </p>
        </div>
      </div>

      <!-- API Documentation link -->
      <div class="bg-white rounded-2xl border border-slate-200 p-6">
        <h2 class="text-lg font-jakarta font-bold text-slate-900 mb-2 flex items-center gap-2">
          <ExternalLink class="w-5 h-5 text-indigo-600" />
          API Documentation
        </h2>
        <p class="text-sm font-geist text-slate-500 mb-4">
          The Velo API is fully documented with an OpenAPI specification.
          All endpoints that accept authentication via cookie also accept API key authentication.
        </p>
        <div class="flex gap-3">
          <a href="/api/v1/docs" target="_blank" class="inline-flex items-center gap-1.5 px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-geist font-medium hover:bg-indigo-700 transition-colors">
            <ExternalLink class="w-3.5 h-3.5" /> API Explorer
          </a>
        </div>
      </div>
    </div>
  </div>
</template>
