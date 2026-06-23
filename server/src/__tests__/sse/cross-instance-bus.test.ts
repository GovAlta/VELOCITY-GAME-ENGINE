import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Tests for the Postgres LISTEN/NOTIFY cross-instance bus.
 *
 * We don't connect to a real database — the pool, the parked client, and
 * the notification event are all faked. The bus is a state machine over
 * those interfaces; that's what we want to verify.
 */
describe('CrossInstanceBus', () => {
  let bus: any;
  let mockPool: any;
  let mockClient: any;
  let listenHandlers: Record<string, Function[]>;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../../sse/cross-instance-bus');
    bus = mod.crossInstanceBus;
    bus.__resetForTests();

    listenHandlers = {};
    mockClient = {
      on: vi.fn((evt: string, cb: Function) => {
        listenHandlers[evt] = listenHandlers[evt] || [];
        listenHandlers[evt].push(cb);
      }),
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    };
    mockPool = {
      connect: vi.fn().mockResolvedValue(mockClient),
      query: vi.fn().mockResolvedValue({ rows: [] }),
    };
  });

  afterEach(async () => {
    await bus.stop();
  });

  it('start() acquires a client and LISTENs on velocity_events', async () => {
    await bus.start(mockPool);
    expect(mockPool.connect).toHaveBeenCalled();
    expect(mockClient.query).toHaveBeenCalledWith('LISTEN velocity_events');
  });

  it('publish() always calls the local handler', () => {
    const local = vi.fn();
    bus.registerLocalHandler(local);
    bus.publish('move', { projectId: 'p1' });
    expect(local).toHaveBeenCalledWith('move', { projectId: 'p1' });
  });

  it('publish() also fires pg_notify when started', async () => {
    bus.registerLocalHandler(() => {});
    await bus.start(mockPool);
    bus.publish('move', { projectId: 'p1' });
    expect(mockPool.query).toHaveBeenCalledWith(
      'SELECT pg_notify($1, $2)',
      expect.arrayContaining(['velocity_events']),
    );
    // Payload contains originId + event + data
    const args = mockPool.query.mock.calls[0][1];
    const payload = JSON.parse(args[1]);
    expect(payload.originId).toBe(bus.originId);
    expect(payload.event).toBe('move');
    expect(payload.data).toEqual({ projectId: 'p1' });
  });

  it('skips NOTIFY when payload exceeds 7500 bytes', async () => {
    bus.registerLocalHandler(() => {});
    await bus.start(mockPool);
    mockPool.query.mockClear();

    const huge = 'x'.repeat(8000);
    bus.publish('move', { content: huge });

    // Local handler still fires, NOTIFY skipped
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it('skips NOTIFY when payload is unserializable (circular ref)', async () => {
    bus.registerLocalHandler(() => {});
    await bus.start(mockPool);
    mockPool.query.mockClear();

    const cyclic: any = { a: 1 };
    cyclic.self = cyclic;
    bus.publish('move', cyclic);

    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it('incoming NOTIFY from a peer invokes local handler', async () => {
    const local = vi.fn();
    bus.registerLocalHandler(local);
    await bus.start(mockPool);

    // Simulate a peer's NOTIFY arriving on our LISTEN client
    const peerMsg = {
      originId: 'peer-instance-uuid',
      event: 'move',
      data: { projectId: 'p1' },
    };
    listenHandlers['notification']?.[0]?.({
      channel: 'velocity_events',
      payload: JSON.stringify(peerMsg),
    });

    expect(local).toHaveBeenCalledWith('move', { projectId: 'p1' });
  });

  it('echo from our own originId is suppressed', async () => {
    const local = vi.fn();
    bus.registerLocalHandler(local);
    await bus.start(mockPool);

    const selfMsg = {
      originId: bus.originId,
      event: 'move',
      data: { projectId: 'p1' },
    };
    listenHandlers['notification']?.[0]?.({
      channel: 'velocity_events',
      payload: JSON.stringify(selfMsg),
    });

    expect(local).not.toHaveBeenCalled();
  });

  it('ignores notifications on a different channel', async () => {
    const local = vi.fn();
    bus.registerLocalHandler(local);
    await bus.start(mockPool);

    listenHandlers['notification']?.[0]?.({
      channel: 'some_other_channel',
      payload: JSON.stringify({ originId: 'x', event: 'move', data: {} }),
    });

    expect(local).not.toHaveBeenCalled();
  });

  it('start() is idempotent — calling twice does not double-LISTEN', async () => {
    await bus.start(mockPool);
    await bus.start(mockPool);
    expect(mockPool.connect).toHaveBeenCalledTimes(1);
  });

  it('NOTIFY failure does not throw', async () => {
    bus.registerLocalHandler(() => {});
    mockPool.query.mockRejectedValue(new Error('db gone'));
    await bus.start(mockPool);
    // Should not throw — bus swallows + logs
    expect(() => bus.publish('move', { projectId: 'p1' })).not.toThrow();
    // Give the rejected promise a tick to settle to avoid unhandled-rejection noise
    await new Promise(r => setImmediate(r));
  });
});
