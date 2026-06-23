import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { memoryPressure } from '../../utils/memory-pressure';

/**
 * The shedder is a singleton, so each test resets it. We force samples by
 * spying on process.memoryUsage and calling tick() directly — no need to
 * wait for the real interval.
 */
describe('memory-pressure', () => {
  let memSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    memoryPressure.__resetForTests();
    memSpy = vi.spyOn(process, 'memoryUsage');
  });

  afterEach(() => {
    memSpy.mockRestore();
  });

  function fakeHeap(pct: number) {
    const total = 1_000_000_000; // 1 GB
    const used = Math.round((total * pct) / 100);
    memSpy.mockReturnValue({
      rss: used + 100_000_000,
      heapTotal: total,
      heapUsed: used,
      external: 0,
      arrayBuffers: 0,
    } as any);
  }

  it('starts in green state', () => {
    expect(memoryPressure.getState()).toBe('green');
    expect(memoryPressure.isGreen()).toBe(true);
    expect(memoryPressure.isAmberOrWorse()).toBe(false);
  });

  it('transitions green → amber → red as heap fills', () => {
    fakeHeap(50); memoryPressure.tick();
    expect(memoryPressure.getState()).toBe('green');

    fakeHeap(65); memoryPressure.tick();
    expect(memoryPressure.getState()).toBe('amber');
    expect(memoryPressure.isAmberOrWorse()).toBe(true);

    fakeHeap(85); memoryPressure.tick();
    expect(memoryPressure.getState()).toBe('red');
    expect(memoryPressure.isRed()).toBe(true);
  });

  it('recovers when heap drops', () => {
    fakeHeap(85); memoryPressure.tick();
    expect(memoryPressure.getState()).toBe('red');

    fakeHeap(30); memoryPressure.tick();
    expect(memoryPressure.getState()).toBe('green');
  });

  it('fires state-change listeners only on actual transitions', () => {
    const fn = vi.fn();
    memoryPressure.onStateChange(fn);

    // Two ticks at the same state — should not fire
    fakeHeap(40); memoryPressure.tick();
    fakeHeap(45); memoryPressure.tick();
    expect(fn).not.toHaveBeenCalled();

    // Real transition
    fakeHeap(70); memoryPressure.tick();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn.mock.calls[0][0]).toMatchObject({ from: 'green', to: 'amber' });
  });

  it('unsubscribe stops further callbacks', () => {
    const fn = vi.fn();
    const unsub = memoryPressure.onStateChange(fn);

    fakeHeap(70); memoryPressure.tick();
    expect(fn).toHaveBeenCalledTimes(1);

    unsub();
    fakeHeap(85); memoryPressure.tick();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('listener errors do not crash the tick loop', () => {
    const bad = vi.fn(() => { throw new Error('boom'); });
    const good = vi.fn();
    memoryPressure.onStateChange(bad);
    memoryPressure.onStateChange(good);

    fakeHeap(70);
    expect(() => memoryPressure.tick()).not.toThrow();
    expect(good).toHaveBeenCalled();
  });
});
