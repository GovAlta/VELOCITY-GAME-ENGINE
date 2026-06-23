import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';

// Load .env from project root (parent of server/)
// Scripts run via "cd server && npm run ..." have cwd set to server/
dotenv.config({ path: path.resolve(process.cwd(), '..', '.env') });
// Fallback: if running from project root
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  DB_POOL_MAX: z.coerce.number().default(50),
  DB_IDLE_TIMEOUT_MS: z.coerce.number().default(30000),
  DB_CONNECTION_TIMEOUT_MS: z.coerce.number().default(5000),
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().default(30000),
  // SSE concurrency caps per identity. Defaults are deliberately generous —
  // tightening to 3-5 is reasonable. Set to 0 to disable a given cap entirely.
  SSE_MAX_PER_API_KEY: z.coerce.number().default(5),
  SSE_MAX_PER_USER: z.coerce.number().default(5),
  SSE_MAX_PER_IP: z.coerce.number().default(5),
  // Per-client SSE write back-pressure. lagScore increments on every write that
  // the kernel couldn't drain; resets on 'drain'. Once >= LAG_SHED_THRESHOLD,
  // low-priority events (clients/progress) are dropped for that one client.
  // Once >= LAG_KILL_THRESHOLD or the connection has been continuously slow
  // for SLOW_MAX_MS, the connection is force-closed so the client can reconnect
  // cleanly without taking the broadcast loop down with it.
  SSE_LAG_SHED_THRESHOLD: z.coerce.number().default(3),
  SSE_LAG_KILL_THRESHOLD: z.coerce.number().default(10),
  SSE_SLOW_MAX_MS: z.coerce.number().default(30_000),
  // Memory-pressure shedder thresholds. Percentages of heapUsed/heapTotal.
  // On Azure App Service set NODE_OPTIONS=--max-old-space-size=2048 so
  // heapTotal has a predictable ceiling, otherwise the percentage is noisy.
  MEM_PRESSURE_AMBER_PCT: z.coerce.number().default(60),
  MEM_PRESSURE_RED_PCT: z.coerce.number().default(80),
  MEM_PRESSURE_SAMPLE_MS: z.coerce.number().default(5_000),
  // Fraction of oldest SSE clients to evict on every transition INTO red.
  // The evicted clients reconnect within seconds; the surviving population
  // gets out from under the pressure that triggered the eviction.
  MEM_PRESSURE_EVICT_FRACTION: z.coerce.number().min(0).max(1).default(0.25),
  // Disable Postgres LISTEN/NOTIFY cross-instance fan-out. Set true for
  // local dev (no need to park a PG connection for a single-instance run)
  // or if you've moved to a different pub/sub. Default false: cross-instance
  // delivery is the correct production behavior under scale-out.
  SSE_DISABLE_CROSS_INSTANCE: z.coerce.boolean().default(false),
  JWT_PRIVATE_KEY: z.string().optional(),
  JWT_PUBLIC_KEY: z.string().optional(),
  JWT_REFRESH_PRIVATE_KEY: z.string().optional(),
  JWT_REFRESH_PUBLIC_KEY: z.string().optional(),
  JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  MICROSOFT_CLIENT_ID: z.string().optional(),
  MICROSOFT_CLIENT_SECRET: z.string().optional(),
  MICROSOFT_TENANT_ID: z.string().optional(),
  MICROSOFT_SUBSCRIPTION_ID: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  AI_PROVIDER: z.string().default('openai'),
  AI_API_KEY: z.string().optional(),
  AI_MODEL: z.string().default('gpt-4o-mini'),
  AI_MAX_TOKENS: z.coerce.number().default(1024),
  API_BASE_URL: z.string().optional(),
  // Git integration
  GITHUB_PAT: z.string().optional(),
  ENCRYPTION_KEY: z.string().min(16).default('velo-dev-encryption-key-change-in-prod-32ch'),
  // LLM providers for project audits
  ANTHROPIC_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  XAI_API_KEY: z.string().optional(),
  // SharePoint integration (Microsoft Graph API)
  SHAREPOINT_APPLICATION_CLIENT_ID: z.string().optional(),
  SHAREPOINT_APPLICATION_CLIENT_SECRET: z.string().optional(),
  SHAREPOINT_APPLICATION_TENANT_ID: z.string().optional(),
  SHAREPOINT_SITE_URL: z.string().optional(),
  SERVE_CLIENT: z.string().optional().default('false'),
  CSRF_SECRET: z.string().min(32).default('dev-csrf-secret-change-in-production-00'),
  // Rate limiting — all configurable via .env
  RATE_LIMIT_API_MAX: z.coerce.number().default(20000),
  RATE_LIMIT_API_WINDOW_MS: z.coerce.number().default(15 * 60 * 1000), // 15 minutes
  // Authenticated API-key callers get a separate, typically higher ceiling.
  // The rate-limit keyGenerator buckets these by api_key hash instead of IP,
  // so legitimate agent fleets sharing a NAT no longer compete for one budget.
  // Set to 0 to fall back to the IP bucket for api-key callers too.
  RATE_LIMIT_API_KEY_MAX: z.coerce.number().default(10000),
  RATE_LIMIT_API_KEY_WINDOW_MS: z.coerce.number().default(60 * 60 * 1000), // 1 hour
  RATE_LIMIT_AUTH_MAX: z.coerce.number().default(3000),
  RATE_LIMIT_AUTH_WINDOW_MS: z.coerce.number().default(15 * 60 * 1000), // 15 minutes
  RATE_LIMIT_AI_MAX: z.coerce.number().default(6000),
  RATE_LIMIT_AI_WINDOW_MS: z.coerce.number().default(60 * 60 * 1000), // 1 hour
  RATE_LIMIT_SP_MUTATION_MAX: z.coerce.number().default(1000),
  RATE_LIMIT_SP_MUTATION_WINDOW_MS: z.coerce.number().default(60 * 60 * 1000), // 1 hour
  // Request body size limits
  BODY_LIMIT_JSON: z.string().default('1mb'),
  BODY_LIMIT_URLENCODED: z.string().default('1mb'),
}).refine((data) => {
  if (data.NODE_ENV === 'production') {
    const envKeys = [data.JWT_PRIVATE_KEY, data.JWT_PUBLIC_KEY, data.JWT_REFRESH_PRIVATE_KEY, data.JWT_REFRESH_PUBLIC_KEY];
    const hasEnvKeys = envKeys.every((k) => k && k.startsWith('-----BEGIN'));
    if (hasEnvKeys) return true;

    // Also accept PEM files in server/keys/ (used for local production testing)
    const keysDir = path.resolve(__dirname, '..', '..', 'keys');
    const keyFiles = ['jwt-private.pem', 'jwt-public.pem', 'jwt-refresh-private.pem', 'jwt-refresh-public.pem'];
    const hasKeyFiles = keyFiles.every((f) => fs.existsSync(path.join(keysDir, f)));
    return hasKeyFiles;
  }
  return true;
}, {
  message: 'JWT PEM keys are required in production. Provide them as env vars (JWT_PRIVATE_KEY, etc.) or generate key files: npm run generate-keys',
});

export type EnvConfig = z.infer<typeof envSchema>;

function loadEnvironment(): EnvConfig {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const errors = parsed.error.flatten();
    const fieldMessages = Object.entries(errors.fieldErrors)
      .map(([field, msgs]) => `  ${field}: ${(msgs || []).join(', ')}`)
      .join('\n');
    const formMessages = errors.formErrors.length > 0
      ? '\n  ' + errors.formErrors.join('\n  ')
      : '';
    throw new Error(`Environment validation failed:\n${fieldMessages}${formMessages}`);
  }

  return parsed.data;
}

export const env = loadEnvironment();

export function validateStartupKeys(): void {
  const jwtKeys = [env.JWT_PRIVATE_KEY, env.JWT_PUBLIC_KEY, env.JWT_REFRESH_PRIVATE_KEY, env.JWT_REFRESH_PUBLIC_KEY];
  const allPresent = jwtKeys.every((k) => k && k.startsWith('-----BEGIN'));

  if (env.NODE_ENV !== 'production' && !allPresent) {
    console.warn(
      '[WARN] JWT PEM keys are missing or incomplete. Generate them with: npm run generate-keys'
    );
  }
}
