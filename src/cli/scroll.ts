import type { Config } from '../config/schema.js';
import { runScroll, expandHomeDir, type ScrollResult } from '../scroll/scroller.js';
import { createExtractor, type ExtractedPost } from '../extract/extractor.js';
import { writeRawJson, generateRunId } from '../writer/raw-json.js';
import { loadDedupCache, saveDedupCache, partitionPosts, appendHashes } from '../state/dedup-cache.js';

export interface ScrollFlags {
  minutes?: number;
  dryRun?: boolean;
}

// Exit codes
const EXIT_SUCCESS = 0;
const EXIT_ERROR = 1;

/**
 * Format a path for display by converting home directory to tilde notation.
 */
function formatDisplayPath(path: string): string {
  return path.replace(expandHomeDir('~'), '~');
}

/**
 * Update the dedup cache with new posts.
 * Returns a summary fragment with the new/seen counts and display path.
 * Throws if cache update fails.
 */
async function updateDedupCacheAndGetSummary(
  posts: ExtractedPost[],
  stateDir: string,
  rawJsonPath: string
): Promise<string> {
  const cache = await loadDedupCache(stateDir);
  const { newPosts, seenPosts, newHashes } = partitionPosts(posts, cache);
  const updatedCache = appendHashes(cache, newHashes);
  await saveDedupCache(updatedCache, stateDir);

  const displayPath = formatDisplayPath(rawJsonPath);
  return ` — ${newPosts.length} new, ${seenPosts.length} already seen — saved to ${displayPath}`;
}

/**
 * Handle the scroll command.
 *
 * Launches the persistent Chromium context and scrolls x.com/home
 * with jittered mouse wheel ticks for the budgeted time.
 */
export async function handleScroll(config: Config, flags: ScrollFlags): Promise<void> {
  const effectiveMinutes = flags.minutes ?? config.scroll.minutes;
  const resolvedUserDataDir = expandHomeDir(config.browser.userDataDir);
  const isDryRun = flags.dryRun ?? false;

  // Generate run ID at the start (so startedAt and directory name agree)
  const startedAt = new Date();
  const runId = generateRunId(startedAt);

  // Print startup line
  console.log(`scrolling x.com for ${effectiveMinutes}m (persistent context: ${resolvedUserDataDir})`);

  // Create extractor instance
  const extractor = createExtractor();

  // Run the scroll
  const result: ScrollResult = await runScroll({
    userDataDir: config.browser.userDataDir,
    headless: config.browser.headless,
    viewport: config.browser.viewport,
    budgetMinutes: effectiveMinutes,
    jitterMs: config.scroll.jitterMs,
    longPauseEvery: config.scroll.longPauseEvery,
    longPauseMs: config.scroll.longPauseMs,
    dryRun: isDryRun,
    onTick: extractor.onTick,
  });

  // Handle result
  if (result.status === 'session_expired') {
    console.log('session expired — run pnpm login to refresh, then pnpm scroll');
    process.exit(EXIT_ERROR);
  }

  if (result.status === 'error') {
    console.error(result.error);
    process.exit(EXIT_ERROR);
  }

  // Get extraction stats
  const stats = extractor.getStats();
  const postsExtracted = stats.postsExtracted;
  const adsSkipped = stats.adsSkipped;
  const elapsedSec = Math.round(result.elapsedMs / 1000);

  // Handle browser_closed - write what we collected
  if (result.status === 'browser_closed') {
    let summaryLine = `scroll ended early after ${result.tickCount} ticks (browser closed)`;

    if (!isDryRun) {
      try {
        const endedAt = new Date(startedAt.getTime() + result.elapsedMs);
        const posts = extractor.getPosts();
        const writeResult = await writeRawJson({
          outputDir: config.output.dir,
          runId,
          posts,
          stats,
          meta: {
            startedAt: startedAt.toISOString(),
            endedAt: endedAt.toISOString(),
            elapsedMs: result.elapsedMs,
            tickCount: result.tickCount,
            minutes: effectiveMinutes,
            dryRun: isDryRun,
          },
        });

        // Update dedup cache (browser closed with recovered posts)
        try {
          summaryLine += await updateDedupCacheAndGetSummary(posts, config.output.state, writeResult.rawJsonPath);
        } catch (cacheError: any) {
          // Dedup cache failure is non-fatal
          const displayPath = formatDisplayPath(writeResult.rawJsonPath);
          summaryLine += ` — saved to ${displayPath}`;
          console.log(summaryLine);
          console.log(`dedup cache failed: ${cacheError.message} (next run will re-count some posts as new)`);
          process.exit(EXIT_ERROR);
        }
      } catch (error: any) {
        summaryLine += ` — write failed: ${error.message}`;
      }
    }

    console.log(summaryLine);
    process.exit(EXIT_ERROR);
  }

  // Completed successfully
  if (isDryRun) {
    console.log(
      `dry-run complete: ${result.tickCount} ticks over ${elapsedSec}s — ${postsExtracted} posts extracted (${adsSkipped} ads skipped), writer skipped`
    );
  } else {
    let summaryLine = `scroll complete: ${result.tickCount} ticks over ${elapsedSec}s — ${postsExtracted} posts extracted (${adsSkipped} ads skipped)`;

    try {
      const endedAt = new Date(startedAt.getTime() + result.elapsedMs);
      const posts = extractor.getPosts();
      const writeResult = await writeRawJson({
        outputDir: config.output.dir,
        runId,
        posts,
        stats,
        meta: {
          startedAt: startedAt.toISOString(),
          endedAt: endedAt.toISOString(),
          elapsedMs: result.elapsedMs,
          tickCount: result.tickCount,
          minutes: effectiveMinutes,
          dryRun: isDryRun,
        },
      });

      // Update dedup cache after successful raw.json write
      try {
        summaryLine += await updateDedupCacheAndGetSummary(posts, config.output.state, writeResult.rawJsonPath);
      } catch (cacheError: any) {
        // Dedup cache failure is non-fatal - the raw.json is safe
        const displayPath = formatDisplayPath(writeResult.rawJsonPath);
        summaryLine += ` — saved to ${displayPath}`;
        console.log(summaryLine);
        console.log(`dedup cache failed: ${cacheError.message} (next run will re-count some posts as new)`);
        process.exit(EXIT_SUCCESS);
      }

      console.log(summaryLine);
      process.exit(EXIT_SUCCESS);
    } catch (error: any) {
      summaryLine += ` — write failed: ${error.message}`;
      console.log(summaryLine);
      process.exit(EXIT_ERROR);
    }
  }

  process.exit(EXIT_SUCCESS);
}
