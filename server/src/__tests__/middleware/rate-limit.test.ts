import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createRateLimiter } from '../../middleware/rate-limit';

describe('rate-limit middleware', () => {
  let app: express.Express;

  beforeEach(() => {
    app = express();

    // Create a rate limiter with 3 requests per 10 seconds for testing
    const limiter = createRateLimiter(3, 10000);

    app.use('/test', limiter, (_req, res) => {
      res.json({ success: true, data: { message: 'ok' } });
    });

    // Error handler
    app.use((err: Error & { statusCode?: number; code?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(err.statusCode || 500).json({
        success: false,
        error: { code: err.code || 'INTERNAL_ERROR', message: err.message },
      });
    });
  });

  it('should allow requests under the limit', async () => {
    const res = await request(app).get('/test');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('should return 429 after exceeding the limit', async () => {
    // Make 3 requests (at the limit)
    for (let i = 0; i < 3; i++) {
      const res = await request(app).get('/test');
      expect(res.status).toBe(200);
    }

    // 4th request should be rate limited
    const res = await request(app).get('/test');
    expect(res.status).toBe(429);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('RATE_LIMIT_EXCEEDED');
  });

  it('should include rate limit headers', async () => {
    const res = await request(app).get('/test');

    expect(res.status).toBe(200);
    // express-rate-limit sets standard headers
    expect(res.headers['ratelimit-limit']).toBeDefined();
    expect(res.headers['ratelimit-remaining']).toBeDefined();
  });

  describe('api-key bucket', () => {
    it('uses a higher ceiling when an API key header is present', async () => {
      const ipApp = express();
      // 1 req/window for IP, 5 req/window for api-key. A caller presenting
      // an X-API-Key should NOT 429 after the IP ceiling is exhausted.
      const limiter = createRateLimiter(1, 10000, { apiKeyMax: 5 });
      ipApp.use('/test', limiter, (_req, res) => res.json({ ok: true }));
      ipApp.use((err: Error & { statusCode?: number; code?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        res.status(err.statusCode || 500).json({ success: false, error: { code: err.code || 'INTERNAL_ERROR' } });
      });

      // 1st api-key request succeeds
      let r = await request(ipApp).get('/test').set('X-API-Key', 'velo_abc123');
      expect(r.status).toBe(200);
      // 2nd through 5th still succeed (api-key bucket allows 5)
      for (let i = 0; i < 4; i++) {
        r = await request(ipApp).get('/test').set('X-API-Key', 'velo_abc123');
        expect(r.status).toBe(200);
      }
      // 6th should 429
      r = await request(ipApp).get('/test').set('X-API-Key', 'velo_abc123');
      expect(r.status).toBe(429);
    });

    it('different API keys are in different buckets', async () => {
      const ipApp = express();
      const limiter = createRateLimiter(1, 10000, { apiKeyMax: 1 });
      ipApp.use('/test', limiter, (_req, res) => res.json({ ok: true }));
      ipApp.use((err: Error & { statusCode?: number; code?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        res.status(err.statusCode || 500).json({ success: false, error: { code: err.code || 'INTERNAL_ERROR' } });
      });

      // Key A uses its single allowance
      let r = await request(ipApp).get('/test').set('X-API-Key', 'velo_keyA');
      expect(r.status).toBe(200);
      r = await request(ipApp).get('/test').set('X-API-Key', 'velo_keyA');
      expect(r.status).toBe(429);

      // Key B still has its own untouched allowance
      r = await request(ipApp).get('/test').set('X-API-Key', 'velo_keyB');
      expect(r.status).toBe(200);
    });
  });
});
