import type { Config } from '../config/schema.js';
import type { ExtractedPost } from '../types/post.js';
import { writeRawJson, generateRunId } from '../writer/raw-json.js';
import { loadDedupCache, saveDedupCache, partitionPosts, appendHashes } from '../state/dedup-cache.js';
import { summarizeRun, type SummarizerInput } from '../summarizer/summarizer.js';
import { loadThemesStore, saveThemesStore, appendRun, recentThemes } from '../state/rolling-themes.js';
import { detectTrends } from '../trends/trend-detector.js';
import { runWriters, type Writer, type WriteContext } from '../writer/writer.js';
import { markdownWriter } from '../writer/markdown.js';
import { createNotionWriter } from '../writer/notion.js';
import { pullFromXApi, flattenPulls, type XSourceConfig } from '../sources/xListSource.js';
import { expandHomeDir } from '../lib/expandHomeDir.js';
import { writeFile, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export interface ScrollFlags {
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
async function writeSummaryJson(runDir: string, summary: unknown): Promise<void> {
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
  stats: {
    postsExtracted: number;
    adsSkipped: number;
    duplicateHits: number;
    selectorFailures: never[];
  };
  meta: import('../writer/raw-json.js').RunMeta;
}): Promise<{
  writeResult: Awaited<ReturnType<typeof writeRawJson>>;
  newPosts: ExtractedPost[];
  seenPosts: ExtractedPost[];
  summaryFragment: string;
}> {
  const { outputDir, stateDir, runId, posts, stats, meta } = params;

  const writeResult = await writeRawJson({
    outputDir,
    runId,
    posts,
    stats,
    meta,
  });

  const { newPosts, seenPosts, summaryFragment } = await updateDedupCacheAndGetSummary(
    posts,
    stateDir,
    writeResult.rawJsonPath
  );

  return { writeResult, newPosts, seenPosts, summaryFragment };
}

/**
 * Run summarizer and handle success/error paths including writer orchestration.
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

    return { success: markdownSucceeded, summaryLine: updatedSummaryLine, errorDetails };
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
 * Pulls posts from the X API Owned Reads endpoints (the only source since
 * April 2026 when Playwright was retired), passes them through dedup →
 * summarize → write, and exits.
 *
 * With --dry-run: pulls from the API and prints per-list counts, then
 * exits without writing or summarizing.
 */
export async function handleScroll(config: Config, flags: ScrollFlags): Promise<void> {
  const isDryRun = flags.dryRun ?? false;

  if (!config.x) {
    console.error('scroll requires config.x to be populated.');
    console.error('See projects/scrollproxy/migration-2026-04-x-api.md in SecondBrain for setup.');
    process.exit(EXIT_ERROR);
  }

  const xConfig: XSourceConfig = {
    baseUrl: config.x.baseUrl,
    lists: config.x.lists,
    bookmarks: config.x.bookmarks,
  };

  if (xConfig.lists.length === 0 && !xConfig.bookmarks.enabled) {
    console.error('scroll requires at least one list in config.x.lists, or bookmarks.enabled=true.');
    process.exit(EXIT_ERROR);
  }

  const startedAt = new Date();
  const runId = generateRunId(startedAt);

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
    selectorFailures: [] as never[],
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

  // Summarize + run writers. The summarizer doesn't care which source produced the posts.
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
    result.errorDetails.forEach((detail) => console.log(detail));
    process.exit(result.success ? EXIT_SUCCESS : EXIT_ERROR);
  } catch (summarizerError: any) {
    console.log(summaryLine);
    console.log(`summarizer error: ${summarizerError.message}`);
    process.exit(EXIT_ERROR);
  }
}
