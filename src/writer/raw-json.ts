import { mkdir, writeFile, rename } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import type { ExtractedPost, SelectorFailure } from '../extract/extractor.js';

/**
 * Run metadata for a scroll session.
 */
export interface RunMeta {
  startedAt: string;
  endedAt: string;
  elapsedMs: number;
  tickCount: number;
  minutes: number;
  dryRun: boolean;
}

/**
 * Extraction statistics for writeRawJson.
 */
interface ExtractionStats {
  postsExtracted: number;
  adsSkipped: number;
  selectorFailures: SelectorFailure[];
  duplicateHits: number;
}

/**
 * Input parameters for writeRawJson.
 */
export interface WriteRawJsonParams {
  outputDir: string;
  runId: string;
  posts: ExtractedPost[];
  stats: ExtractionStats;
  meta: RunMeta;
}

/**
 * Result of writeRawJson.
 */
export interface WriteRawJsonResult {
  runDir: string;
  rawJsonPath: string;
}

/**
 * Schema version 1 payload structure.
 */
interface RawJsonPayload {
  schemaVersion: number;
  runId: string;
  startedAt: string;
  endedAt: string;
  elapsedMs: number;
  tickCount: number;
  config: {
    minutes: number;
    dryRun: boolean;
  };
  stats: {
    postsExtracted: number;
    adsSkipped: number;
    selectorFailures: number;
    duplicateHits: number;
  };
  selectorFailures: SelectorFailure[];
  posts: ExtractedPost[];
}

/**
 * Expand ~ in a path to the user's home directory.
 * Reuses the same logic from src/scroll/scroller.ts for consistency.
 */
function expandHomeDir(path: string): string {
  if (path.startsWith('~/')) {
    return join(homedir(), path.slice(2));
  }
  if (path === '~') {
    return homedir();
  }
  return path;
}

/**
 * Generate a run ID from a timestamp.
 * Returns a UTC timestamp slug in the form YYYY-MM-DDTHH-MM-SSZ
 * (ISO 8601 with : replaced by - for filesystem safety).
 *
 * @param now - Optional date to use (defaults to current time)
 * @returns Run ID string safe for use as a directory name
 */
export function generateRunId(now: Date = new Date()): string {
  // Get ISO string and extract components
  const isoString = now.toISOString();

  // Format: 2026-04-16T14:32:07.123Z -> 2026-04-16T14-32-07Z
  // Split at 'T' to get date and time parts
  const [datePart, timePart] = isoString.split('T');

  // Extract HH:MM:SS from time part (before the milliseconds)
  const timeWithoutMs = timePart.split('.')[0];

  // Replace : with - in time part
  const timeSlug = timeWithoutMs.replace(/:/g, '-');

  // Combine: YYYY-MM-DDTHH-MM-SSZ
  return `${datePart}T${timeSlug}Z`;
}

/**
 * Write raw.json to disk atomically.
 *
 * Creates <outputDir>/<runId>/raw.json with the full scroll session data.
 * Write is atomic (tmpfile → rename) to prevent corruption on crash.
 *
 * @param params - Write parameters
 * @returns Paths to the created run directory and raw.json file
 */
export async function writeRawJson(params: WriteRawJsonParams): Promise<WriteRawJsonResult> {
  const { outputDir, runId, posts, stats, meta } = params;

  // Expand ~ if present
  const resolvedOutputDir = expandHomeDir(outputDir);

  // Create run directory path
  const runDir = join(resolvedOutputDir, runId);

  // Create directory recursively if missing
  await mkdir(runDir, { recursive: true });

  // Build the payload with exact schema version 1 structure
  // Keys are in a fixed order for stable git diffs and jq output
  const payload: RawJsonPayload = {
    schemaVersion: 1,
    runId,
    startedAt: meta.startedAt,
    endedAt: meta.endedAt,
    elapsedMs: meta.elapsedMs,
    tickCount: meta.tickCount,
    config: {
      minutes: meta.minutes,
      dryRun: meta.dryRun,
    },
    stats: {
      postsExtracted: stats.postsExtracted,
      adsSkipped: stats.adsSkipped,
      selectorFailures: stats.selectorFailures.length,
      duplicateHits: stats.duplicateHits,
    },
    selectorFailures: stats.selectorFailures,
    posts,
  };

  // Serialize with 2-space indentation, UTF-8
  const jsonContent = JSON.stringify(payload, null, 2) + '\n';

  // Write atomically: tmpfile → rename
  const rawJsonPath = join(runDir, 'raw.json');
  const tmpPath = rawJsonPath + '.tmp';

  // Write to tmpfile first
  await writeFile(tmpPath, jsonContent, 'utf-8');

  // Rename to final location (atomic on most filesystems)
  await rename(tmpPath, rawJsonPath);

  return {
    runDir,
    rawJsonPath,
  };
}
