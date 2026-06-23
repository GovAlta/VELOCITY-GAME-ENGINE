import { createServer } from 'http';
import { app } from './app';
import { env, validateStartupKeys } from './config/environment';
import { createSocketServer, closeSocketServer } from './websocket';
import { testConnection, closePool } from './config/database';
import * as aiQueue from './services/ai-processing-queue.service';
import { cleanupExpiredIdempotency } from './middleware/idempotency';
import { memoryPressure } from './utils/memory-pressure';
import './sse/velocity-stream'; // wires its own memory-pressure + cross-instance listener
import { crossInstanceBus, isCrossInstanceDisabled } from './sse/cross-instance-bus';
import { pool } from './config/database';
import logger from './utils/logger';

validateStartupKeys();

// ─── Memory-pressure shedder ──────────────────────────────
// Self-healing back-pressure. The SSE controller + AI queue consult
// memoryPressure.isAmberOrWorse() to shed new work before the heap OOMs.
// On RED transitions, velocity-stream evicts the oldest fraction of SSE
// clients so the broadcast loop's write back-pressure drops with them.
memoryPressure.start();

const PORT = env.PORT;

// Create HTTP server wrapping Express app (needed for Socket.io)
const httpServer = createServer(app);

// Attach Socket.io to HTTP server
createSocketServer(httpServer);

// Test database connection on startup, then initialize AI processing queue
// and the cross-instance SSE bus (Postgres LISTEN/NOTIFY).
testConnection().then(async (ok) => {
  if (ok) {
    logger.info('Database connection verified');
    await aiQueue.initialize();
    if (isCrossInstanceDisabled()) {
      logger.info('Cross-instance SSE bus disabled by env (SSE_DISABLE_CROSS_INSTANCE=true)');
    } else {
      await crossInstanceBus.start(pool);
    }
  } else {
    logger.warn('Database connection failed — API queries will fail');
  }
});

// Idempotency-key cleanup runs hourly. 24h TTL on velocity_idempotency rows;
// hourly cadence keeps the table small without churn. Errors logged + swallowed.
const idempotencyCleanupTimer = setInterval(() => {
  cleanupExpiredIdempotency()
    .then(deleted => {
      if (deleted > 0) logger.info('Idempotency cleanup', { deleted });
    })
    .catch(err => logger.warn('Idempotency cleanup failed', { error: (err as Error).message }));
}, 60 * 60 * 1000);
idempotencyCleanupTimer.unref?.();

const server = httpServer.listen(PORT, () => {
  logger.info(`Velo API`);
  logger.info(`Environment: ${env.NODE_ENV}`);
  logger.info(`Listening on port ${PORT}`);
  logger.info(`API:          http://localhost:${PORT}/api`);
  logger.info(`Health check: http://localhost:${PORT}/health`);
  logger.info(`WebSocket:    ws://localhost:${PORT}/ai`);
  if (env.NODE_ENV === 'production' || env.SERVE_CLIENT === 'true') {
    logger.info(`Client:       http://localhost:${PORT}/`);
  } else {
    logger.info(`Client:       http://localhost:5175/ (Vite dev server)`);
  }
});

// Graceful shutdown — close WebSocket, HTTP server, then DB pool
const shutdown = async (signal: string) => {
  logger.info(`${signal} received. Shutting down gracefully...`);

  try {
    // 1. Stop AI processing queue (let in-flight jobs finish)
    await aiQueue.shutdown();
    logger.info('AI processing queue stopped.');
  } catch (err) {
    logger.error('Error stopping AI queue:', { error: (err as Error).message });
  }

  try {
    // 1b. Release the parked PG LISTENer used for cross-instance SSE.
    await crossInstanceBus.stop();
    logger.info('Cross-instance SSE bus stopped.');
  } catch (err) {
    logger.error('Error stopping cross-instance bus:', { error: (err as Error).message });
  }

  try {
    // 2. Disconnect all WebSocket clients first (prevents them from keeping server alive)
    await closeSocketServer();
    logger.info('WebSocket connections closed.');
  } catch (err) {
    logger.error('Error closing WebSocket:', { error: (err as Error).message });
  }

  // 2. Close HTTP server (stops accepting new connections)
  server.close(async () => {
    logger.info('HTTP server closed.');
    try {
      await closePool();
      logger.info('Database pool closed.');
    } catch (err) {
      logger.error('Error closing database pool:', { error: (err as Error).message });
    }
    process.exit(0);
  });

  // Force shutdown after configurable timeout (default 30s)
  const shutdownTimeout = parseInt(process.env.SHUTDOWN_TIMEOUT_MS || '30000', 10);
  setTimeout(() => {
    logger.error('Forced shutdown after timeout.');
    process.exit(1);
  }, shutdownTimeout);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Process-level error handlers — prevent silent crashes
process.on('unhandledRejection', (reason: unknown) => {
  logger.error('Unhandled promise rejection — initiating graceful shutdown', {
    error: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
  shutdown('unhandledRejection');
});

process.on('uncaughtException', (error: Error) => {
  logger.error('Uncaught exception — initiating graceful shutdown', {
    error: error.message,
    stack: error.stack,
  });
  // Uncaught exceptions leave the process in an undefined state — graceful shutdown
  shutdown('uncaughtException');
});

export default server;
