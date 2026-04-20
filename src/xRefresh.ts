#!/usr/bin/env node
/**
 * Rotate the X API access token using the stored refresh token.
 *
 * Reads X_CLIENT_ID + X_CLIENT_SECRET + X_REFRESH_TOKEN from .env.local,
 * hits POST /2/oauth2/token with grant_type=refresh_token, writes the new
 * access + refresh tokens (X rotates both on each refresh) back to .env.local.
 *
 * Usage patterns:
 *   - CLI: `pnpm x:refresh`  — one-off manual rotate (useful for testing)
 *   - Programmatic: `import { refreshAccessToken } from './xRefresh.js'` from
 *     xApiClient so it can auto-refresh on 401.
 *
 * If this script fails (typically because the refresh token itself has been
 * revoked or expired), re-run `pnpm x:auth` to bootstrap fresh tokens.
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ENV_FILE = path.resolve(process.cwd(), '.env.local');
const TOKEN_URL = 'https://api.x.com/2/oauth2/token';

type EnvMap = Record<string, string>;

function parseEnv(content: string): { map: EnvMap; lines: string[] } {
  const lines = content.split('\n');
  const map: EnvMap = {};
  for (const line of lines) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) map[m[1]] = m[2];
  }
  return { map, lines };
}

function upsertEnvLines(lines: string[], updates: EnvMap): string[] {
  const result = [...lines];
  const seen = new Set<string>();
  for (let i = 0; i < result.length; i++) {
    const m = result[i].match(/^([A-Z_][A-Z0-9_]*)=/);
    if (m && updates[m[1]] !== undefined) {
      result[i] = `${m[1]}=${updates[m[1]]}`;
      seen.add(m[1]);
    }
  }
  for (const [k, v] of Object.entries(updates)) {
    if (!seen.has(k)) result.push(`${k}=${v}`);
  }
  return result;
}

export interface RefreshResult {
  accessToken: string;
  refreshToken: string;
  expiresAt: string; // ISO 8601
  scope: string;
}

/**
 * Exchange the stored refresh_token for a new access_token (and usually a new
 * refresh_token — X rotates refresh tokens on each use). Writes the new values
 * back to .env.local and returns them.
 *
 * Throws if the refresh fails. Callers (e.g. xApiClient on 401) should fall
 * back to re-bootstrap (pnpm x:auth) on failure.
 */
export async function refreshAccessToken(): Promise<RefreshResult> {
  const envContent = await readFile(ENV_FILE, 'utf8');
  const { map: env, lines } = parseEnv(envContent);

  const clientId = env.X_CLIENT_ID;
  const clientSecret = env.X_CLIENT_SECRET;
  const refreshToken = env.X_REFRESH_TOKEN;

  if (!clientId || !clientSecret) {
    throw new Error('X_CLIENT_ID and X_CLIENT_SECRET must be set in .env.local');
  }
  if (!refreshToken) {
    throw new Error('X_REFRESH_TOKEN is empty. Run `pnpm x:auth` to bootstrap.');
  }

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId, // required per X docs even with Basic auth
  });

  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Refresh failed: ${resp.status} ${errText}`);
  }

  const json = (await resp.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope: string;
    token_type: string;
  };

  // X rotates the refresh_token on each use; fall back to the old one if
  // somehow absent from the response (shouldn't happen, but safety).
  const newRefresh = json.refresh_token ?? refreshToken;
  const expiresAt = new Date(Date.now() + json.expires_in * 1000).toISOString();

  const updated = upsertEnvLines(lines, {
    X_BEARER_TOKEN: json.access_token,
    X_REFRESH_TOKEN: newRefresh,
    X_TOKEN_EXPIRES_AT: expiresAt,
  });
  await writeFile(ENV_FILE, updated.join('\n'), 'utf8');

  return {
    accessToken: json.access_token,
    refreshToken: newRefresh,
    expiresAt,
    scope: json.scope,
  };
}

// CLI entry — only runs when invoked directly via `pnpm x:refresh`.
async function main() {
  console.log('[x:refresh] Rotating access token...');
  const result = await refreshAccessToken();
  console.log('[x:refresh] ✓ Success.');
  console.log(`            New access token expires: ${result.expiresAt}`);
  console.log(`            Scopes:  ${result.scope}`);
  console.log('            .env.local updated.');
}

// Detect whether this file is being executed directly (CLI) vs. imported.
// tsx loads via ESM, so compare import.meta.url to process.argv[1].
const isDirectInvocation =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('xRefresh.ts') ||
  process.argv[1]?.endsWith('xRefresh.js');

if (isDirectInvocation) {
  main().catch((err: unknown) => {
    console.error('[x:refresh] Fatal:', err instanceof Error ? err.message : err);
    console.error('            If the refresh token is expired/revoked, run `pnpm x:auth`.');
    process.exit(1);
  });
}
