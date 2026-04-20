#!/usr/bin/env node
/**
 * One-shot OAuth 2.0 PKCE bootstrap for X API owned-reads access.
 *
 * Reads X_CLIENT_ID + X_CLIENT_SECRET from .env.local, runs the browser
 * authorization flow against the user's own X account, exchanges the
 * resulting code for access + refresh tokens, writes them back to
 * .env.local, and verifies with a test call to GET /2/users/me.
 *
 * Usage: pnpm x:auth (run once to bootstrap; re-run any time a fresh
 * authorization is needed, e.g. after revoking the app).
 *
 * Runtime token rotation (for expired access tokens) uses a separate
 * refresh flow — not this script.
 */

import crypto from 'node:crypto';
import http from 'node:http';
import { exec } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ENV_FILE = path.resolve(process.cwd(), '.env.local');
const REDIRECT_URI = 'http://localhost:8787/callback';
const CALLBACK_PORT = 8787;
const SCOPES = [
  'tweet.read',
  'users.read',
  'list.read',
  'bookmark.read',
  'offline.access', // required to receive a refresh_token
];
const AUTHORIZE_URL = 'https://x.com/i/oauth2/authorize';
const TOKEN_URL = 'https://api.x.com/2/oauth2/token';
const ME_URL = 'https://api.x.com/2/users/me';

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

/** Updates existing KEY= lines in place; appends any keys not already present. */
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

function pkce(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

async function waitForCode(expectedState: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const reqUrl = new URL(req.url ?? '/', `http://localhost:${CALLBACK_PORT}`);
      if (reqUrl.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      const returnedState = reqUrl.searchParams.get('state');
      const returnedCode = reqUrl.searchParams.get('code');
      const error = reqUrl.searchParams.get('error');
      const errorDescription = reqUrl.searchParams.get('error_description');

      const respondAndClose = (status: number, html: string) => {
        res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        server.close();
      };

      if (error) {
        respondAndClose(400, `<h1>Authorization failed</h1><p>${error}${errorDescription ? ': ' + errorDescription : ''}</p><p>You can close this tab.</p>`);
        reject(new Error(`authorization error: ${error}${errorDescription ? ' — ' + errorDescription : ''}`));
        return;
      }
      if (returnedState !== expectedState) {
        respondAndClose(400, '<h1>State mismatch — aborting (possible CSRF).</h1>');
        reject(new Error('state mismatch'));
        return;
      }
      if (!returnedCode) {
        respondAndClose(400, '<h1>No authorization code returned.</h1>');
        reject(new Error('no code returned'));
        return;
      }

      respondAndClose(
        200,
        '<h1>Authorized ✓</h1><p>You can close this tab.</p><script>setTimeout(()=>window.close(),1000)</script>'
      );
      resolve(returnedCode);
    });

    server.on('error', reject);
    server.listen(CALLBACK_PORT, 'localhost', () => {
      // listener ready; caller opens the browser next
    });
  });
}

async function main() {
  const envContent = await readFile(ENV_FILE, 'utf8');
  const { map: env, lines } = parseEnv(envContent);

  const clientId = env.X_CLIENT_ID;
  const clientSecret = env.X_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error('[x:auth] X_CLIENT_ID and X_CLIENT_SECRET must be set in .env.local.');
    console.error('         Get them from your app\'s Keys and tokens page in the X Developer Console.');
    process.exit(1);
  }

  const { verifier, challenge } = pkce();
  const state = crypto.randomBytes(16).toString('hex');

  const authUrl = new URL(AUTHORIZE_URL);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
  authUrl.searchParams.set('scope', SCOPES.join(' '));
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');

  console.log('[x:auth] One-shot callback server listening on', REDIRECT_URI);
  console.log('[x:auth] Scopes requested:', SCOPES.join(' '));

  const codePromise = waitForCode(state);

  // Give the server a tick to bind before opening the browser
  setTimeout(() => {
    console.log('[x:auth] Opening browser for authorization...');
    exec(`open "${authUrl.toString()}"`, (err) => {
      if (err) {
        console.log('[x:auth] Could not auto-open browser. Paste this URL manually:');
        console.log(authUrl.toString());
      }
    });
  }, 100);

  const code = await codePromise;
  console.log('[x:auth] Authorization code received. Exchanging for tokens...');

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
  });

  const tokenResp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  if (!tokenResp.ok) {
    const errText = await tokenResp.text();
    console.error('[x:auth] Token exchange failed:', tokenResp.status, errText);
    process.exit(1);
  }

  const tokenJson = (await tokenResp.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope: string;
    token_type: string;
  };

  if (!tokenJson.refresh_token) {
    console.warn('[x:auth] Warning: no refresh_token in response. Check that "offline.access" scope was granted.');
  }

  const expiresAt = new Date(Date.now() + tokenJson.expires_in * 1000).toISOString();

  console.log('[x:auth] Token received. Verifying with GET /2/users/me...');
  const meResp = await fetch(ME_URL, {
    headers: { Authorization: `Bearer ${tokenJson.access_token}` },
  });
  if (!meResp.ok) {
    const errText = await meResp.text();
    console.error('[x:auth] /users/me verification failed:', meResp.status, errText);
    process.exit(1);
  }
  const me = (await meResp.json()) as { data: { id: string; name: string; username: string } };

  const updated = upsertEnvLines(lines, {
    X_BEARER_TOKEN: tokenJson.access_token,
    X_REFRESH_TOKEN: tokenJson.refresh_token ?? '',
    X_TOKEN_EXPIRES_AT: expiresAt,
  });
  await writeFile(ENV_FILE, updated.join('\n'), 'utf8');

  console.log('');
  console.log('[x:auth] ✓ Success.');
  console.log('         User:    @' + me.data.username + ' (' + me.data.name + ', id ' + me.data.id + ')');
  console.log('         Scopes:  ' + tokenJson.scope);
  console.log('         Expires: ' + expiresAt + ' (access token only; refresh_token stored for rotation)');
  console.log('');
  console.log('         .env.local updated with X_BEARER_TOKEN, X_REFRESH_TOKEN, X_TOKEN_EXPIRES_AT.');
  console.log('');
}

main().catch((err: unknown) => {
  console.error('[x:auth] Fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
