<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import yaml from 'js-yaml'
import { Bot, Download, ChevronDown, ChevronRight, Lock, FileText, ExternalLink } from 'lucide-vue-next'

interface OpenApiOperation {
  method: string
  path: string
  summary?: string
  description?: string
  tags?: string[]
  parameters?: Array<{
    name: string
    in: string
    required?: boolean
    schema?: { type?: string; format?: string }
    description?: string
  }>
  requestBody?: any
  responses?: Record<string, { description?: string }>
  security?: any[]
  'x-required-roles'?: string[]
}

interface OpenApiSpec {
  openapi: string
  info: { title: string; version: string; description?: string }
  paths: Record<string, Record<string, OpenApiOperation>>
  tags?: Array<{ name: string; description?: string }>
}

const apiBase = (import.meta.env.VITE_API_BASE_URL || '/api') + '/v1'

const loading = ref(true)
const errorMsg = ref('')
const spec = ref<OpenApiSpec | null>(null)
const expandedTags = ref<Record<string, boolean>>({})
const expandedOps = ref<Record<string, boolean>>({})
const tagFilter = ref('')

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const
type Method = typeof METHODS[number]

const METHOD_COLOR: Record<Method, { bg: string; text: string }> = {
  get:    { bg: 'bg-emerald-100 dark:bg-emerald-900/40', text: 'text-emerald-700 dark:text-emerald-300' },
  post:   { bg: 'bg-amber-100 dark:bg-amber-900/40',     text: 'text-amber-700 dark:text-amber-300'   },
  put:    { bg: 'bg-blue-100 dark:bg-blue-900/40',       text: 'text-blue-700 dark:text-blue-300'     },
  patch:  { bg: 'bg-violet-100 dark:bg-violet-900/40',   text: 'text-violet-700 dark:text-violet-300' },
  delete: { bg: 'bg-rose-100 dark:bg-rose-900/40',       text: 'text-rose-700 dark:text-rose-300'     },
}

async function loadSpec() {
  loading.value = true
  errorMsg.value = ''
  try {
    const r = await fetch(`${apiBase}/docs`, { headers: { Accept: 'application/yaml,text/plain' } })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const text = await r.text()
    spec.value = yaml.load(text) as OpenApiSpec
  } catch (e: any) {
    errorMsg.value = e?.message || 'Failed to load openapi spec'
  } finally {
    loading.value = false
  }
}

// Flat list of every operation, with method/path attached
const allOperations = computed<OpenApiOperation[]>(() => {
  if (!spec.value?.paths) return []
  const out: OpenApiOperation[] = []
  for (const [pathStr, pathItem] of Object.entries(spec.value.paths)) {
    for (const method of METHODS) {
      const op = pathItem[method] as OpenApiOperation | undefined
      if (!op) continue
      out.push({ ...op, method, path: pathStr })
    }
  }
  return out
})

// Endpoints grouped by tag, sorted (untagged → bottom)
const byTag = computed<Array<{ tag: string; description?: string; ops: OpenApiOperation[] }>>(() => {
  const m = new Map<string, OpenApiOperation[]>()
  for (const op of allOperations.value) {
    const tags = op.tags && op.tags.length > 0 ? op.tags : ['(untagged)']
    for (const t of tags) {
      if (!m.has(t)) m.set(t, [])
      m.get(t)!.push(op)
    }
  }
  const tagsMeta = new Map((spec.value?.tags || []).map(t => [t.name, t.description]))
  const result = [...m.entries()].map(([tag, ops]) => ({
    tag,
    description: tagsMeta.get(tag),
    ops: ops.sort((a, b) => (a.path + a.method).localeCompare(b.path + b.method)),
  }))
  return result.sort((a, b) => {
    if (a.tag === '(untagged)') return 1
    if (b.tag === '(untagged)') return -1
    return a.tag.localeCompare(b.tag)
  })
})

// After search filtering
const filteredByTag = computed(() => {
  const q = tagFilter.value.trim().toLowerCase()
  if (!q) return byTag.value
  return byTag.value
    .map(group => ({
      ...group,
      ops: group.ops.filter(op =>
        op.path.toLowerCase().includes(q) ||
        (op.summary || '').toLowerCase().includes(q) ||
        op.method.includes(q) ||
        group.tag.toLowerCase().includes(q),
      ),
    }))
    .filter(group => group.ops.length > 0)
})

const totalOpCount = computed(() => allOperations.value.length)
const filteredOpCount = computed(() =>
  filteredByTag.value.reduce((sum, g) => sum + g.ops.length, 0),
)

function toggleTag(tag: string) {
  expandedTags.value[tag] = !expandedTags.value[tag]
}
function opKey(op: OpenApiOperation) { return `${op.method}:${op.path}` }
function toggleOp(op: OpenApiOperation) {
  const k = opKey(op)
  expandedOps.value[k] = !expandedOps.value[k]
}

