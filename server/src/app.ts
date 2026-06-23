import express from 'express';
import path from 'path';
import fs from 'fs';
import compression from 'compression';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import passport from 'passport';
import { env } from './config/environment';
import logger from './utils/logger';
import { correlationId } from './middleware/correlation-id';
import { errorHandler } from './middleware/error-handler';
import { apiRateLimiter } from './middleware/rate-limit';
import { configurePassport } from './config/auth';
import healthRoutes from './routes/health.routes';
import authRoutes from './routes/auth.routes';
import resourceRoutes from './routes/resource.routes';
import serviceLocationRoutes from './routes/service-location.routes';
import serviceRoutes from './routes/service.routes';
import formRoutes from './routes/form.routes';
import submissionRoutes from './routes/submission.routes';
import fileRoutes from './routes/file.routes';
import notificationRoutes from './routes/notification.routes';
import subscriptionRoutes from './routes/subscription.routes';
import aiRoutes from './routes/ai.routes';
import adminRoutes from './routes/admin.routes';
import landingRoutes from './routes/landing.routes';
import projectRoutes from './routes/project.routes';
import ministryRoutes from './routes/ministry.routes';
import apiKeyRoutes from './routes/api-key.routes';
import personRoutes from './routes/person.routes';
import canvasRoutes from './routes/canvas.routes';
import applicationRoutes from './routes/application.routes';
import contractRoutes from './routes/contract.routes';
import velocityRoutes from './routes/velocity.routes';
import gitRoutes from './routes/git.routes';
import auditRoutes from './routes/audit.routes';
import settingsRoutes from './routes/settings.routes';
import sharepointRoutes from './routes/sharepoint.routes';
import userManagementRoutes from './routes/user-management.routes';
import leaderboardRoutes from './routes/leaderboard.routes';
import { apiKeyAuth } from './middleware/api-key-auth';

const app = express();

// ─── Trust Proxy ───────────────────────────────────────────
// Required for Render.com, Azure App Service, or any reverse proxy deployment.
// Enables correct req.ip, req.protocol, and secure cookie behavior behind a load balancer.
// Always enabled — safe even without a proxy (just uses direct connection info).
//
// Load balancer / horizontal scaling compatibility:
// - Cookies use sameSite: 'lax' which works correctly behind load balancers
// - CSRF double-submit pattern is stateless — no shared state needed between instances
// - JWT auth is stateless — no session store required
// - trust proxy ensures req.ip and req.protocol reflect the real client, not the LB
app.set('trust proxy', 1);

// ─── Security Headers (Helmet) ─────────────────────────────
// The design system requires: Google Fonts (fonts.googleapis.com, fonts.gstatic.com)
// and Adobe Typekit (use.typekit.net, p.typekit.net) for its typography.
// Some UI components use inline event handlers, requiring script-src-attr 'unsafe-inline'.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      // @abgov/web-components v1.41+ no longer requires 'unsafe-eval' (verified by source audit)
      scriptSrc: ["'self'", "'unsafe-inline'"],
      scriptSrcElem: ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://p.typekit.net", "https://use.typekit.net"],
      styleSrcElem: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://p.typekit.net", "https://use.typekit.net"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "https://use.typekit.net", "data:"],
      imgSrc: ["'self'", "data:", "https:", "blob:", "https://*.tile.openstreetmap.org"],
      connectSrc: ["'self'", "ws:", "wss:", "https://p.typekit.net", "https://*.tile.openstreetmap.org"],
      frameSrc: ["'none'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
    },
  },
  // HSTS: 1 year with preload — tells browsers to always use HTTPS
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true,
  },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));

// ─── Permissions-Policy Header ──────────────────────────────
// Restricts browser features not needed by this application.
app.use((_req, res, next) => {
  res.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), magnetometer=(), gyroscope=(), accelerometer=()'
  );
  next();
});

// ─── Compression ────────────────────────────────────────────
// gzip/brotli compression for all responses (HTML, JS, CSS, JSON).
// SSE streams are excluded — compression buffers chunks which breaks real-time delivery.
app.use(compression({
  filter: (req, res) => {
    if (req.headers.accept === 'text/event-stream') return false;
    return compression.filter(req, res);
  },
}));

// ─── Static File Serving (before CORS) ──────────────────────
// Static assets are served BEFORE CORS middleware because <script type="module">
// and CSS @import send Origin headers even for same-origin requests.
// These are first-party assets — they don't need CORS headers.
const clientDistPath = path.resolve(__dirname, '..', '..', 'client', 'dist');
const clientIndexPath = path.join(clientDistPath, 'index.html');
const shouldServeClient =
  env.NODE_ENV === 'production' ||
  env.SERVE_CLIENT === 'true';

