import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Tests for project-scoped subscriptions (Layer 3), per-client write
 * back-pressure (Layer 2), and memory-pressure broadcast behavior.
 *
 * Each test gets a fresh manager via vi.resetModules() so the singleton
 * state doesn't leak between specs.
 */
describe('VelocityStreamManager', () => {
  let manager: any;
  let memoryPressure: any;

  beforeEach(async () => {
    vi.resetModules();
    const memMod = await import('../../utils/memory-pressure');
    memoryPressure = memMod.memoryPressure;
    memoryPressure.__resetForTests();
    const mod = await import('../../sse/velocity-stream');
    manager = mod.velocityStreamManager;
    manager.disconnectAll();
  });

  afterEach(() => {
    manager?.disconnectAll();
  });

  function mockRes(opts: { drain?: boolean; throwOnWrite?: boolean } = {}) {
    const handlers: Record<string, Function[]> = {};
    const res: any = {
      write: vi.fn(() => {
        if (opts.throwOnWrite) throw new Error('socket closed');
        return opts.drain === false ? false : true;
      }),
      end: vi.fn(),
      on: vi.fn((evt: string, cb: Function) => {
        handlers[evt] = handlers[evt] || [];
        handlers[evt].push(cb);
        return res;
      }),
      emit: (evt: string, ...args: unknown[]) => {
        (handlers[evt] || []).forEach(cb => cb(...args));
      },
    };
    return res;
  }

  describe('project-scoped subscriptions (Layer 3)', () => {
    it('delivers to subscribers with matching projectId in data', () => {
      const a = mockRes();
      const b = mockRes();
      manager.addClient(a, { projects: new Set(['p1']) });
      manager.addClient(b, { projects: new Set(['p2']) });
      a.write.mockClear(); b.write.mockClear();

      manager.broadcast('move', { projectId: 'p1', moduleId: 'm1' });

      expect(a.write).toHaveBeenCalled();
      expect(b.write).not.toHaveBeenCalled();
    });

    it('empty filter = subscribe to all (legacy default)', () => {
      const a = mockRes();
      manager.addClient(a, {});
      a.write.mockClear();

      manager.broadcast('move', { projectId: 'p1' });
      manager.broadcast('move', { projectId: 'p2' });

      expect(a.write).toHaveBeenCalledTimes(2);
    });

    it('events without projectId go to everyone', () => {
      const a = mockRes();
      const b = mockRes();
      manager.addClient(a, { projects: new Set(['p1']) });
      manager.addClient(b, { projects: new Set(['p2']) });
      a.write.mockClear(); b.write.mockClear();

      manager.broadcast('sharepoint_ai_skipped', { filename: 'x.pdf' });

      expect(a.write).toHaveBeenCalled();
      expect(b.write).toHaveBeenCalled();
    });

    it('parentId is used as project fallback for clone/version events', () => {
      const a = mockRes();
      manager.addClient(a, { projects: new Set(['parent-1']) });
      a.write.mockClear();

      manager.broadcast('version_created', { parentId: 'parent-1', projectId: 'clone-1' });

      expect(a.write).toHaveBeenCalled();
    });
  });

  describe('per-client write back-pressure (Layer 2)', () => {
    it('removes a client whose write throws', () => {
      // Healthy first — gets through the initial 'clients' broadcast that
      // addClient triggers — then turns hostile to simulate a socket dying
      // mid-stream.
      const a = mockRes();
      manager.addClient(a, {});
      expect(manager.getClientCount()).toBe(1);

      a.write.mockImplementation(() => { throw new Error('socket closed'); });
      manager.broadcast('move', { projectId: 'p1' });
      expect(manager.getClientCount()).toBe(0);
    });

    it('drops low-priority events for laggy clients but still delivers high-priority', () => {
      const a = mockRes({ drain: false });
      manager.addClient(a, {});

      // Send enough writes to push lagScore over the shed threshold (default 3)
      for (let i = 0; i < 5; i++) manager.broadcast('move', { projectId: 'p1' });
      const highPriorityCalls = a.write.mock.calls.length;

      // Low-priority event after lagScore is past the shed threshold should
      // be dropped for this client.
      a.write.mockClear();
      manager.broadcast('clients', { count: 1 });
      expect(a.write).not.toHaveBeenCalled();

      // High-priority events still flow.
      manager.broadcast('move', { projectId: 'p1' });
      expect(a.write).toHaveBeenCalled();
      expect(highPriorityCalls).toBeGreaterThan(0);
    });

    it('kills a client once lagScore reaches the kill threshold', () => {
      const a = mockRes({ drain: false });
      manager.addClient(a, {});
      // 11 writes that never drain -> lagScore reaches the kill threshold (10)
      for (let i = 0; i < 12; i++) manager.broadcast('move', { projectId: 'p1' });
      expect(manager.getClientCount()).toBe(0);
      expect(a.end).toHaveBeenCalled();
    });

    it('drain event resets lag score', () => {
      const a = mockRes({ drain: false });
      manager.addClient(a, {});
      manager.broadcast('move', { projectId: 'p1' });
      manager.broadcast('move', { projectId: 'p1' });
      // drain fires — kernel emptied the buffer
      a.emit('drain');
      a.write.mockClear();
      // Low priority should flow again because lagScore reset
      manager.broadcast('clients', { count: 5 });
      expect(a.write).toHaveBeenCalled();
    });
  });

  describe('memory-pressure response', () => {
    it('broadcasts a pressure event on transition', () => {
      const a = mockRes();
      manager.addClient(a, {});
      a.write.mockClear();

      manager.onMemoryPressureTransition('green', 'amber', 70);

      const calls = a.write.mock.calls.map((c: any[]) => c[0] as string);
      expect(calls.some((m: string) => m.includes('event: pressure'))).toBe(true);
    });

    it('evicts oldest clients on RED transition', () => {
      const clients = Array.from({ length: 4 }, () => mockRes());
      for (const c of clients) manager.addClient(c, {});
      expect(manager.getClientCount()).toBe(4);

      manager.onMemoryPressureTransition('amber', 'red', 85);

      // 25% of 4 = 1 client evicted. Oldest (first added) gets it.
      expect(manager.getClientCount()).toBe(3);
      expect(clients[0].end).toHaveBeenCalled();
    });
  });
});
