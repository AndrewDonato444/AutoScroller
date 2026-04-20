#!/usr/bin/env node
/**
 * End-to-end validation harness for the X API source layer.
 *
 * Loads the real config (~/scrollproxy/config.yaml), runs pullFromXApi()
 * against live X with the authenticated user's tokens, and prints a
 * per-list summary plus 2 sample adapted posts per list. Proves the
 * xApiClient → xListSource → xListAdapter chain works before we touch
 * the main pipeline in src/index.ts.
 *
 * Usage: pnpm x:test-source
 *
 * Cost per run: tiny. One fetch per configured list (+ bookmarks if on),
 * max_results capped by config. At current settings: 50 + 50 + 25 = 125
 * posts max. ~$0.125 pre-Owned-Reads, ~$0.025 post-rollover.
 */

import { loadConfig } from './config/load.js';
import { pullFromXApi, type XSourceConfig, type ListPull } from './sources/xListSource.js';
import type { ExtractedPost } from './types/post.js';

function line(char = '─', n = 72) {
  return char.repeat(n);
}

function formatPostPreview(post: ExtractedPost): string[] {
  const text = post.text.replace(/\s+/g, ' ').slice(0, 140);
  const ellipsis = post.text.length > 140 ? '…' : '';
  const mediaSuffix = post.media.length > 0 ? `  [${post.media.length} media]` : '';
  const repostSuffix = post.isRepost ? '  [RT]' : '';
  return [
    `  @${post.author.handle}${repostSuffix}  (${post.id})`,
    `    ${text}${ellipsis}${mediaSuffix}`,
    `    tag: ${post.sourceTag ?? '(none)'}  ·  metrics: ${post.metrics.likes ?? '?'} likes, ${post.metrics.reposts ?? '?'} RTs  ·  posted: ${post.postedAt ?? '?'}`,
  ];
}

function printPull(pull: ListPull): void {
  console.log(line());
  console.log(`List: "${pull.listName}"  (tag: ${pull.tag}, id: ${pull.listId})`);
  console.log(line());

  if (pull.error) {
    console.log(`  ✗ FAILED: ${pull.error}`);
    return;
  }

  console.log(`  ✓ ${pull.fetched} post(s) adapted.`);

  if (pull.posts.length === 0) {
    console.log('  (list is empty or returned no recent posts)');
    return;
  }

  console.log('');
  console.log('  Sample posts:');
  for (const post of pull.posts.slice(0, 2)) {
    for (const line of formatPostPreview(post)) console.log(line);
    console.log('');
  }
}

async function main() {
  console.log('[x:test-source] Loading config...');
  const config = await loadConfig();

  if (!config.x) {
    console.error('[x:test-source] No `x:` section in config.yaml. Add it and retry.');
    console.error('                 See projects/scrollproxy/list-curation.md for the shape.');
    process.exit(1);
  }

  const xConfig: XSourceConfig = {
    baseUrl: config.x.baseUrl,
    lists: config.x.lists,
    bookmarks: config.x.bookmarks,
  };

  console.log(`[x:test-source] Found ${xConfig.lists.length} list(s) in config${xConfig.bookmarks.enabled ? ' + bookmarks' : ''}.`);
  for (const l of xConfig.lists) {
    console.log(`                • "${l.name}" → tag "${l.tag}" (${l.postsPerRun} posts/run)`);
  }
  if (xConfig.bookmarks.enabled) {
    console.log(`                • Bookmarks → tag "bookmarks" (${xConfig.bookmarks.postsPerRun} posts/run)`);
  }
  console.log('');
  console.log('[x:test-source] Calling pullFromXApi()...');

  const result = await pullFromXApi(xConfig);

  console.log('');
  for (const pull of result.pulls) {
    printPull(pull);
  }

  console.log(line('═'));
  console.log('Run summary');
  console.log(line('═'));
  console.log(`  Total posts adapted: ${result.totalPosts}`);
  console.log(`  Lists attempted:     ${result.pulls.length}`);
  console.log(`  Lists with errors:   ${result.pulls.filter((p) => p.error).length}`);
  console.log(`  Started:  ${result.startedAt}`);
  console.log(`  Finished: ${result.finishedAt}`);
  console.log('');

  const errs = result.pulls.filter((p) => p.error);
  if (errs.length > 0) {
    console.log('⚠ Errors to investigate:');
    for (const e of errs) console.log(`   • ${e.listName} [${e.tag}]: ${e.error}`);
    console.log('');
    process.exit(2);
  }

  console.log('✓ Source layer validated. Safe to wire into src/index.ts.');
}

main().catch((err: unknown) => {
  console.error('[x:test-source] Fatal:', err instanceof Error ? err.message : err);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
