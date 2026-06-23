<script setup lang="ts">
import { ref } from 'vue'
import { Play, ArrowRight, Bot, User, CheckCircle, AlertTriangle, Upload, FileText, GitBranch, Cloud, Hand, Lock, RotateCcw } from 'lucide-vue-next'

const expanded = ref(true)
const activeStep = ref(0)

const FLOW_STEPS = [
  { icon: Play, label: 'Start', color: 'bg-sky-100 dark:bg-sky-900/40 text-sky-700 dark:text-sky-300', desc: 'Human opens the step and assigns to AI or takes it themselves' },
  { icon: Bot, label: 'AI Works', color: 'bg-violet-200 dark:bg-violet-800/50 text-violet-800 dark:text-violet-200', desc: 'AI reads instructions, does the work, attaches evidence' },
  { icon: User, label: 'Human Reviews', color: 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300', desc: 'Human checks the deliverable against acceptance criteria' },
  { icon: CheckCircle, label: 'Approve', color: 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300', desc: 'Step completed! Next step auto-advances. Perfect run = ladder bonus.' },
]

function cycleStep() {
  activeStep.value = (activeStep.value + 1) % FLOW_STEPS.length
}

// Auto-cycle
let interval: ReturnType<typeof setInterval>
function startCycle() { interval = setInterval(cycleStep, 3000) }
function stopCycle() { clearInterval(interval) }
startCycle()
</script>

<template>
  <div class="mb-8 bg-gradient-to-br from-indigo-50 via-white to-violet-50 dark:from-slate-800 dark:via-slate-900 dark:to-indigo-950/30 rounded-2xl border border-indigo-200/50 dark:border-indigo-800/30 overflow-hidden">
    <!-- Header -->
    <button
      @click="expanded = !expanded"
      class="w-full flex items-center justify-between px-6 py-4 text-left hover:bg-indigo-50/50 dark:hover:bg-indigo-900/10 transition-colors"
    >
      <div class="flex items-center gap-3">
        <div class="w-10 h-10 rounded-xl bg-indigo-600 flex items-center justify-center">
          <Play class="w-5 h-5 text-white" />
        </div>
        <div>
          <h2 class="text-lg font-jakarta font-bold text-slate-900 dark:text-white">Quick Start Guide</h2>
          <p class="text-xs font-geist text-slate-500 dark:text-slate-400">Learn the Velocity game in 60 seconds</p>
        </div>
      </div>
      <i class="pi text-slate-400 text-sm" :class="expanded ? 'pi-chevron-up' : 'pi-chevron-down'"></i>
    </button>

    <Transition
      enter-active-class="transition-all duration-300 ease-out"
      enter-from-class="max-h-0 opacity-0"
      enter-to-class="max-h-[2000px] opacity-100"
      leave-active-class="transition-all duration-200 ease-in"
      leave-from-class="max-h-[2000px] opacity-100"
      leave-to-class="max-h-0 opacity-0"
    >
      <div v-show="expanded" class="overflow-hidden">
        <div class="px-6 pb-6 space-y-8">

          <!-- ═══ The Big Idea ═══ -->
          <div class="text-center max-w-2xl mx-auto">
            <h3 class="text-2xl font-jakarta font-bold text-slate-900 dark:text-white mb-3">
              Snakes &amp; Ladders for Human-AI Collaboration
            </h3>
            <p class="text-sm font-geist text-slate-600 dark:text-slate-300 leading-relaxed">
              Each module is a board with <strong class="text-indigo-600 dark:text-indigo-400">8 sequential squares</strong>.
              <span class="text-blue-600 dark:text-blue-400 font-semibold">Humans</span> and
              <span class="text-violet-600 dark:text-violet-400 font-semibold">AI agents</span>
              take turns moving forward. One square at a time. One actor at a time.
              A chess clock tracks who has the ball.
            </p>
          </div>

          <!-- ═══ The 8 Steps ═══ -->
          <div>
            <h4 class="text-xs font-geist font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-3 text-center">The 8 Steps</h4>
            <div class="flex items-center justify-center gap-1 overflow-x-auto pb-2">
              <div
                v-for="(step, idx) in ['REQ', 'PLAN', 'ARCH', 'PROTO', 'DEV', 'TEST', 'UAT', 'DEPLOY']"
                :key="idx"
                class="flex items-center"
              >
                <div
                  class="w-14 h-14 rounded-lg flex flex-col items-center justify-center text-center transition-all duration-500"
                  :class="idx <= activeStep
                    ? 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300 scale-105'
                    : idx === activeStep + 1
                      ? 'bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300 animate-pulse'
                      : 'bg-slate-100 dark:bg-slate-800 text-slate-400 dark:text-slate-600'"
                >
                  <span class="text-[9px] font-geist font-bold leading-none">{{ idx + 1 }}</span>
                  <span class="text-[8px] font-geist font-medium leading-none mt-0.5">{{ step }}</span>
                </div>
                <ArrowRight v-if="idx < 7" class="w-3 h-3 text-slate-300 dark:text-slate-600 flex-shrink-0 mx-0.5" />
              </div>
            </div>
          </div>

          <!-- ═══ The Flow (animated) ═══ -->
          <div
            class="relative"
            @mouseenter="stopCycle"
            @mouseleave="startCycle"
          >
            <h4 class="text-xs font-geist font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-3 text-center">How Each Square Works</h4>
            <div class="flex items-stretch justify-center gap-3 md:gap-4">
              <div
                v-for="(step, idx) in FLOW_STEPS"
                :key="idx"
                class="flex-1 max-w-[180px] rounded-xl border-2 p-4 text-center transition-all duration-500 cursor-pointer"
                :class="idx === activeStep
                  ? `${step.color} border-indigo-400 dark:border-indigo-500 shadow-lg scale-105`
                  : idx < activeStep
                    ? 'bg-emerald-50/50 dark:bg-emerald-900/10 border-emerald-200 dark:border-emerald-800'
                    : 'bg-white dark:bg-slate-800/50 border-slate-200 dark:border-slate-700'"
                @click="activeStep = idx"
              >
                <div class="flex justify-center mb-2">
                  <div
                    class="w-10 h-10 rounded-full flex items-center justify-center transition-all duration-300"
                    :class="idx === activeStep ? step.color : 'bg-slate-100 dark:bg-slate-700 text-slate-400'"
                  >
                    <component :is="step.icon" class="w-5 h-5" />
                  </div>
                </div>
                <div class="text-xs font-jakarta font-bold mb-1" :class="idx === activeStep ? '' : 'text-slate-700 dark:text-slate-300'">
                  {{ step.label }}
                </div>
                <p class="text-[10px] font-geist leading-relaxed" :class="idx === activeStep ? '' : 'text-slate-500 dark:text-slate-400'">
                  {{ step.desc }}
                </p>
              </div>
            </div>
            <!-- Flow arrows -->
            <div class="hidden md:flex items-center justify-center gap-[calc(180px-0.5rem)] absolute top-[4.5rem] left-0 right-0 pointer-events-none">
              <ArrowRight v-for="i in 3" :key="i" class="w-5 h-5 text-indigo-300 dark:text-indigo-700" />
            </div>
          </div>

          <!-- ═══ Snakes & Ladders ═══ -->
          <div class="grid md:grid-cols-2 gap-4">
            <!-- Snakes -->
            <div class="rounded-xl bg-red-50/80 dark:bg-red-900/10 border border-red-200/60 dark:border-red-800/40 p-4">
              <h4 class="text-sm font-jakarta font-bold text-red-700 dark:text-red-400 mb-3 flex items-center gap-2">
                <RotateCcw class="w-4 h-4" /> Snakes (Pull You Back)
              </h4>
              <div class="space-y-2">
                <div class="flex items-start gap-2 text-xs font-geist text-red-800 dark:text-red-300">
                  <span class="font-bold text-red-600 dark:text-red-400 shrink-0">-30</span>
                  <span><strong>Rejection</strong> — Reviewer sends work back for rework. Loop count goes up.</span>
                </div>
                <div class="flex items-start gap-2 text-xs font-geist text-red-800 dark:text-red-300">
                  <span class="font-bold text-red-600 dark:text-red-400 shrink-0">-50/step</span>
                  <span><strong>Send-Back</strong> — Slide back. Penalty scales: 3 steps = -150. Intermediate steps reset.</span>
                </div>
                <div class="flex items-start gap-2 text-xs font-geist text-red-800 dark:text-red-300">
                  <span class="font-bold text-red-600 dark:text-red-400 shrink-0">-10</span>
                  <span><strong>Blocked</strong> — External impediment. Red ring, time frozen.</span>
                </div>
              </div>
            </div>

            <!-- Ladders -->
            <div class="rounded-xl bg-emerald-50/80 dark:bg-emerald-900/10 border border-emerald-200/60 dark:border-emerald-800/40 p-4">
              <h4 class="text-sm font-jakarta font-bold text-emerald-700 dark:text-emerald-400 mb-3 flex items-center gap-2">
                <ArrowRight class="w-4 h-4" /> Ladders (Push You Forward)
              </h4>
              <div class="space-y-2">
                <div class="flex items-start gap-2 text-xs font-geist text-emerald-800 dark:text-emerald-300">
                  <span class="font-bold text-emerald-600 dark:text-emerald-400 shrink-0">+100</span>
                  <span><strong>Complete a step (first time)</strong> — Full reward for getting it right.</span>
                </div>
                <div class="flex items-start gap-2 text-xs font-geist text-amber-800 dark:text-amber-300">
                  <span class="font-bold text-amber-600 dark:text-amber-400 shrink-0">+10</span>
                  <span><strong>Re-complete after rework</strong> — Recovery credit only. Rework always costs net points.</span>
                </div>
                <div class="flex items-start gap-2 text-xs font-geist text-emerald-800 dark:text-emerald-300">
                  <span class="font-bold text-emerald-600 dark:text-emerald-400 shrink-0">+25</span>
                  <span><strong>Alignment</strong> — Both human and AI participated. First time only.</span>
                </div>
                <div class="flex items-start gap-2 text-xs font-geist text-emerald-800 dark:text-emerald-300">
                  <span class="font-bold text-emerald-600 dark:text-emerald-400 shrink-0">+15</span>
                  <span><strong>Perfect Run</strong> — Zero loops + aligned. Next step auto-activates!</span>
                </div>
              </div>
            </div>
          </div>

          <!-- ═══ Key Actions ═══ -->
          <div>
            <h4 class="text-xs font-geist font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-3 text-center">Your Toolkit</h4>
            <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div class="rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 p-3 text-center">
                <Upload class="w-5 h-5 text-indigo-500 mx-auto mb-1.5" />
                <div class="text-[11px] font-jakarta font-bold text-slate-800 dark:text-slate-200 mb-0.5">Upload Evidence</div>
                <p class="text-[9px] font-geist text-slate-500 dark:text-slate-400">Attach docs, PRs, test results to every move</p>
              </div>
              <div class="rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 p-3 text-center">
                <GitBranch class="w-5 h-5 text-violet-500 mx-auto mb-1.5" />
                <div class="text-[11px] font-jakarta font-bold text-slate-800 dark:text-slate-200 mb-0.5">Commit Code</div>
                <p class="text-[9px] font-geist text-slate-500 dark:text-slate-400">Push to GitHub via Velo API (PAT auto-injected)</p>
              </div>
              <div class="rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 p-3 text-center">
                <Cloud class="w-5 h-5 text-sky-500 mx-auto mb-1.5" />
                <div class="text-[11px] font-jakarta font-bold text-slate-800 dark:text-slate-200 mb-0.5">SharePoint</div>
                <p class="text-[9px] font-geist text-slate-500 dark:text-slate-400">Documents, artifacts, and knowledge per step</p>
              </div>
              <div class="rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 p-3 text-center">
                <Hand class="w-5 h-5 text-yellow-500 mx-auto mb-1.5" />
                <div class="text-[11px] font-jakarta font-bold text-slate-800 dark:text-slate-200 mb-0.5">Raise Hand</div>
                <p class="text-[9px] font-geist text-slate-500 dark:text-slate-400">Need help? Yellow flag, zero penalty</p>
              </div>
            </div>
          </div>

          <!-- ═══ How to Play ═══ -->
          <div class="rounded-xl bg-indigo-50/80 dark:bg-indigo-900/10 border border-indigo-200/60 dark:border-indigo-800/40 p-5">
            <h4 class="text-sm font-jakarta font-bold text-indigo-700 dark:text-indigo-300 mb-3">How to Play (3 Steps)</h4>
            <div class="grid md:grid-cols-3 gap-4">
              <div class="flex gap-3">
                <span class="w-7 h-7 rounded-full bg-indigo-200 dark:bg-indigo-800 text-indigo-700 dark:text-indigo-300 flex items-center justify-center text-xs font-bold shrink-0">1</span>
                <div>
                  <div class="text-xs font-jakarta font-bold text-indigo-800 dark:text-indigo-200 mb-0.5">Click a Cell</div>
                  <p class="text-[10px] font-geist text-indigo-700/80 dark:text-indigo-300/80">Click any cell on the heatmap to open the step detail. See status, history, and available actions.</p>
                </div>
              </div>
              <div class="flex gap-3">
                <span class="w-7 h-7 rounded-full bg-indigo-200 dark:bg-indigo-800 text-indigo-700 dark:text-indigo-300 flex items-center justify-center text-xs font-bold shrink-0">2</span>
                <div>
                  <div class="text-xs font-jakarta font-bold text-indigo-800 dark:text-indigo-200 mb-0.5">Make a Move</div>
                  <p class="text-[10px] font-geist text-indigo-700/80 dark:text-indigo-300/80">Choose a transition, add notes + evidence, select the actor (AI or Human), and submit.</p>
                </div>
              </div>
              <div class="flex gap-3">
                <span class="w-7 h-7 rounded-full bg-indigo-200 dark:bg-indigo-800 text-indigo-700 dark:text-indigo-300 flex items-center justify-center text-xs font-bold shrink-0">3</span>
                <div>
                  <div class="text-xs font-jakarta font-bold text-indigo-800 dark:text-indigo-200 mb-0.5">Watch it Update</div>
                  <p class="text-[10px] font-geist text-indigo-700/80 dark:text-indigo-300/80">The board updates in real-time for all players via SSE. No refresh needed.</p>
                </div>
              </div>
            </div>
          </div>

          <!-- ═══ Color Legend ═══ -->
          <div>
            <h4 class="text-xs font-geist font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-3 text-center">Cell Colors</h4>
            <div class="flex flex-wrap justify-center gap-x-4 gap-y-2">
              <div class="flex items-center gap-1.5 text-[10px] font-geist text-slate-600 dark:text-slate-400">
                <div class="w-4 h-4 rounded-sm bg-slate-100 dark:bg-slate-700"></div> Not Started
              </div>
              <div class="flex items-center gap-1.5 text-[10px] font-geist text-slate-600 dark:text-slate-400">
                <div class="w-4 h-4 rounded-sm bg-sky-100 dark:bg-sky-900/40"></div> Ready
              </div>
              <div class="flex items-center gap-1.5 text-[10px] font-geist text-slate-600 dark:text-slate-400">
                <div class="w-4 h-4 rounded-sm bg-violet-200 dark:bg-violet-800/50 animate-pulse"></div> AI Working
              </div>
              <div class="flex items-center gap-1.5 text-[10px] font-geist text-slate-600 dark:text-slate-400">
                <div class="w-4 h-4 rounded-sm bg-blue-200 dark:bg-blue-800/50 animate-pulse"></div> Human Working
              </div>
              <div class="flex items-center gap-1.5 text-[10px] font-geist text-slate-600 dark:text-slate-400">
                <div class="w-4 h-4 rounded-sm bg-violet-100 dark:bg-violet-900/40"></div> AI Review
              </div>
              <div class="flex items-center gap-1.5 text-[10px] font-geist text-slate-600 dark:text-slate-400">
                <div class="w-4 h-4 rounded-sm bg-blue-100 dark:bg-blue-900/40"></div> Human Review
              </div>
              <div class="flex items-center gap-1.5 text-[10px] font-geist text-slate-600 dark:text-slate-400">
                <div class="w-4 h-4 rounded-sm bg-emerald-100 dark:bg-emerald-900/40"></div> Completed
              </div>
              <div class="flex items-center gap-1.5 text-[10px] font-geist text-slate-600 dark:text-slate-400">
                <div class="w-4 h-4 rounded-sm bg-yellow-100 dark:bg-yellow-900/40 ring-2 ring-yellow-400 animate-pulse"></div> Hand Raised
              </div>
              <div class="flex items-center gap-1.5 text-[10px] font-geist text-slate-600 dark:text-slate-400">
                <div class="w-4 h-4 rounded-sm bg-red-100 dark:bg-red-900/40 ring-2 ring-red-400"></div> Blocked
              </div>
            </div>
          </div>

        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.max-h-0 { max-height: 0; }
</style>
