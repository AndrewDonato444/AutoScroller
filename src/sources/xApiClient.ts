/**
 * X API v2 HTTP client — the single place ScrollProxy talks to X.
 *
 * Responsibilities:
 *   - Carry the user access token on every request
 *   - Auto-refresh tokens near expiry (proactive) or on 401 (reactive)
 *   - Exponential backoff on 5xx (transient server errors)
 *   - Respect 429 Retry-After / x-rate-limit-reset
 *   - Type-safe GET with query params
 *
 * All higher-level sources (xListSource, xBookmarksSource) call through here.
 * This keeps retry + auth discipline in one place rather than spread across
 * endpoint wrappers.
 *
 * Design choice: module-level state (singleton) rather than a class. Matches
 * the rest of AutoScroller's functional style and keeps the token-cache
 * semantics obvious (one process, one cached token).
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { refreshAccessToken } from '../xRefresh.js';

const ENV_FILE = path.resolve(process.cwd(), '.env.local');
const DEFAULT_BASE_URL = 'https://api.x.com/2';

/** If the cached token expires in less than this many ms, refresh proactively. */
const PROACTIVE_REFRESH_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes
/** Max backoff retries for transient (5xx) failures. */
const MAX_RETRIES = 3;
/** Initial backoff in ms (doubles each retry). */
const INITIAL_BACKOFF_MS = 500;

interface TokenState {
  accessToken: string;
  expiresAt: Date;
}

let cachedToken: TokenState | null = null;

/** Clear the in-memory token cache. Useful in tests; rarely needed in practice. */
export function resetClient(): void {
  cachedToken = null;
}

/** Read a single key from .env.local without touching process.env. */
async function readEnvKey(key: string): Promise<string | null> {
  const content = await readFile(ENV_FILE, 'utf8');
  for (const line of content.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && m[1] === key) return m[2] || null;
  }
  return null;
}

async function loadTokenFromEnv(): Promise<TokenState> {
  const accessToken = await readEnvKey('X_BEARER_TOKEN');
  const expiresAtStr = await readEnvKey('X_TOKEN_EXPIRES_AT');
  if (!accessToken) {
    throw new Error('X_BEARER_TOKEN is empty in .env.local. Run `pnpm x:auth`.');
  }
  const expiresAt = expiresAtStr ? new Date(expiresAtStr) : new Date(0);
  return { accessToken, expiresAt };
}

/**
 * Get a valid access token, refreshing if near expiry. Callers should call
 * this before every request rather than caching the token themselves — it
 * handles all the lifecycle concerns.
 */
async function getValidToken(): Promise<string> {
  if (!cachedToken) {
    cachedToken = await loadTokenFromEnv();
  }
  const msUntilExpiry = cachedToken.expiresAt.getTime() - Date.now();
  if (msUntilExpiry < PROACTIVE_REFRESH_THRESHOLD_MS) {
    const refreshed = await refreshAccessToken();
    cachedToken = {
      accessToken: refreshed.accessToken,
      expiresAt: new Date(refreshed.expiresAt),
    };
  }
  return cachedToken.accessToken;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Wait at least this long before next request, per 429 Retry-After or x-rate-limit-reset headers. */
function computeRateLimitWaitMs(resp: Response): number {
  const retryAfter = resp.headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (!Number.isNaN(seconds)) return seconds * 1000;
  }
  const reset = resp.headers.get('x-rate-limit-reset');
  if (reset) {
    const resetEpoch = Number(reset);
    if (!Number.isNaN(resetEpoch)) {
      const waitMs = resetEpoch * 1000 - Date.now();
      if (waitMs > 0) return waitMs;
    }
  }
  // Fallback: wait 15s if no usable header.
  return 15_000;
}

export interface XGetOptions {
  baseUrl?: string;
  /** Internal — set by retry logic when re-invoking after 401 refresh. */
  _didRefresh?: boolean;
}

/**
 * Typed GET against the X API. Handles auth, token refresh, rate limits,
 * and transient retries. Throws on non-recoverable errors (4xx other than
 * 401/429 after refresh).
 */
export async function xGet<T = unknown>(
  path: string,
  params: Record<string, string> = {},
  opts: XGetOptions = {}
): Promise<T> {
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const url = new URL(baseUrl + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const token = await getValidToken();

  let lastErr: unknown;
  let backoff = INITIAL_BACKOFF_MS;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let resp: Response;
    try {
      resp = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (err) {
      // Network-level failure — retry with backoff.
      lastErr = err;
      if (attempt === MAX_RETRIES) break;
      await sleep(backoff);
      backoff *= 2;
      continue;
    }

    // 401 — try one refresh + retry, then give up.
    if (resp.status === 401 && !opts._didRefresh) {
      resetClient(); // force re-read from disk (xRefresh wrote fresh values)
      await refreshAccessToken();
      return xGet<T>(path, params, { ...opts, _didRefresh: true });
    }

    // 429 — respect rate limit headers and retry.
    if (resp.status === 429) {
      if (attempt === MAX_RETRIES) {
        throw new Error(`Rate limited after ${MAX_RETRIES + 1} attempts on ${path}`);
      }
      await sleep(computeRateLimitWaitMs(resp));
      continue;
    }

    // 5xx — transient, back off and retry.
    if (resp.status >= 500 && resp.status < 600) {
      if (attempt === MAX_RETRIES) {
        const body = await resp.text();
        throw new Error(`X API ${resp.status} after ${MAX_RETRIES + 1} attempts on ${path}: ${body}`);
      }
      await sleep(backoff);
      backoff *= 2;
      continue;
    }

    // Other 4xx — non-recoverable, throw with detail.
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`X API ${resp.status} on ${path}: ${body}`);
    }

    // Success.
    return (await resp.json()) as T;
  }

  throw new Error(
    `X API request failed on ${path} after ${MAX_RETRIES + 1} attempts. Last error: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`
  );
}

/** Convenience: GET /users/me. Handy for health checks. */
export async function getAuthenticatedUser(): Promise<{
  data: { id: string; name: string; username: string };
}> {
  return xGet('/users/me');
}
