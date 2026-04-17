import type { Config } from '../config/schema.js';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { expandHomeDir } from '../scroll/scroller.js';
import { summarizeRun, type SummarizerInput, type RunSummary } from '../summarizer/summarizer.js';
import { loadThemesStore, recentThemes } from '../state/rolling-themes.js';
import { writeSummaryMarkdown } from '../writer/markdown.js';
import type { ExtractedPost } from '../extract/extractor.js';

const EXIT_SUCCESS = 0;
const EXIT_ERROR = 1;

/**
 * Raw JSON payload structure (schema version 1).
 */
interface RawJsonPayload {
  schemaVersion: number;
  runId: string;
  posts: ExtractedPost[];
  [key: string]: any; // Other fields we don't need for replay
}

/**
 * Format a path for display by converting home directory to tilde notation.
 */
function formatDisplayPath(path: string): string {
  return path.replace(expandHomeDir('~'), '~');
}

/**
 * Validate that run-id is a directory name, not a path.
 */
function validateRunId(runId: string): { valid: true } | { valid: false; error: string } {
  if (runId.startsWith('./') || runId.startsWith('../') || runId.startsWith('/')) {
    return {
      valid: false,
      error: `replay: run-id must be a directory name, not a path: ${runId}`,
    };
  }
  return { valid: true };
}

/**
 * Load and parse raw.json from a run directory.
 */
async function loadRawJson(runDir: string, rawJsonPath: string): Promise<
  | { success: true; payload: RawJsonPayload }
  | { success: false; error: string }
> {
  // Check if raw.json exists
  if (!existsSync(rawJsonPath)) {
    return {
      success: false,
      error: `no raw.json in ${formatDisplayPath(runDir)}`,
    };
  }

  // Read and parse
  try {
    const content = await readFile(rawJsonPath, 'utf-8');
    const parsed = JSON.parse(content);

    // Validate schemaVersion
    if (typeof parsed.schemaVersion !== 'number') {
      throw new Error('missing or invalid schemaVersion');
    }

    if (parsed.schemaVersion !== 1) {
      return {
        success: false,
        error: `replay: unsupported raw.json schemaVersion ${parsed.schemaVersion}, expected 1`,
      };
    }

    // Validate posts array exists
    if (!Array.isArray(parsed.posts)) {
      throw new Error('missing or invalid posts array');
    }

    return {
      success: true,
      payload: parsed as RawJsonPayload,
    };
  } catch (error: any) {
    return {
      success: false,
      error: `replay: failed to parse ${formatDisplayPath(rawJsonPath)}: ${error.message}`,
    };
  }
}

/**
 * Write summary.json atomically to the run directory.
 */
async function writeSummaryJson(runDir: string, summary: RunSummary): Promise<void> {
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
 * Handle the replay command.
 *
 * Re-summarizes a saved raw.json without re-scrolling.
 */
export async function handleReplay(config: Config, runId: string, dryRun: boolean = false): Promise<void> {
  // Validate run-id
  const validation = validateRunId(runId);
  if (!validation.valid) {
    console.log(validation.error);
    process.exit(EXIT_ERROR);
  }

  // Resolve run directory
  const resolvedOutputDir = expandHomeDir(config.output.dir);
  const runDir = join(resolvedOutputDir, runId);

  // Check if run directory exists
  if (!existsSync(runDir)) {
    console.log(`no run found: ${formatDisplayPath(runDir)}`);
    process.exit(EXIT_ERROR);
  }

  // Load raw.json
  const rawJsonPath = join(runDir, 'raw.json');
  const rawJsonResult = await loadRawJson(runDir, rawJsonPath);

  if (!rawJsonResult.success) {
    console.log(rawJsonResult.error);
    process.exit(EXIT_ERROR);
  }

  const payload = rawJsonResult.payload;
  const posts = payload.posts;

  // Handle dry-run
  if (dryRun) {
    console.log(`dry-run: replay ${runId} — would re-summarize ${posts.length} posts, writer skipped`);
    process.exit(EXIT_SUCCESS);
  }

  // Load themes store to get prior themes
  const themesStore = await loadThemesStore(config.output.state);
  const priorThemes = recentThemes(themesStore);

  // Build summarizer input
  const summarizerInput: SummarizerInput = {
    posts,
    newPostIds: [], // Replay does not re-partition against dedup cache
    priorThemes,
    interests: config.interests,
    runId,
    model: config.claude.model,
    apiKey: config.claude.apiKey || process.env.ANTHROPIC_API_KEY || '',
  };

  // Call summarizer
  try {
    const summarizerResult = await summarizeRun(summarizerInput);

    if (summarizerResult.status === 'ok') {
      // Write summary.json
      const summaryJsonPath = join(runDir, 'summary.json');
      await writeSummaryJson(runDir, summarizerResult.summary);

      // Write summary.md
      const mdResult = await writeSummaryMarkdown({
        runDir,
        summary: summarizerResult.summary,
        rawJsonPath,
        summaryJsonPath,
        displayRawJsonPath: formatDisplayPath(rawJsonPath),
        displaySummaryJsonPath: formatDisplayPath(summaryJsonPath),
      });

      // Print success message
      const themeCount = summarizerResult.summary.themes.length;
      const worthClickingCount = summarizerResult.summary.worthClicking.length;
      console.log(
        `replayed ${runId}: summarized (${themeCount} themes, ${worthClickingCount} worth clicking) — rendered to ${formatDisplayPath(mdResult.summaryMdPath)}`
      );

      process.exit(EXIT_SUCCESS);
    } else {
      // Summarizer failed - write error file
      await writeSummaryErrorJson(runDir, runId, summarizerResult.reason, summarizerResult.rawResponse);

      // Print error message
      console.log(`replayed ${runId}: summarizer failed: ${summarizerResult.reason}`);

      process.exit(EXIT_ERROR);
    }
  } catch (error: any) {
    // Unexpected error
    console.log(`replay failed: ${error.message}`);
    process.exit(EXIT_ERROR);
  }
}
