import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expandHomeDir } from '../scroll/scroller.js';

/**
 * Schema version for the rolling themes store file.
 * Bump this when the file format changes.
 */
export const THEMES_SCHEMA_VERSION = 1;

/**
 * Maximum number of runs to keep in the rolling window.
 * FIFO eviction when this limit is reached.
 */
export const MAX_RUNS = 10;

/**
 * Themes extracted from a single run.
 */
export interface RunThemes {
  runId: string;
  endedAt: string;
  themes: string[];
}

/**
 * Rolling themes store structure.
 * Stored as JSON at <stateDir>/rolling-themes.json.
 */
export interface ThemesStore {
  schemaVersion: number;
  runs: RunThemes[];
}

/**
 * Quarantine a corrupt themes file and log the action.
 */
async function quarantineCorruptThemesFile(
  themesPath: string,
  resolvedStateDir: string,
  logMessage: string
): Promise<void> {
  const epochMs = Date.now();
  const corruptPath = join(resolvedStateDir, `rolling-themes.json.corrupt-${epochMs}`);
  await rename(themesPath, corruptPath);
  console.log(logMessage);
}

/**
 * Load the rolling themes store from <stateDir>/rolling-themes.json.
 *
 * Returns an empty store if:
 * - The file does not exist (first run)
 * - The file is corrupt (invalid JSON, wrong schemaVersion)
 *
 * Corrupt files are quarantined to rolling-themes.json.corrupt-<timestamp>.
 */
export async function loadThemesStore(stateDir: string): Promise<ThemesStore> {
  const resolvedStateDir = expandHomeDir(stateDir);
  const themesPath = join(resolvedStateDir, 'rolling-themes.json');

  try {
    const content = await readFile(themesPath, 'utf-8');
    const parsed = JSON.parse(content);

    // Validate schema version
    if (parsed.schemaVersion !== THEMES_SCHEMA_VERSION) {
      await quarantineCorruptThemesFile(
        themesPath,
        resolvedStateDir,
        `rolling themes schema ${parsed.schemaVersion} not supported by this build; quarantined and started fresh`
      );
      return { schemaVersion: THEMES_SCHEMA_VERSION, runs: [] };
    }

    // Validate structure
    if (!Array.isArray(parsed.runs)) {
      throw new Error('runs field is not an array');
    }

    return parsed as ThemesStore;
  } catch (error: any) {
    // File doesn't exist - first run
    if (error.code === 'ENOENT') {
      return { schemaVersion: THEMES_SCHEMA_VERSION, runs: [] };
    }

    // Corrupt file - quarantine and start fresh
    try {
      const epochMs = Date.now();
      await quarantineCorruptThemesFile(
        themesPath,
        resolvedStateDir,
        `rolling themes corrupt; quarantined to rolling-themes.json.corrupt-${epochMs}, starting fresh`
      );
    } catch {
      // If rename fails, just log and continue
      console.log('rolling themes corrupt; starting fresh');
    }

    return { schemaVersion: THEMES_SCHEMA_VERSION, runs: [] };
  }
}

/**
 * Save the rolling themes store to <stateDir>/rolling-themes.json atomically.
 *
 * Uses tmpfile + rename to ensure the store is never partially written.
 * Creates the state directory recursively if it doesn't exist.
 */
export async function saveThemesStore(
  store: ThemesStore,
  stateDir: string
): Promise<{ statePath: string }> {
  const resolvedStateDir = expandHomeDir(stateDir);
  const themesPath = join(resolvedStateDir, 'rolling-themes.json');
  const tmpPath = join(resolvedStateDir, 'rolling-themes.json.tmp');

  // Create state directory if it doesn't exist
  await mkdir(resolvedStateDir, { recursive: true });

  // Serialize with fixed key order and 2-space indentation
  const payload = {
    schemaVersion: store.schemaVersion,
    runs: store.runs.map(run => ({
      runId: run.runId,
      endedAt: run.endedAt,
      themes: run.themes,
    })),
  };
  const content = JSON.stringify(payload, null, 2);

  // Write to tmpfile
  await writeFile(tmpPath, content, 'utf-8');

  // Atomic rename
  await rename(tmpPath, themesPath);

  return { statePath: themesPath };
}

/**
 * Append a run to the store and enforce FIFO eviction at MAX_RUNS.
 *
 * Returns a new store (does not mutate the input).
 * If a run with the same runId exists, it is replaced in place (replay scenario).
 * Otherwise, the run is appended to the end and the oldest run is evicted if needed.
 */
export function appendRun(store: ThemesStore, run: RunThemes): ThemesStore {
  // Check if this runId already exists (replay scenario)
  const existingIndex = store.runs.findIndex(r => r.runId === run.runId);

  let newRuns: RunThemes[];

  if (existingIndex !== -1) {
    // Replace in place
    newRuns = [...store.runs];
    newRuns[existingIndex] = run;
  } else {
    // Append to end
    newRuns = [...store.runs, run];

    // FIFO eviction: keep the newest MAX_RUNS
    if (newRuns.length > MAX_RUNS) {
      newRuns = newRuns.slice(newRuns.length - MAX_RUNS);
    }
  }

  return {
    schemaVersion: store.schemaVersion,
    runs: newRuns,
  };
}

/**
 * Returns a flat list of themes from the newest `limit` runs.
 *
 * Themes are returned in chronological order: oldest run's themes first, newest run's themes last.
 * Duplicates are preserved (the caller decides whether repetition is signal).
 *
 * @param store - The themes store
 * @param limit - Number of most recent runs to include (default: all runs)
 */
export function recentThemes(store: ThemesStore, limit?: number): string[] {
  // Handle limit=0 explicitly
  if (limit === 0) {
    return [];
  }

  const effectiveLimit = limit === undefined ? store.runs.length : Math.min(limit, store.runs.length);

  // Get the last N runs
  const recentRuns = store.runs.slice(-effectiveLimit);

  // Flatten themes from all runs
  return recentRuns.flatMap(run => run.themes);
}
