/**
 * Memory-pressure shedder.
 *
 * Samples V8 heap usage on an interval and exposes a coarse 3-state machine
 * (GREEN/AMBER/RED) that the rest of the app consults to shed load before
 * the process OOMs. Self-healing: when pressure drops the state recovers
 * automatically and accepting work resumes.
 *
 * Usage:
 *   import { memoryPressure } from './memory-pressure';
 *   if (memoryPressure.isAmberOrWorse()) return 503;
 *   memoryPressure.onStateChange(({ from, to, pct }) => ...);
 *
 * Thresholds are configurable via env vars (see config/environment.ts):
 *   MEM_PRESSURE_AMBER_PCT (default 60)
 *   MEM_PRESSURE_RED_PCT   (default 80)
 *   MEM_PRESSURE_SAMPLE_MS (default 5000)
 *
 * The percentages are heapUsed/heapTotal × 100. heapTotal grows up to the
 * V8 --max-old-space-size ceiling, so on Azure App Service make sure
 * NODE_OPTIONS sets --max-old-space-size to a predictable value (e.g. 2048)
 * — otherwise heapTotal floats and the percentage is meaningless.
 */

import logger from './logger';
import { env } from '../config/environment';

export type PressureState = 'green' | 'amber' | 'red';

export interface PressureSample {
  state: PressureState;
  pct: number;
  heapUsed: number;
  heapTotal: number;
  rss: number;
  external: number;
  at: number;
}

type Listener = (transition: { from: PressureState; to: PressureState; sample: PressureSample }) => void;

class MemoryPressureMonitor {
  private state: PressureState = 'green';
  private lastSample: PressureSample;
  private listeners: Set<Listener> = new Set();
  private timer: NodeJS.Timeout | null = null;

  constructor() {
    this.lastSample = this.takeSample();
  }

  /**
   * Begin sampling. Idempotent — safe to call once at boot.
   * Returns the timer so callers can `.unref()` if they want (we already do).
   */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), env.MEM_PRESSURE_SAMPLE_MS);
    this.timer.unref?.();
  }

  /**
   * Stop sampling (used by graceful shutdown + tests).
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getState(): PressureState { return this.state; }
  isGreen(): boolean        { return this.state === 'green'; }
  isAmberOrWorse(): boolean { return this.state !== 'green'; }
  isRed(): boolean          { return this.state === 'red'; }
  getLastSample(): PressureSample { return this.lastSample; }

  /**
   * Subscribe to state transitions. Returns an unsubscribe fn.
   * Listeners fire only on actual state changes (green→amber, amber→red, etc.),
   * never on plateaus. Errors thrown by listeners are caught + logged so one
   * bad subscriber can't crash the others.
   */
  onStateChange(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Force a sample now (test hook + manual probing). Returns the sample.
   * Triggers state transitions and listener fan-out exactly like the
   * scheduled tick.
   */
  tick(): PressureSample {
    const sample = this.takeSample();
    this.lastSample = sample;
    const next = this.classify(sample.pct);
    if (next !== this.state) {
      const from = this.state;
      this.state = next;
      logger.warn('Memory pressure transition', {
        from, to: next, pct: sample.pct.toFixed(1),
        heapUsedMb: Math.round(sample.heapUsed / 1024 / 1024),
        heapTotalMb: Math.round(sample.heapTotal / 1024 / 1024),
        rssMb: Math.round(sample.rss / 1024 / 1024),
      });
      for (const fn of this.listeners) {
        try { fn({ from, to: next, sample }); }
        catch (err) { logger.error('memory-pressure listener error', { error: (err as Error).message }); }
      }
    }
    return sample;
  }

  private takeSample(): PressureSample {
    const m = process.memoryUsage();
    const pct = m.heapTotal > 0 ? (m.heapUsed / m.heapTotal) * 100 : 0;
    return {
      state: this.state,
      pct,
      heapUsed: m.heapUsed,
      heapTotal: m.heapTotal,
      rss: m.rss,
      external: m.external,
      at: Date.now(),
    };
  }

  private classify(pct: number): PressureState {
    if (pct >= env.MEM_PRESSURE_RED_PCT) return 'red';
    if (pct >= env.MEM_PRESSURE_AMBER_PCT) return 'amber';
    return 'green';
  }

  /**
   * Test-only reset hook. Not exposed publicly via the singleton.
   */
  __resetForTests(): void {
    this.stop();
    this.state = 'green';
    this.listeners.clear();
    this.lastSample = this.takeSample();
  }
}

export const memoryPressure = new MemoryPressureMonitor();