function expandAll() {
  for (const g of byTag.value) expandedTags.value[g.tag] = true
}
function collapseAll() {
  for (const g of byTag.value) expandedTags.value[g.tag] = false
  expandedOps.value = {}
}

onMounted(loadSpec)
</script>

<template>
  <div class="mb-8">
    <!-- Header + download buttons -->
    <div class="flex items-start justify-between gap-3 mb-3 border-b border-slate-200 dark:border-slate-700 pb-2">
      <h3 class="text-base font-jakarta font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
        <Bot class="w-5 h-5 text-violet-500 dark:text-violet-400" />
        AI Agent Playbook — Live API Reference
      </h3>
      <div class="flex items-center gap-2">
        <a
          :href="`${apiBase}/velocity/claude-md`"
          download="CLAUDE.md"
          class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-geist font-medium border border-indigo-300 dark:border-indigo-700 text-indigo-700 dark:text-indigo-300 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 transition-colors"
          title="Download the prescriptive agent guide (workflow, mechanics, recipes)"
        >
          <FileText class="w-3.5 h-3.5" />
          Download CLAUDE.md
        </a>
        <a
          :href="`${apiBase}/docs`"
          download="openapi.yaml"
          class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-geist font-medium border border-emerald-300 dark:border-emerald-700 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 transition-colors"
          title="Download the live OpenAPI 3.0 spec — canonical endpoint reference"
        >
          <Download class="w-3.5 h-3.5" />
          Download OpenAPI
        </a>
      </div>
    </div>

    <p class="text-sm font-geist text-slate-500 dark:text-slate-400 mb-4">
      Endpoints below are rendered live from
      <a :href="`${apiBase}/docs`" target="_blank" rel="noopener" class="text-indigo-600 dark:text-indigo-400 hover:underline inline-flex items-center gap-0.5">
        <code class="text-[11px]">{{ apiBase }}/docs</code>
        <ExternalLink class="w-3 h-3" />
      </a>
      — the canonical OpenAPI 3.0 spec. All write endpoints require
      <code class="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-indigo-600 dark:text-indigo-400 text-[11px]">X-API-Key: velo_xxx</code>.
      Turns are attributed to the API key owner. For prescriptive guidance (workflow, game mechanics, multi-step recipes) see the downloadable CLAUDE.md.
    </p>

    <!-- Loading / error -->
    <div v-if="loading" class="p-8 text-center text-sm font-geist text-slate-400">
      Loading API spec…
    </div>
    <div v-else-if="errorMsg" class="p-3 rounded-lg bg-rose-50 dark:bg-rose-900/20 text-rose-700 dark:text-rose-300 text-xs font-geist border border-rose-200 dark:border-rose-800">
      Failed to load <code>{{ apiBase }}/docs</code>: {{ errorMsg }}
      <button class="ml-2 underline" @click="loadSpec">Retry</button>
    </div>

    <!-- Controls + accordion -->
    <template v-else-if="spec">
      <div class="flex items-center gap-2 mb-3 flex-wrap">
        <input
          v-model="tagFilter"
          type="text"
          placeholder="Filter endpoints (path / summary / method / tag)…"
          class="flex-1 min-w-[260px] px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800 text-xs font-geist text-slate-800 dark:text-slate-200 focus:outline-none focus:border-indigo-400"
        />
        <span class="text-[11px] font-geist text-slate-400">
          {{ filteredOpCount }} / {{ totalOpCount }} endpoints
        </span>
        <button @click="expandAll" class="text-[11px] font-geist text-indigo-600 dark:text-indigo-400 hover:underline px-2 py-1">Expand all</button>
        <button @click="collapseAll" class="text-[11px] font-geist text-slate-500 dark:text-slate-400 hover:underline px-2 py-1">Collapse all</button>
      </div>

      <div class="space-y-2">
        <div
          v-for="group in filteredByTag"
          :key="group.tag"
          class="rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden bg-white dark:bg-slate-800"
        >
          <button
            class="w-full px-3 py-2 flex items-center justify-between gap-2 text-left hover:bg-slate-50 dark:hover:bg-slate-700/50 transition-colors"
            @click="toggleTag(group.tag)"
          >
            <span class="flex items-center gap-2 min-w-0">
              <component
                :is="expandedTags[group.tag] || tagFilter ? ChevronDown : ChevronRight"
                class="w-4 h-4 text-slate-400 flex-shrink-0"
              />
              <span class="text-sm font-jakarta font-semibold text-slate-900 dark:text-slate-100">{{ group.tag }}</span>
              <span class="text-[10px] font-geist text-slate-500 dark:text-slate-400">{{ group.ops.length }} endpoints</span>
              <span v-if="group.description" class="text-[11px] font-geist text-slate-400 truncate hidden md:inline">— {{ group.description }}</span>
            </span>
          </button>

          <div
            v-show="expandedTags[group.tag] || !!tagFilter"
            class="border-t border-slate-100 dark:border-slate-700 divide-y divide-slate-100 dark:divide-slate-700"
          >
            <div
              v-for="op in group.ops"
              :key="opKey(op)"
              class="px-3 py-2 hover:bg-slate-50 dark:hover:bg-slate-700/30"
            >
              <button
                class="w-full text-left flex items-start gap-2"
                @click="toggleOp(op)"
              >
                <component
                  :is="expandedOps[opKey(op)] ? ChevronDown : ChevronRight"
                  class="w-3.5 h-3.5 text-slate-400 flex-shrink-0 mt-0.5"
                />
                <span
                  class="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase flex-shrink-0"
                  :class="`${METHOD_COLOR[op.method as Method].bg} ${METHOD_COLOR[op.method as Method].text}`"
                >{{ op.method }}</span>
                <code class="text-xs text-indigo-600 dark:text-indigo-400 font-semibold flex-shrink-0">{{ op.path }}</code>
                <span class="text-[11px] font-geist text-slate-500 dark:text-slate-400 flex-1 min-w-0 truncate">{{ op.summary }}</span>
                <span
                  v-if="op['x-required-roles']?.length"
                  class="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-geist font-semibold bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 flex-shrink-0"
                  :title="`Requires role: ${op['x-required-roles']!.join(', ')}`"
                >
                  <Lock class="w-2.5 h-2.5" />
                  {{ op['x-required-roles']!.join('/') }}
                </span>
              </button>

              <div
                v-show="expandedOps[opKey(op)]"
                class="mt-2 ml-6 space-y-2 text-[11px] font-geist text-slate-600 dark:text-slate-300"
              >
                <p v-if="op.description" class="whitespace-pre-wrap leading-relaxed">{{ op.description }}</p>

                <div v-if="op.parameters?.length">
                  <div class="text-[10px] uppercase font-semibold text-slate-500 dark:text-slate-400 mb-1">Parameters</div>
                  <ul class="space-y-0.5 ml-2">
                    <li v-for="p in op.parameters" :key="`${p.in}:${p.name}`" class="flex items-baseline gap-2">
                      <code class="text-indigo-600 dark:text-indigo-400 text-[11px]">{{ p.name }}</code>
                      <span class="text-[10px] text-slate-500 dark:text-slate-400">{{ p.in }}</span>
                      <span v-if="p.required" class="text-[10px] text-rose-600 dark:text-rose-400">required</span>
                      <span v-if="p.schema?.type" class="text-[10px] text-slate-400">{{ p.schema.type }}{{ p.schema.format ? `:${p.schema.format}` : '' }}</span>
                      <span v-if="p.description" class="text-[10px] text-slate-500 dark:text-slate-400 truncate">— {{ p.description }}</span>
                    </li>
                  </ul>
                </div>

                <div v-if="op.requestBody">
                  <div class="text-[10px] uppercase font-semibold text-slate-500 dark:text-slate-400 mb-1">Request body</div>
                  <pre class="text-[10px] font-mono bg-slate-50 dark:bg-slate-900/40 rounded p-2 overflow-x-auto">{{ JSON.stringify(op.requestBody.content || op.requestBody, null, 2).slice(0, 500) }}</pre>
                </div>

                <div v-if="op.responses">
                  <div class="text-[10px] uppercase font-semibold text-slate-500 dark:text-slate-400 mb-1">Responses</div>
                  <ul class="space-y-0.5 ml-2">
                    <li v-for="(resp, code) in op.responses" :key="code" class="flex items-baseline gap-2">
                      <code
                        class="text-[11px]"
                        :class="String(code).startsWith('2') ? 'text-emerald-600 dark:text-emerald-400' : String(code).startsWith('4') ? 'text-amber-600 dark:text-amber-400' : String(code).startsWith('5') ? 'text-rose-600 dark:text-rose-400' : 'text-slate-500'"
                      >{{ code }}</code>
                      <span class="text-[10px] text-slate-500 dark:text-slate-400">{{ resp.description }}</span>
                    </li>
                  </ul>
                </div>

                <a
                  :href="`${apiBase}/docs`"
                  target="_blank"
                  rel="noopener"
                  class="inline-flex items-center gap-0.5 text-[10px] text-indigo-500 hover:underline"
                >
                  Full schema in OpenAPI spec <ExternalLink class="w-2.5 h-2.5" />
                </a>
              </div>
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
