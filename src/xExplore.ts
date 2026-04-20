#!/usr/bin/env node
/**
 * X API exploration — one-shot discovery run.
 *
 * Answers three questions for the ScrollProxy migration:
 *   1. What X lists does the authorized user own and follow? (seeds list-curation.md)
 *   2. Does the bookmarks endpoint return data? (validates that read layer)
 *   3. Does GET /2/lists/{id}/tweets work, and — after this run — does the
 *      usage dashboard bill it at Owned Reads ($0.001) or standard Posts: Read
 *      ($0.005)? That's the remaining pricing ambiguity.
 *
 * Usage: pnpm x:explore
 *
 * Volume is minimal by design (max_results=5 on every fetch) so the dashboard
 * line items are easy to read after the run.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

const ENV_FILE = path.resolve(process.cwd(), '.env.local');
const API_BASE = 'https://api.x.com/2';

type EnvMap = Record<string, string>;

function parseEnv(content: string): EnvMap {
  const map: EnvMap = {};
  for (const line of content.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) map[m[1]] = m[2];
  }
  return map;
}

async function get(token: string, path: string, params?: Record<string, string>) {
  const url = new URL(API_BASE + path);
  if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await resp.text();
  let json: unknown;
  try { json = JSON.parse(text); } catch { json = text; }
  return { ok: resp.ok, status: resp.status, json };
}

function section(label: string) {
  console.log('\n' + '─'.repeat(60));
  console.log(label);
  console.log('─'.repeat(60));
}

async function main() {
  const envContent = await readFile(ENV_FILE, 'utf8');
  const env = parseEnv(envContent);

  const token = env.X_BEARER_TOKEN;
  const expiresAt = env.X_TOKEN_EXPIRES_AT;
  if (!token) {
    console.error('[x:explore] X_BEARER_TOKEN is empty. Run `pnpm x:auth` first.');
    process.exit(1);
  }
  if (expiresAt && new Date(expiresAt).getTime() < Date.now()) {
    console.warn(`[x:explore] Access token expired at ${expiresAt}.`);
    console.warn('            Refresh flow not implemented yet — re-run `pnpm x:auth` to get a fresh token.');
    process.exit(1);
  }

  // 1) Confirm token + get user ID
  section('1. Authenticated user');
  const me = await get(token, '/users/me');
  if (!me.ok) {
    console.error('  /users/me failed:', me.status, JSON.stringify(me.json, null, 2));
    process.exit(1);
  }
  const meData = me.json as { data: { id: string; name: string; username: string } };
  console.log(`  @${meData.data.username}  (${meData.data.name}, id ${meData.data.id})`);
  const userId = meData.data.id;

  // 2) Owned lists
  section('2. Owned lists (lists you created)');
  const owned = await get(token, `/users/${userId}/owned_lists`, { max_results: '100' });
  if (!owned.ok) {
    console.error('  /owned_lists failed:', owned.status, JSON.stringify(owned.json, null, 2));
  } else {
    const data = (owned.json as { data?: Array<{ id: string; name: string }>; meta?: { result_count: number } });
    const count = data.meta?.result_count ?? 0;
    console.log(`  ${count} owned list(s).`);
    for (const list of data.data ?? []) {
      console.log(`    • ${list.name}  (id: ${list.id})`);
    }
  }

  // 3) Followed lists
  section('3. Followed lists (lists you follow, created by others)');
  const followed = await get(token, `/users/${userId}/followed_lists`, { max_results: '100' });
  if (!followed.ok) {
    console.error('  /followed_lists failed:', followed.status, JSON.stringify(followed.json, null, 2));
  } else {
    const data = (followed.json as { data?: Array<{ id: string; name: string }>; meta?: { result_count: number } });
    const count = data.meta?.result_count ?? 0;
    console.log(`  ${count} followed list(s).`);
    for (const list of data.data ?? []) {
      console.log(`    • ${list.name}  (id: ${list.id})`);
    }
  }

  // 4) Bookmarks
  section('4. Bookmarks (testing endpoint + signal quality)');
  const bookmarks = await get(token, `/users/${userId}/bookmarks`, { max_results: '5' });
  if (!bookmarks.ok) {
    console.error('  /bookmarks failed:', bookmarks.status, JSON.stringify(bookmarks.json, null, 2));
  } else {
    const data = bookmarks.json as { data?: Array<{ id: string; text: string }>; meta?: { result_count: number } };
    const count = data.meta?.result_count ?? 0;
    console.log(`  ${count} recent bookmark(s) returned.`);
    for (const post of (data.data ?? []).slice(0, 3)) {
      const preview = post.text.replace(/\s+/g, ' ').slice(0, 100);
      console.log(`    • ${post.id}: ${preview}${post.text.length > 100 ? '…' : ''}`);
    }
  }

  // 5) The pricing-ambiguity-resolving call: GET /lists/{id}/tweets
  section('5. List tweets — the pricing ambiguity test');
  const ownedData = owned.ok ? (owned.json as { data?: Array<{ id: string; name: string }> }) : { data: [] };
  const followedData = followed.ok ? (followed.json as { data?: Array<{ id: string; name: string }> }) : { data: [] };
  const firstList = ownedData.data?.[0] ?? followedData.data?.[0];

  if (!firstList) {
    console.log('  No lists found to test /lists/{id}/tweets. Create an X list (any list, even');
    console.log('  one with one account in it) and re-run `pnpm x:explore`. Until then we can\'t');
    console.log('  confirm whether this endpoint falls under Owned Reads pricing.');
  } else {
    console.log(`  Testing with: "${firstList.name}" (id ${firstList.id})`);
    const listTweets = await get(token, `/lists/${firstList.id}/tweets`, { max_results: '5' });
    if (!listTweets.ok) {
      console.error(`  /lists/${firstList.id}/tweets failed:`, listTweets.status, JSON.stringify(listTweets.json, null, 2));
    } else {
      const data = listTweets.json as { data?: Array<{ id: string; text: string }>; meta?: { result_count: number } };
      const count = data.meta?.result_count ?? 0;
      console.log(`  ✓ ${count} tweet(s) returned from the list.`);
      for (const post of (data.data ?? []).slice(0, 3)) {
        const preview = post.text.replace(/\s+/g, ' ').slice(0, 100);
        console.log(`    • ${post.id}: ${preview}${post.text.length > 100 ? '…' : ''}`);
      }
    }
  }

  section('Next step: check the usage dashboard');
  console.log('  Open: https://developer.x.com  →  Usage (or Billing)');
  console.log('  Look at the line items logged in the past few minutes.');
  console.log('  The test made roughly:');
  console.log('    • 1× User: Read             (/users/me)');
  console.log('    • 1× List: Read             (/users/{id}/owned_lists)');
  console.log('    • 1× List: Read             (/users/{id}/followed_lists)');
  console.log('    • ~5× Posts: Read or Owned  (/users/{id}/bookmarks)');
  if (firstList) {
    console.log('    • ~5× Posts: Read or Owned  (/lists/{id}/tweets)  ← the ambiguity test');
  }
  console.log('');
  console.log('  If the last two billed at $0.001/resource  → Owned Reads applies. Ship migration as planned.');
  console.log('  If they billed at $0.005/resource          → standard Posts: Read. Migration still worth it,');
  console.log('                                                just update the cost estimate in the plan.');
  console.log('');
}

main().catch((err: unknown) => {
  console.error('[x:explore] Fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
