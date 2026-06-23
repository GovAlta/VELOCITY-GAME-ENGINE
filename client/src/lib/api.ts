import axios from 'axios'
import type { AxiosInstance, InternalAxiosRequestConfig, AxiosError } from 'axios'

const api: AxiosInstance = axios.create({
  baseURL: '/api/v1',
  timeout: 300_000,
  withCredentials: true,
  headers: {
    'Content-Type': 'application/json',
  },
})

let csrfToken: string | null = null

export async function fetchCsrfToken(): Promise<void> {
  try {
    const res = await fetch('/api/v1/auth/csrf', { credentials: 'include' })
    if (!res.ok) return
    const data = await res.json()
    csrfToken = data.data?.csrfToken || data.csrfToken || data.data?.token || data.token || null
  } catch {
    csrfToken = null
  }
}

// Attach CSRF token and request ID to every request
api.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  config.headers['X-Request-ID'] = crypto.randomUUID()
  if (csrfToken && config.method !== 'get') {
    config.headers.set('X-CSRF-Token', csrfToken)
  }
  return config
})

// ── Queuing for token refresh (prevents thundering herd) ──
let isRefreshingAuth = false
let isRefreshingCsrf = false
let authQueue: Array<() => void> = []
let csrfQueue: Array<() => void> = []

function drainQueue(queue: Array<() => void>) {
  queue.forEach((cb) => cb())
  queue.length = 0
}

// Retry config for extended types
interface RetryConfig {
  _retried?: boolean
  _csrfRetried?: boolean
  _retryCount?: number
}

const MAX_429_RETRIES = 5

api.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const original = error.config
    if (!original || !error.response) return Promise.reject(error)

    const status = error.response.status
    const retryable = original as InternalAxiosRequestConfig & RetryConfig

    // ── 429: Rate limited → exponential backoff with jitter ──
    if (status === 429) {
      const retryCount = retryable._retryCount || 0
      if (retryCount >= MAX_429_RETRIES) {
        return Promise.reject(error)
      }
      retryable._retryCount = retryCount + 1

      // Check Retry-After header (seconds) or use exponential backoff
      const retryAfter = error.response.headers?.['retry-after']
      const backoffMs = retryAfter
        ? parseInt(retryAfter, 10) * 1000
        : Math.min(1000 * Math.pow(2, retryCount), 60000) + Math.random() * 2000

      console.warn(`[api] 429 rate limited — retry ${retryCount + 1}/${MAX_429_RETRIES} in ${Math.round(backoffMs)}ms`)
      await new Promise(r => setTimeout(r, backoffMs))
      return api(retryable)
    }

    // ── 401: JWT expired → refresh token, queue concurrent requests ──
    if (status === 401 && !retryable._retried) {
      if (isRefreshingAuth) {
        return new Promise((resolve) => {
          authQueue.push(() => resolve(api(original)))
        })
      }
      isRefreshingAuth = true
      retryable._retried = true
      try {
        await api.post('/auth/refresh')
        drainQueue(authQueue)
        return api(original)
      } catch {
        drainQueue(authQueue)
        window.dispatchEvent(new CustomEvent('auth:expired'))
        return Promise.reject(error)
      } finally {
        isRefreshingAuth = false
      }
    }

    // ── 403: CSRF expired → fetch new token, queue concurrent requests ──
    if (status === 403 && !retryable._csrfRetried) {
      const body = error.response.data as Record<string, unknown> | undefined
      const errCode = (body?.error as Record<string, unknown>)?.code || body?.code
      if (errCode === 'CSRF_MISSING' || errCode === 'CSRF_MISMATCH' || !errCode) {
        retryable._csrfRetried = true

        if (isRefreshingCsrf) {
          return new Promise((resolve) => {
            csrfQueue.push(() => {
              if (csrfToken) retryable.headers.set('X-CSRF-Token', csrfToken)
              resolve(api(retryable))
            })
          })
        }

        isRefreshingCsrf = true
        try {
          await fetchCsrfToken()
          if (csrfToken) {
            retryable.headers.set('X-CSRF-Token', csrfToken)
          }
          drainQueue(csrfQueue)
          return api(retryable)
        } catch {
          drainQueue(csrfQueue)
          return Promise.reject(error)
        } finally {
          isRefreshingCsrf = false
        }
      }
    }

    // ── 502/503/504: Server temporarily unavailable → retry once after delay ──
    if ([502, 503, 504].includes(status) && !retryable._retried) {
      retryable._retried = true
      await new Promise(r => setTimeout(r, 2000 + Math.random() * 1000))
      return api(retryable)
    }

    return Promise.reject(error)
  },
)

export default api
