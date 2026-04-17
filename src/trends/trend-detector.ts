import type { ThemesStore } from '../state/rolling-themes.js';

/**
 * Schema version for trend reports.
 */
export const TRENDS_SCHEMA_VERSION = 1;

/**
 * Minimum number of runs a theme must appear in to be considered persistent.
 */
export const PERSISTENT_MIN_RUNS = 4;

/**
 * Maximum age (in runs) for a theme to be considered emerging.
 * Theme must first appear within this many most recent runs.
 */
export const EMERGING_MAX_AGE_RUNS = 2;

/**
 * Minimum runs of absence before a theme is considered fading.
 * Theme must be absent from the most recent N runs.
 */
export const FADING_MIN_AGE_RUNS = 3;

/**
 * Maximum number of themes to return in each category.
 */
export const MAX_PER_CATEGORY = 5;

/**
 * Persistent theme metadata.
 */
export interface PersistentTheme {
  theme: string;
  runCount: number;
  firstSeenRunId: string;
  lastSeenRunId: string;
}

/**
 * Emerging theme metadata.
 */
export interface EmergingTheme {
  theme: string;
  firstSeenRunId: string;
}

/**
 * Fading theme metadata.
 */
export interface FadingTheme {
  theme: string;
  lastSeenRunId: string;
  runsSinceLastSeen: number;
}

/**
 * Trend report structure.
 */
export interface TrendReport {
  schemaVersion: 1;
  persistent: PersistentTheme[];
  emerging: EmergingTheme[];
  fading: FadingTheme[];
}

/**
 * Input to the trend detector.
 */
export interface TrendInput {
  store: ThemesStore;
  currentThemes?: string[];
}

/**
 * Internal run representation for trend detection.
 */
interface RunWithThemes {
  runId: string;
  themes: string[];
}

/**
 * Detect trends from the rolling themes store and current run.
 *
 * Pure function - no I/O, no Date.now(), no mutation.
 *
 * @param input - Store and optional current themes
 * @returns Trend report with persistent, emerging, and fading themes
 */
export function detectTrends(input: TrendInput): TrendReport {
  const { store, currentThemes } = input;

  // Build effective window: stored runs + optional current run
  const runs: RunWithThemes[] = [...store.runs];

  if (currentThemes !== undefined) {
    runs.push({
      runId: 'current',
      themes: currentThemes,
    });
  }

  // Return empty report if fewer than 2 total runs
  if (runs.length < 2) {
    return {
      schemaVersion: TRENDS_SCHEMA_VERSION,
      persistent: [],
      emerging: [],
      fading: [],
    };
  }

  // Build theme metadata: count, first seen, last seen
  const themeMetadata = new Map<
    string,
    { count: number; firstSeenRunId: string; lastSeenRunId: string; positions: number[] }
  >();

  runs.forEach((run, index) => {
    run.themes.forEach(theme => {
      const existing = themeMetadata.get(theme);
      if (existing) {
        existing.count++;
        existing.lastSeenRunId = run.runId;
        existing.positions.push(index);
      } else {
        themeMetadata.set(theme, {
          count: 1,
          firstSeenRunId: run.runId,
          lastSeenRunId: run.runId,
          positions: [index],
        });
      }
    });
  });

  // Compute categories
  const persistent: PersistentTheme[] = [];
  const emerging: EmergingTheme[] = [];
  const fading: FadingTheme[] = [];

  const emergingThemes = new Set<string>();
  const fadingThemes = new Set<string>();

  // Emerging: first appeared in last EMERGING_MAX_AGE_RUNS runs AND not in earlier runs
  // emergingWindowStart is the earliest position that counts as "recent"
  const emergingWindowStart = Math.max(0, runs.length - EMERGING_MAX_AGE_RUNS);
  themeMetadata.forEach((meta, theme) => {
    const firstPosition = meta.positions[0];
    // Theme is emerging if it first appeared AFTER emergingWindowStart
    if (firstPosition > emergingWindowStart) {
      emerging.push({
        theme,
        firstSeenRunId: meta.firstSeenRunId,
      });
      emergingThemes.add(theme);
    }
  });

  // Fading: last seen MORE than FADING_MIN_AGE_RUNS runs ago
  // (i.e., runsSinceLastSeen > FADING_MIN_AGE_RUNS)
  themeMetadata.forEach((meta, theme) => {
    const lastPosition = meta.positions[meta.positions.length - 1];
    const runsSinceLastSeen = runs.length - 1 - lastPosition;

    // A theme is fading if it's been absent for MORE than FADING_MIN_AGE_RUNS
    if (runsSinceLastSeen > FADING_MIN_AGE_RUNS && !emergingThemes.has(theme)) {
      fading.push({
        theme,
        lastSeenRunId: meta.lastSeenRunId,
        runsSinceLastSeen,
      });
      fadingThemes.add(theme);
    }
  });

  // Persistent: appeared in at least PERSISTENT_MIN_RUNS runs, not emerging or fading
  themeMetadata.forEach((meta, theme) => {
    if (meta.count >= PERSISTENT_MIN_RUNS && !emergingThemes.has(theme) && !fadingThemes.has(theme)) {
      persistent.push({
        theme,
        runCount: meta.count,
        firstSeenRunId: meta.firstSeenRunId,
        lastSeenRunId: meta.lastSeenRunId,
      });
    }
  });

  // Sort categories
  persistent.sort((a, b) => {
    if (a.runCount !== b.runCount) {
      return b.runCount - a.runCount; // Higher count first
    }
    if (a.lastSeenRunId !== b.lastSeenRunId) {
      return b.lastSeenRunId.localeCompare(a.lastSeenRunId); // More recent first
    }
    return a.theme.localeCompare(b.theme); // Alphabetical
  });

  emerging.sort((a, b) => {
    if (a.firstSeenRunId !== b.firstSeenRunId) {
      return b.firstSeenRunId.localeCompare(a.firstSeenRunId); // Newest first
    }
    return a.theme.localeCompare(b.theme); // Alphabetical
  });

  fading.sort((a, b) => {
    if (a.runsSinceLastSeen !== b.runsSinceLastSeen) {
      return a.runsSinceLastSeen - b.runsSinceLastSeen; // Most recent fade first
    }
    if (a.lastSeenRunId !== b.lastSeenRunId) {
      return b.lastSeenRunId.localeCompare(a.lastSeenRunId); // More recent first
    }
    return a.theme.localeCompare(b.theme); // Alphabetical
  });

  // Cap at MAX_PER_CATEGORY
  return {
    schemaVersion: TRENDS_SCHEMA_VERSION,
    persistent: persistent.slice(0, MAX_PER_CATEGORY),
    emerging: emerging.slice(0, MAX_PER_CATEGORY),
    fading: fading.slice(0, MAX_PER_CATEGORY),
  };
}
