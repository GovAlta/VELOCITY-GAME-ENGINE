import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { getHealth, getLiveness, getReadiness } from '../../controllers/health.controller';

// Mock the database module
vi.mock('../../config/database', () => ({
  pool: {
    query: vi.fn(),
    connect: vi.fn(),
  },
}));

// Import the mock after mocking
import { pool } from '../../config/database';

function createApp() {
  const app = express();
  app.get('/health', getHealth);
  app.get('/health/live', getLiveness);
  app.get('/health/ready', getReadiness);
  return app;
}

describe('Health Controller', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /health', () => {
    it('should return success with status ok', async () => {
      const app = createApp();
      const response = await request(app).get('/health');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.status).toBe('ok');
    });
  });

  describe('GET /health/live', () => {
    it('should return success with status alive', async () => {
      const app = createApp();
      const response = await request(app).get('/health/live');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.status).toBe('alive');
    });
  });

  describe('GET /health/ready', () => {
    it('should return ready when database is connected', async () => {
      (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [{ '?column?': 1 }] });

      const app = createApp();
      const response = await request(app).get('/health/ready');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.status).toBe('ready');
      expect(response.body.data.dependencies.database.status).toBe('connected');
      expect(pool.query).toHaveBeenCalledWith('SELECT 1');
    });

    it('should return 503 when database connection fails', async () => {
      (pool.query as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Connection refused'));

      const app = createApp();
      const response = await request(app).get('/health/ready');

      expect(response.status).toBe(503);
      expect(response.body.status).toBe('not_ready');
      expect(response.body.dependencies.database.status).toBe('disconnected');
    });
  });
});
