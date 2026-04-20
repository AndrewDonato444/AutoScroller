import type { Config } from '../config/schema.js';
import { runScroll, expandHomeDir, type ScrollResult } from '../scroll/scroller.js';
import { createExtractor, type ExtractedPost } from '../extract/extractor.js';
import { writeRawJson, generateRunId } from '../writer/raw-json.js';
import { loadDedupCache, saveDedupCache, partitionPosts, appendHashes } from '../state/dedup-cache.js';
import { summarizeRun, type SummarizerInput } from '../summarizer/summarizer.js';
import { loadThemesStore, saveThemesStore, appendRun, recentThemes } from '../state/rolling-themes.js';
import { detectTrends } from '../trends/trend-detector.js';
import { runWriters, type Writer, type WriteContext } from '../writer/writer.js';
import { markdownWriter } from '../writer/markdown.js';
import { createNotionWriter } from '../writer/notion.js';
import { createVisionFallback, type VisionStats } from '../extract/vision-fallback.js';
import { pullFromXApi, flattenPulls, type XSourceConfig } from '../sources/xListSource.js';
import Anthropic from '@anthropic-ai/sdk';
import { writeFile, rename, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn, execFile } from 'node:child_process';

export type ScrollSource = 'playwright' | 'x-api';

export interface ScrollFlags {
  minutes?: number;
  dryRun?: boolean;
  /**
   * Which data source to use. Default 'playwright' preserves existing
   * behavior. 'x-api' uses the X API Owned Reads source (April 2026
   * migration) — requires config.x to be populated.
   */
  source?: ScrollSource;
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
 * Ping the CDP endpoint to see if Chrome is alive on it.
 * Returns true if Chrome is reachable, false otherwise.
 */
async function isCdpAlive(cdpEndpoint: string): Promise<boolean> {
  try {
    const versionUrl = new URL('/json/version', cdpEndpoint).toString();
    const res = await fetch(versionUrl, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Launch Chrome in the background with the configured CDP port and profile.
 * Returns once the CDP port responds, or throws if Chrome never comes up.
 *
 * Used by scheduled runs so the operator doesn't have to manually run
 * `pnpm run chrome` before each scroll.
 */
async function ensureChromeRunning(cdpEndpoint: string, userDataDir: string): Promise<void> {
  if (await isCdpAlive(cdpEndpoint)) {
    return;
  }

  const port = new URL(cdpEndpoint).port || '9222';
  const profile = expandHomeDir(userDataDir);
  const chromeApp = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

  console.log(`chrome not running on port ${port} — launching in background...`);

  // Detached + unref'd so Chrome keeps running after scroll exits.
  // stdio ignored so Chrome's chatty stderr doesn't leak into our output.
  const child = spawn(chromeApp, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=PrivacySandboxSettings4',
  ], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  // Poll the CDP port until it responds (max ~15s)
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    if (await isCdpAlive(cdpEndpoint)) {
      console.log(`chrome ready on port ${port}`);
      return;
    }
  }

  throw new Error(`chrome failed to start on port ${port} within 15s`);
}

/**
 * Fire a macOS desktop notification. Best-effort — silently no-ops if
 * osascript isn't available (non-macOS) or the call fails.
 */
function notify(title: string, body: string): void {
  const script = `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`;
  execFile('osascript', ['-e', script], () => {
    // Fire and forget. Errors don't matter.
  });
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
 * Clean up screenshot directory after writers complete.
 */
async function cleanupScreenshots(screenshotDir: string): Promise<void> {
  try {
    await rm(screenshotDir, { recursive: true, force: true });
  } catch {
    // Silently ignore cleanup errors
  }
}

/**
 * Run vision fallback rescue if triggered.
 * Returns updated posts and visionStats if rescue ran, or original posts and undefined if not.
 */
async function runVisionFallbackIfNeeded(params: {
  config: Config;
  posts: ExtractedPost[];
  stats: any;
  runId: string;
  screenshotDir: string;
  isDryRun: boolean;
}): Promise<{ posts: ExtractedPost[]; visionStats?: VisionStats; triggerReason?: string }> {
  const { config, posts, stats, runId, screenshotDir, isDryRun } = params;

  // Create vision fallback instance
  const fallback = createVisionFallback(config.extractor.visionFallback);

  // Check if rescue should trigger
  const triggerResult = fallback.shouldTrigger(stats, posts);

  if (!triggerResult.triggered) {
    // No rescue needed
    return { posts };
  }

  // Rescue would trigger
  if (isDryRun) {
    // Dry-run: report trigger but don't actually call API
    return {
      posts,
      triggerReason: triggerResult.reason,
    };
  }

  // Create Anthropic client
  const apiKey = config.claude.apiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // No API key - can't rescue
    return {
      posts,
      visionStats: {
        screenshotsSent: 0,
        screenshotsDropped: 0,
        visionPostsExtracted: 0,
        visionPostsMerged: 0,
        visionDuplicatesSkipped: 0,
        apiCalls: 0,
        apiErrors: [
          {
            screenshotPath: '',
            errorMessage: 'no API key provided',
            attempt: 0,
          },
        ],
        costEstimateUsd: 0,
        triggerReason: triggerResult.reason,
      },
    };
  }

  const anthropicClient = new Anthropic({ apiKey });

  try {
    // Run rescue
    const rescueResult = await fallback.rescue({
      runId,
      screenshotDir,
      existingPosts: posts,
      existingStats: stats,
      anthropicClient,
    });

    return {
      posts: rescueResult.posts,
      visionStats: {
        ...rescueResult.visionStats,
        triggerReason: triggerResult.reason,
      },
    };
  } catch (error: any) {
    // Rescue failed unexpectedly - return original posts with error
    return {
      posts,
      visionStats: {
        screenshotsSent: 0,
        screenshotsDropped: 0,
        visionPostsExtracted: 0,
        visionPostsMerged: 0,
        visionDuplicatesSkipped: 0,
        apiCalls: 0,
        apiErrors: [
          {
            screenshotPath: '',
            errorMessage: error.message,
            attempt: 0,
          },
        ],
        costEstimateUsd: 0,
        triggerReason: triggerResult.reason,
      },
    };
  }
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
  visionStats?: VisionStats;
}): Promise<{
  writeResult: Awaited<ReturnType<typeof writeRawJson>>;
  newPosts: ExtractedPost[];
  seenPosts: ExtractedPost[];
  summaryFragment: string;
}> {
  const { outputDir, stateDir, runId, posts, stats, meta, visionStats } = params;

  // Write raw.json
  const writeResult = await writeRawJson({
    outputDir,
    runId,
    posts,
    stats,
    meta,
    visionStats,
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
  visionStats?: VisionStats;
}): Promise<{ success: boolean; summaryLine: string; errorDetails: string[] }> {
  const { posts, newPosts, config, runId, runDir, rawJsonPath, endedAt, summaryLine, visionStats } = params;

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
    // Detect trends from the current store (before updating it)
    const trendReport = detectTrends({
      store: themesStore,
      currentThemes: summarizerResult.summary.themes,
    });

    // Add trends to summary
    const summaryWithTrends = {
      ...summarizerResult.summary,
      trends: trendReport,
    };

    // Write summary.json
    const summaryJsonPath = join(runDir, 'summary.json');
    await writeSummaryJson(runDir, summaryWithTrends);

    // Update themes store
    const updatedStore = appendRun(themesStore, {
      runId,
      endedAt: endedAt.toISOString(),
      themes: summarizerResult.summary.themes,
    });
    await saveThemesStore(updatedStore, config.output.state);

    // Update summary line with summarizer stats
    const themeCount = summaryWithTrends.themes.length;
    const worthClickingCount = summaryWithTrends.worthClicking.length;
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
      visionStats,
    };

    const { receipts, markdownSucceeded } = await runWriters({
      writers,
      summary: summaryWithTrends,
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
 *
 * With `flags.source === 'x-api'`, bypasses the browser entirely and pulls
 * from the X API owned-reads endpoints instead (April 2026 migration).
 */
export async function handleScroll(config: Config, flags: ScrollFlags): Promise<void> {
  // Route to the X API path when requested. Everything below this guard
  // is Playwright-specific.
  if (flags.source === 'x-api') {
    return handleScrollXApi(config, flags);
  }

  const effectiveMinutes = flags.minutes ?? config.scroll.minutes;
  const resolvedUserDataDir = expandHomeDir(config.browser.userDataDir);
  const isDryRun = flags.dryRun ?? false;

  // Generate run ID at the start (so startedAt and directory name agree)
  const startedAt = new Date();
  const runId = generateRunId(startedAt);

  // Set up screenshot directory for vision fallback
  const resolvedOutputDir = expandHomeDir(config.output.dir);
  const runDir = join(resolvedOutputDir, runId);
  const screenshotDir = join(runDir, 'screenshots');

  // Create screenshot directory if vision fallback is enabled
  if (config.extractor.visionFallback.enabled) {
    await mkdir(screenshotDir, { recursive: true });
  }

  // Print startup line — show which browser mode is in use so "why isn't Chrome scrolling?" is obvious.
  const browserMode = config.browser.cdpEndpoint
    ? `attached via CDP to ${config.browser.cdpEndpoint}`
    : `launched own context at ${resolvedUserDataDir}`;
  console.log(`scrolling x.com for ${effectiveMinutes}m (${browserMode})`);

  // If we're configured for CDP attach, make sure Chrome is actually running
  // on that port. If not, launch it in the background. This is what lets
  // scheduled runs work without the operator opening a terminal first.
  if (config.browser.cdpEndpoint) {
    try {
      await ensureChromeRunning(config.browser.cdpEndpoint, config.browser.userDataDir);
    } catch (error: any) {
      console.error(`failed to start chrome: ${error.message}`);
      notify('ScrollProxy: Chrome unavailable', `Could not launch Chrome on ${config.browser.cdpEndpoint}`);
      process.exit(EXIT_ERROR);
    }
  }

  // Create extractor instance
  const extractor = createExtractor();

  // Run the scroll
  const result: ScrollResult = await runScroll({
    userDataDir: config.browser.userDataDir,
    headless: config.browser.headless,
    channel: config.browser.channel,
    cdpEndpoint: config.browser.cdpEndpoint,
    viewport: config.browser.viewport,
    budgetMinutes: effectiveMinutes,
    jitterMs: config.scroll.jitterMs,
    longPauseEvery: config.scroll.longPauseEvery,
    longPauseMs: config.scroll.longPauseMs,
    dryRun: isDryRun,
    onTick: extractor.onTick,
    screenshotDir: config.extractor.visionFallback.enabled ? screenshotDir : undefined,
    screenshotEveryTicks: config.extractor.visionFallback.screenshotEveryTicks,
  });

  // Handle result
  if (result.status === 'session_expired') {
    console.log('session expired — run `pnpm run chrome` and log back into X');
    notify(
      'ScrollProxy: re-auth needed',
      'X session expired. Run `pnpm run chrome` and log back in to resume scheduled scrolls.',
    );
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

  // Handle browser_closed - write what we have and still try to summarize.
  // If Chrome crashed mid-scroll (hang watchdog, OOM, etc.) we likely still
  // have a useful pile of posts. Bailing without summarizing wastes them.
  if (result.status === 'browser_closed' && !isDryRun) {
    const posts = extractor.getPosts();
    const endedAt = new Date(startedAt.getTime() + result.elapsedMs);
    let summaryLine = `scroll ended early after ${result.tickCount} ticks (browser closed)`;

    if (posts.length === 0) {
      // Nothing to summarize — bail.
      console.log(summaryLine);
      process.exit(EXIT_ERROR);
    }

    // Write raw.json + update dedup cache. On cache failure we still have raw.
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
    } catch (error: any) {
      console.log(summaryLine);
      console.log(`write failed: ${error.message}`);
      process.exit(EXIT_ERROR);
    }

    // Try to summarize the partial data. Chrome being dead doesn't affect Claude.
    try {
      const sumResult = await runSummarizerAndWriters({
        posts,
        newPosts,
        config,
        runId,
        runDir: writeResult.runDir,
        rawJsonPath: writeResult.rawJsonPath,
        endedAt,
        summaryLine,
        visionStats: undefined,
      });
      console.log(sumResult.summaryLine);
      sumResult.errorDetails.forEach((d) => console.log(d));
      await cleanupScreenshots(screenshotDir);
      // Treat as success even though scroll was cut short — we produced output.
      process.exit(sumResult.success ? EXIT_SUCCESS : EXIT_ERROR);
    } catch (summarizerError: any) {
      await cleanupScreenshots(screenshotDir);
      console.log(summaryLine);
      console.log(`summarizer error: ${summarizerError.message}`);
      process.exit(EXIT_ERROR);
    }
  }

  // Dry-run that hit browser_closed — report and bail.
  if (result.status === 'browser_closed' && isDryRun) {
    console.log(`scroll ended early after ${result.tickCount} ticks (browser closed, dry-run)`);
    process.exit(EXIT_ERROR);
  }

  // Completed successfully
  if (isDryRun) {
    // Dry-run: check if rescue would have triggered
    const posts = extractor.getPosts();
    const { triggerReason } = await runVisionFallbackIfNeeded({
      config,
      posts,
      stats,
      runId,
      screenshotDir,
      isDryRun: true,
    });

    let dryRunLine = `dry-run complete: ${result.tickCount} ticks over ${elapsedSec}s — ${postsExtracted} posts extracted (${adsSkipped} ads skipped), writer skipped`;

    if (triggerReason) {
      dryRunLine += ` (vision rescue would have triggered: ${triggerReason})`;
    }

    console.log(dryRunLine);

    // Clean up screenshots
    await cleanupScreenshots(screenshotDir);
  } else {
    let summaryLine = `scroll complete: ${result.tickCount} ticks over ${elapsedSec}s — ${postsExtracted} posts extracted (${adsSkipped} ads skipped)`;

    try {
      const endedAt = new Date(startedAt.getTime() + result.elapsedMs);
      let posts = extractor.getPosts();

      // Run vision fallback if needed
      const { posts: rescuedPosts, visionStats } = await runVisionFallbackIfNeeded({
        config,
        posts,
        stats,
        runId,
        screenshotDir,
        isDryRun: false,
      });

      // Update posts with rescued posts
      posts = rescuedPosts;

      // Update summary line with rescue status
      if (visionStats) {
        if (visionStats.visionPostsMerged > 0) {
          summaryLine += `, vision rescued ${visionStats.visionPostsMerged} more`;
        } else if (visionStats.apiErrors.length > 0) {
          summaryLine += ', vision rescue failed (see raw.json)';
        }
      }

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
          visionStats,
        });
        newPosts = writeAndCacheResult.newPosts;
        writeResult = writeAndCacheResult.writeResult;
        summaryLine += writeAndCacheResult.summaryFragment;
      } catch (cacheError: any) {
        // Clean up screenshots before exiting
        await cleanupScreenshots(screenshotDir);

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
          visionStats,
        });

        console.log(result.summaryLine);

        // Print any error details (failed writers)
        result.errorDetails.forEach(detail => {
          console.log(detail);
        });

        // Clean up screenshots after all writers complete
        await cleanupScreenshots(screenshotDir);

        if (result.success) {
          process.exit(EXIT_SUCCESS);
        } else {
          process.exit(EXIT_ERROR);
        }
      } catch (summarizerError: any) {
        // Clean up screenshots before exiting
        await cleanupScreenshots(screenshotDir);

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

/**
 * X API source path. Pulls from configured X lists (and optionally bookmarks)
 * instead of scrolling the browser, then feeds results through the same
 * dedup / summarize / write pipeline as the Playwright path.
 *
 * Run ID gets an `-api` suffix so this run's output directory can coexist
 * with a Playwright run started in the same second (supports Phase 2 parallel-
 * run validation).
 */
async function handleScrollXApi(config: Config, flags: ScrollFlags): Promise<void> {
  const isDryRun = flags.dryRun ?? false;

  if (!config.x) {
    console.error('--source x-api requires config.x to be populated.');
    console.error('See projects/scrollproxy/migration-2026-04-x-api.md in SecondBrain for setup.');
    process.exit(EXIT_ERROR);
  }

  // Build source config from the zod-validated config section.
  const xConfig: XSourceConfig = {
    baseUrl: config.x.baseUrl,
    lists: config.x.lists,
    bookmarks: config.x.bookmarks,
  };

  if (xConfig.lists.length === 0 && !xConfig.bookmarks.enabled) {
    console.error('--source x-api requires at least one list in config.x.lists, or bookmarks.enabled=true.');
    process.exit(EXIT_ERROR);
  }

  const startedAt = new Date();
  const runId = `${generateRunId(startedAt)}-api`;

  console.log(
    `x-api pull: ${xConfig.lists.length} list(s)${xConfig.bookmarks.enabled ? ' + bookmarks' : ''}`
  );

  // Pull from X.
  const pullResult = await pullFromXApi(xConfig);
  const posts = flattenPulls(pullResult);
  const endedAt = new Date(pullResult.finishedAt);
  const elapsedMs = endedAt.getTime() - startedAt.getTime();

  // Assemble stats in the shape the writer + downstream expects. No ads,
  // no selector failures, no scroll ticks — this source doesn't have those.
  const stats = {
    postsExtracted: posts.length,
    adsSkipped: 0,
    duplicateHits: 0,
    selectorFailures: [],
  };

  // Per-list breakdown for the summary line.
  const perListSummary = pullResult.pulls
    .map((p) => `${p.tag}=${p.fetched}${p.error ? '(err)' : ''}`)
    .join(' ');
  let summaryLine = `x-api complete: ${posts.length} posts in ${elapsedMs}ms [${perListSummary}]`;

  // If every list errored and we have no posts, bail early.
  const allListsErrored = pullResult.pulls.every((p) => p.error);
  if (allListsErrored && posts.length === 0) {
    console.log(summaryLine);
    console.log('every list errored — nothing to summarize; check auth and list IDs');
    pullResult.pulls.forEach((p) => {
      if (p.error) console.log(`  • ${p.listName} [${p.tag}]: ${p.error}`);
    });
    process.exit(EXIT_ERROR);
  }

  if (isDryRun) {
    console.log(`${summaryLine} (dry-run — skipping write + summarize)`);
    process.exit(EXIT_SUCCESS);
  }

  // Write raw.json + update dedup cache.
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
        elapsedMs,
        tickCount: 0, // API source has no ticks
        minutes: 0,
        dryRun: false,
        source: 'x-api',
        listPulls: pullResult.pulls.map((p) => ({
          tag: p.tag,
          listName: p.listName,
          listId: p.listId,
          fetched: p.fetched,
          error: p.error ?? null,
        })),
      },
    });
    newPosts = writeAndCacheResult.newPosts;
    writeResult = writeAndCacheResult.writeResult;
    summaryLine += writeAndCacheResult.summaryFragment;
  } catch (error: any) {
    console.log(summaryLine);
    console.log(`write failed: ${error.message}`);
    process.exit(EXIT_ERROR);
  }

  // Summarize + run writers. Reuses the same chain as the Playwright path —
  // the summarizer doesn't care which source produced the posts.
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
      visionStats: undefined, // No vision fallback on API source
    });

    console.log(result.summaryLine);
    result.errorDetails.forEach((detail) => console.log(detail));
    process.exit(result.success ? EXIT_SUCCESS : EXIT_ERROR);
  } catch (summarizerError: any) {
    console.log(summaryLine);
    console.log(`summarizer error: ${summarizerError.message}`);
    process.exit(EXIT_ERROR);
  }
}