if (shouldServeClient) {
  app.use(express.static(clientDistPath, {
    maxAge: env.NODE_ENV === 'production' ? '1y' : '0',
    immutable: env.NODE_ENV === 'production',
    index: false,
  }));
}

// ─── CORS ──────────────────────────────────────────────────
// Supports multiple origins via comma-separated CORS_ORIGIN env var.
// Example: CORS_ORIGIN=https://app.example.com,https://staging.example.com
const allowedOrigins: string[] = env.CORS_ORIGIN
  .split(',')
  .map((o: string) => o.trim())
  .filter(Boolean);

const corsOptions: cors.CorsOptions = {
  origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
    // Allow requests with no origin (server-to-server, Postman, health checks)
    if (!origin) {
      callback(null, true);
      return;
    }
    // Allow any configured origin
    if (allowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }
    // In development, allow any localhost origin regardless of port
    if (env.NODE_ENV === 'development' && /^https?:\/\/localhost(:\d+)?$/.test(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token', 'X-Correlation-ID', 'X-Requested-With', 'X-API-Key', 'X-Request-ID'],
  exposedHeaders: ['X-Correlation-ID', 'X-CSRF-Token'],
};
app.use(cors(corsOptions));

// ─── Global API Rate Limiting ──────────────────────────────
// Applied to all /api routes as a baseline. Route-specific rate limiters
// (auth, AI) may apply stricter limits on top of this.
app.use('/api', apiRateLimiter);

// ─── Content-Type Validation ────────────────────────────────
// Reject requests with unexpected Content-Type on state-changing methods (415 Unsupported Media Type).
// File uploads (multipart/form-data) and SSE streams are excluded.
app.use((req, res, next) => {
  if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
    const ct = req.headers['content-type'] || '';
    if (ct && !ct.includes('application/json') && !ct.includes('application/x-www-form-urlencoded') && !ct.includes('multipart/form-data')) {
      res.status(415).json({ success: false, error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Content-Type must be application/json, application/x-www-form-urlencoded, or multipart/form-data' } });
      return;
    }
  }
  next();
});

// ─── Body Parsing ──────────────────────────────────────────
// SharePoint "blank file" creation accepts a typed-in document body that can
// legitimately be hundreds of megabytes (matches the individual file-upload
// ceiling). Mount a higher-limit JSON parser for just those endpoints BEFORE
// the global parser — once express.json() succeeds it marks the body as
// parsed, so the global parser below becomes a no-op.
const blankFileJson = express.json({ limit: '260mb' });
app.use((req, res, next) => {
  const p = req.path;
  if (
    (req.method === 'POST' && /\/sharepoint\/(?:folders|items)\/[^/]+\/blank-file$/.test(p)) ||
    (req.method === 'PUT' && /\/sharepoint\/files\/[^/]+\/content$/.test(p))
  ) {
    return blankFileJson(req, res, next);
  }
  next();
});
app.use(express.json({ limit: env.BODY_LIMIT_JSON }));
app.use(express.urlencoded({ extended: true, limit: env.BODY_LIMIT_URLENCODED }));

// ─── Cookie Parser ─────────────────────────────────────────
app.use(cookieParser());

// ─── Correlation ID ────────────────────────────────────────
app.use(correlationId);

// ─── Request Logging ───────────────────────────────────────
// Structured request logger using Winston
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    const meta = {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      correlationId: req.headers['x-correlation-id'] || undefined,
    };

    if (duration > 1000) {
      logger.warn(`Slow request: ${req.method} ${req.path} ${res.statusCode} ${duration}ms`, meta);
    } else {
      logger.info(`${req.method} ${req.path} ${res.statusCode} ${duration}ms`, meta);
    }
  });
  next();
});

// ─── Passport (JWT-based, no sessions) ─────────────────────
configurePassport();
app.use(passport.initialize());

// ─── API Routes ────────────────────────────────────────────
// All API routes are mounted under /api/v1/ (versioned) and /api/ (backward-compatible alias).
// When a v2 is needed, add new routes under /api/v2/ without breaking existing clients.

// Health check (no auth, no versioning)
app.use('/', healthRoutes);

