import type { Config } from '../config/schema.js';
import { runScroll, expandHomeDir, type ScrollResult } from '../scroll/scroller.js';
import { createExtractor, type ExtractedPost } from '../extract/extractor.js';
import { writeRawJson, generateRunId } from '../writer/raw-json.js';
import { loadDedupCache, saveDedupCache, partitionPosts, appendHashes } from '../state/dedup-cache.js';
import { summarizeRun, type SummarizerInput } from '../summarizer/summarizer.js';
import { loadThemesStore, saveThemesStore, appendRun, recentThemes } from '../state/rolling-themes.js';
import { runWriters, type Writer, type WriteContext } from '../writer/writer.js';
import { markdownWriter } from '../writer/markdown.js';
import { createNotionWriter } from '../writer/notion.js';
import { writeFile, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

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
 * Build writers array from config, ensuring markdown is always first.
 */
function buildWriters(config: Config): Writer[] {
  const writers: Writer[] = [];
  const destinations = config.output.destinations;

  // Always put markdown first if it's in the list
  if (destinations.includes('markdown')) {
    writers.push(markdownWriter);
  }

  // Add notion if configured
  if (destinations.includes('notion')) {
    if (!config.notion) {
      throw new Error('notion destination enabled but notion config is missing');
    }

    const token = config.notion.token || process.env.NOTION_TOKEN;
    if (!token) {
      throw new Error('notion destination enabled but no token provided');
    }

    writers.push(
      createNotionWriter({
        token,
        parentPageId: config.notion.parentPageId,
        model: config.claude.model,
      })
    );
  }

  return writers;
}

/**
 * Update the dedup cache with new posts.
 * Returns partition result for summarizer, and summary fragment.
 * Throws if cache update fails.
 */
async function updateDedupCacheAndGetSummary(
  posts: ExtractedPost[],
  stateDir: string,
  rawJsonPath: string
): Promise<{
  newPosts: ExtractedPost[];
  seenPosts: ExtractedPost[];
  summaryFragment: string;
}> {
  const cache = await loadDedupCache(stateDir);
  const { newPosts, seenPosts, newHashes } = partitionPosts(posts, cache);
  const updatedCache = appendHashes(cache, newHashes);
  await saveDedupCache(updatedCache, stateDir);

  const displayPath = formatDisplayPath(rawJsonPath);
  const summaryFragment = ` — ${newPosts.length} new, ${seenPosts.length} already seen — saved to ${displayPath}`;

  return { newPosts, seenPosts, summaryFragment };
}

/**
 * Write summary.json atomically to the run directory.
 */
async function writeSummaryJson(runDir: string, summary: any): Promise<void> {
  const summaryPath = join(runDir, 'summary.json');
  const tmpPath = join(runDir, 'summary.json.tmp');

  // Ensure run directory exists
  await mkdir(runDir, { recursive: true });

  // Write to tmpfile with stable key order
  const content = JSON.stringify(summary, null, 2);
  await writeFile(tmpPath, content, 'utf-8');

  // Atomic rename
  await rename(tmpPath, summaryPath);
}

/**
 * Write summary.error.json to the run directory.
 */
async function writeSummaryErrorJson(
  runDir: string,
  runId: string,
  reason: string,
  rawResponse?: string
): Promise<void> {
  const errorPath = join(runDir, 'summary.error.json');

  const errorData = {
    schemaVersion: 1,
    runId,
    at: new Date().toISOString(),
    reason,
    ...(rawResponse && { rawResponse }),
  };

  const content = JSON.stringify(errorData, null, 2);
  await writeFile(errorPath, content, 'utf-8');
}

/**
 * Write raw.json and update dedup cache.
 * Returns the write result and dedup partition for further processing.
 */
async function writeRawJsonAndUpdateCache(params: {
  outputDir: string;
  stateDir: string;
  runId: string;
  posts: ExtractedPost[];
  stats: any;
  meta: any;
}): Promise<{
  writeResult: Awaited<ReturnType<typeof writeRawJson>>;
  newPosts: ExtractedPost[];
  seenPosts: ExtractedPost[];
  summaryFragment: string;
}> {
  const { outputDir, stateDir, runId, posts, stats, meta } = params;

  // Write raw.json
  const writeResult = await writeRawJson({
    outputDir,
    runId,
    posts,
    stats,
    meta,
  });

  // Update dedup cache
  const { newPosts, seenPosts, summaryFragment } = await updateDedupCacheAndGetSummary(
    posts,
    stateDir,
    writeResult.rawJsonPath
  );

  return { writeResult, newPosts, seenPosts, summaryFragment };
}

/**
 * Run summarizer and handle success/error paths including writer orchestration.
 * Returns { success: true, summaryLine } on success or { success: false, summaryLine } on failure.
 */
async function runSummarizerAndWriters(params: {
  posts: ExtractedPost[];
  newPosts: ExtractedPost[];
  config: Config;
  runId: string;
  runDir: string;
  rawJsonPath: string;
  endedAt: Date;
  summaryLine: string;
}): Promise<{ success: boolean; summaryLine: string; errorDetails: string[] }> {
  const { posts, newPosts, config, runId, runDir, rawJsonPath, endedAt, summaryLine } = params;

  // Load themes store to get prior themes
  const themesStore = await loadThemesStore(config.output.state);
  const priorThemes = recentThemes(themesStore);

  // Build summarizer input
  const summarizerInput: SummarizerInput = {
    posts,
    newPostIds: newPosts.map(p => p.id),
    priorThemes,
    interests: config.interests,
    runId,
    model: config.claude.model,
    apiKey: config.claude.apiKey || '',
  };

  // Call summarizer
  const summarizerResult = await summarizeRun(summarizerInput);

  if (summarizerResult.status === 'ok') {
    // Write summary.json
    const summaryJsonPath = join(runDir, 'summary.json');
    await writeSummaryJson(runDir, summarizerResult.summary);

    // Update themes store
    const updatedStore = appendRun(themesStore, {
      runId,
      endedAt: endedAt.toISOString(),
      themes: summarizerResult.summary.themes,
    });
    await saveThemesStore(updatedStore, config.output.state);

    // Update summary line with summarizer stats
    const themeCount = summarizerResult.summary.themes.length;
    const worthClickingCount = summarizerResult.summary.worthClicking.length;
    let updatedSummaryLine = summaryLine.replace(
      / — saved to .*$/,
      ` — summarized (${themeCount} themes, ${worthClickingCount} worth clicking) — saved to ${formatDisplayPath(rawJsonPath)}`
    );

    // Build writers and run them
    const writers = buildWriters(config);
    const context: WriteContext = {
      runId,
      runDir,
      rawJsonPath,
      summaryJsonPath,
      displayRawJsonPath: formatDisplayPath(rawJsonPath),
      displaySummaryJsonPath: formatDisplayPath(summaryJsonPath),
    };

    const { receipts, markdownSucceeded } = await runWriters({
      writers,
      summary: summarizerResult.summary,
      context,
    });

    // Append successful writer locations to summary line
    receipts
      .filter(r => r.receipt.ok)
      .forEach(r => {
        if (r.receipt.ok) {
          updatedSummaryLine += ` — rendered to ${r.receipt.displayLocation}`;
        }
      });

    // Collect error details for failed writers
    const errorDetails: string[] = [];
    receipts
      .filter(r => !r.receipt.ok)
      .forEach(r => {
        if (!r.receipt.ok) {
          errorDetails.push(`${r.id} render failed: ${r.receipt.reason}`);
        }
      });

    // Determine success based on markdown writer
    const success = markdownSucceeded;

    return { success, summaryLine: updatedSummaryLine, errorDetails };
  } else {
    // Summarizer failed - write error file
    await writeSummaryErrorJson(runDir, runId, summarizerResult.reason, summarizerResult.rawResponse);

    // Update summary line
    const updatedSummaryLine = summaryLine.replace(
      / — saved to .*$/,
      ` — summarizer failed: ${summarizerResult.reason} — saved to ${formatDisplayPath(rawJsonPath)}`
    );

    return { success: false, summaryLine: updatedSummaryLine, errorDetails: [] };
  }
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

        const { summaryFragment } = await writeRawJsonAndUpdateCache({
          outputDir: config.output.dir,
          stateDir: config.output.state,
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

        summaryLine += summaryFragment;
      } catch (error: any) {
        // Handle both write failures and cache failures
        if (error.message.includes('dedup cache')) {
          console.log(summaryLine);
          console.log(`dedup cache failed: ${error.message} (next run will re-count some posts as new)`);
          process.exit(EXIT_ERROR);
        }
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

      // Write raw.json and update dedup cache
      let newPosts: ExtractedPost[];
      let writeResult: Awaited<ReturnType<typeof writeRawJson>>;

      try {
        const writeAndCacheResult = await writeRawJsonAndUpdateCache({
          outputDir: config.output.dir,
          stateDir: config.output.state,
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
        newPosts = writeAndCacheResult.newPosts;
        writeResult = writeAndCacheResult.writeResult;
        summaryLine += writeAndCacheResult.summaryFragment;
      } catch (cacheError: any) {
        // Dedup cache failure is non-fatal - the raw.json is safe
        console.log(summaryLine);
        console.log(`dedup cache failed: ${cacheError.message} (next run will re-count some posts as new)`);
        process.exit(EXIT_SUCCESS);
      }

      // Run summarizer and writers after successful dedup cache update
      try {
        const result = await runSummarizerAndWriters({
          posts,
          newPosts,
          config,
          runId,
          runDir: writeResult.runDir,
          rawJsonPath: writeResult.rawJsonPath,
          endedAt,
          summaryLine,
        });

        console.log(result.summaryLine);

        // Print any error details (failed writers)
        result.errorDetails.forEach(detail => {
          console.log(detail);
        });

        if (result.success) {
          process.exit(EXIT_SUCCESS);
        } else {
          process.exit(EXIT_ERROR);
        }
      } catch (summarizerError: any) {
        // Unexpected summarizer error
        console.log(summaryLine);
        console.log(`summarizer error: ${summarizerError.message}`);
        process.exit(EXIT_ERROR);
      }
    } catch (error: any) {
      summaryLine += ` — write failed: ${error.message}`;
      console.log(summaryLine);
      process.exit(EXIT_ERROR);
    }
  }

  process.exit(EXIT_SUCCESS);
}