// Version 1 API routes
const v1Routes = express.Router();
v1Routes.use('/auth', authRoutes);
v1Routes.use('/resources', resourceRoutes);
v1Routes.use('/service-locations', serviceLocationRoutes);
v1Routes.use('/services', serviceRoutes);
v1Routes.use('/landing', landingRoutes);
v1Routes.use('/forms', formRoutes);
v1Routes.use('/submissions', submissionRoutes);
v1Routes.use('/files', fileRoutes);
v1Routes.use('/notifications', notificationRoutes);
v1Routes.use('/subscriptions', subscriptionRoutes);
v1Routes.use('/ai', aiRoutes);
v1Routes.use('/admin', adminRoutes);
v1Routes.use('/projects', apiKeyAuth, projectRoutes);
v1Routes.use('/ministries', apiKeyAuth, ministryRoutes);
v1Routes.use('/api-keys', apiKeyRoutes);
v1Routes.use('/persons', apiKeyAuth, personRoutes);
v1Routes.use('/canvas', apiKeyAuth, canvasRoutes);
v1Routes.use('/applications', apiKeyAuth, applicationRoutes);
v1Routes.use('/contracts', apiKeyAuth, contractRoutes);
v1Routes.use('/velocity', apiKeyAuth, velocityRoutes);
v1Routes.use('/git', apiKeyAuth, gitRoutes);
v1Routes.use('/projects', apiKeyAuth, auditRoutes);
v1Routes.use('/settings', apiKeyAuth, settingsRoutes);
v1Routes.use('/sharepoint', apiKeyAuth, sharepointRoutes);
v1Routes.use('/users', apiKeyAuth, userManagementRoutes);
v1Routes.use('/leaderboard', apiKeyAuth, leaderboardRoutes);
v1Routes.use('/', apiKeyAuth, leaderboardRoutes); // mounts /challenges at root level

// API documentation endpoint
v1Routes.get('/docs', (_req, res) => {
  res.sendFile(path.resolve(__dirname, '..', 'openapi.yaml'));
});

// Meta / drift-detection endpoint — exposes the same artifact identifiers the
// docs-sync checker reads. Lets ops + agents detect docs drift in production,
// not just at build time. Public on purpose: returns no PII or secrets.
v1Routes.get('/_meta/sync', async (_req, res) => {
  try {
    const fs = await import('node:fs');
    const migrationsDir = path.resolve(__dirname, '..', 'migrations');
    const migrationCount = fs.readdirSync(migrationsDir)
      .filter((f: string) => /^\d{3}_.*\.sql$/.test(f))
      .length;

    const openapiPath = path.resolve(__dirname, '..', 'openapi.yaml');
    let openapiVersion: string | null = null;
    let openapiPathCount: number | null = null;
    try {
      const text = fs.readFileSync(openapiPath, 'utf8');
      openapiVersion = text.match(/^\s*version:\s*(\d+\.\d+\.\d+)/m)?.[1] ?? null;
      // Cheap path counter: count "  /" prefixed lines after the `paths:` key
      const pathsIdx = text.indexOf('\npaths:');
      if (pathsIdx >= 0) {
        const after = text.slice(pathsIdx);
        openapiPathCount = (after.match(/\n\s{2}\/[A-Za-z]/g) || []).length;
      }
    } catch { /* ignore — meta endpoint should never fail */ }

    res.json({
      success: true,
      data: {
        nodeVersion: process.version,
        env: process.env.NODE_ENV || 'unknown',
        startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
        artifacts: {
          migrationsOnDisk: migrationCount,
          openapiVersion,
          openapiPathCount,
          // Static — bumped only when the agent guide is regenerated
          claudeMdPresent: fs.existsSync(path.resolve(__dirname, 'static', 'CLAUDE.md')),
        },
      },
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: { code: 'META_SYNC_FAILED', message: (err as Error).message },
    });
  }
});

// Mount versioned routes
app.use('/api/v1', v1Routes);

// Backward-compatible alias: /api/* maps to /api/v1/*
app.use('/api', v1Routes);

// ─── SPA Fallback ─────────────────────────────────────────
// Non-API GET routes serve index.html for Vue Router (client-side routing).
// Must be after API routes so /api/* is handled by Express, not the SPA.
if (shouldServeClient) {
  const spaFallback: express.RequestHandler = (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/health') || req.path.startsWith('/socket.io')) {
      return next();
    }
    res.sendFile(clientIndexPath);
  };

  const expressMajor = parseInt((express as any).version?.split('.')[0] || '4', 10);
  if (expressMajor >= 5) {
    app.get('/{*splat}', spaFallback);
  } else {
    app.get('*', spaFallback);
  }
}

// ─── Global Error Handler (must be last) ───────────────────
app.use(errorHandler);

export { app };
