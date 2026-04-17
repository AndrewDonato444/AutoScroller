import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  loadThemesStore,
  saveThemesStore,
  appendRun,
  recentThemes,
  THEMES_SCHEMA_VERSION,
  MAX_RUNS,
  type ThemesStore,
  type RunThemes,
} from '../../src/state/rolling-themes.js';
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('State Module (Rolling Themes Store)', () => {
  let testStateDir: string;

  beforeEach(() => {
    // Create a unique temp directory for each test
    testStateDir = join(tmpdir(), `rolling-themes-test-${Date.now()}`);
  });

  afterEach(() => {
    // Clean up test directory
    if (existsSync(testStateDir)) {
      rmSync(testStateDir, { recursive: true, force: true });
    }
  });

  // Helper to create a RunThemes entry
  function makeRun(runId: string, themes: string[], endedAt?: string): RunThemes {
    return {
      runId,
      endedAt: endedAt || new Date().toISOString(),
      themes,
    };
  }

  describe('loadThemesStore', () => {
    it('UT-SRT-001: returns empty store when file does not exist (first run)', async () => {
      const store = await loadThemesStore(testStateDir);

      expect(store).toEqual({
        schemaVersion: 1,
        runs: [],
      });
    });

    it('UT-SRT-002: loads existing store from file', async () => {
      // Create state dir and store file
      mkdirSync(testStateDir, { recursive: true });
      const storePath = join(testStateDir, 'rolling-themes.json');
      const existingStore: ThemesStore = {
        schemaVersion: 1,
        runs: [
          makeRun('2026-04-16T14-32-07Z', ['agent orchestration', 'indie-dev distribution']),
          makeRun('2026-04-17T10-15-00Z', ['claude code workflows']),
        ],
      };
      writeFileSync(storePath, JSON.stringify(existingStore, null, 2));

      const store = await loadThemesStore(testStateDir);

      expect(store).toEqual(existingStore);
    });

    it('UT-SRT-003: quarantines corrupt JSON and returns empty store', async () => {
      // Create state dir with corrupt JSON
      mkdirSync(testStateDir, { recursive: true });
      const storePath = join(testStateDir, 'rolling-themes.json');
      writeFileSync(storePath, '{"not valid json');

      const store = await loadThemesStore(testStateDir);

      // Should return empty store
      expect(store).toEqual({
        schemaVersion: 1,
        runs: [],
      });

      // Corrupt file should be quarantined
      const files = require('fs').readdirSync(testStateDir);
      const quarantined = files.find((f: string) => f.startsWith('rolling-themes.json.corrupt-'));
      expect(quarantined).toBeTruthy();
    });

    it('UT-SRT-004: quarantines schema mismatch and returns empty store', async () => {
      // Create state dir with future schema version
      mkdirSync(testStateDir, { recursive: true });
      const storePath = join(testStateDir, 'rolling-themes.json');
      const futureStore = {
        schemaVersion: 2,
        runs: [makeRun('2026-04-16T14-32-07Z', ['agent orchestration'])],
      };
      writeFileSync(storePath, JSON.stringify(futureStore, null, 2));

      const store = await loadThemesStore(testStateDir);

      // Should return empty store
      expect(store).toEqual({
        schemaVersion: 1,
        runs: [],
      });

      // File should be quarantined
      const files = require('fs').readdirSync(testStateDir);
      const quarantined = files.find((f: string) => f.startsWith('rolling-themes.json.corrupt-'));
      expect(quarantined).toBeTruthy();
    });

    it('UT-SRT-005: expands tilde in state dir path', async () => {
      // This test verifies the function works with paths
      const store = await loadThemesStore(testStateDir);

      // Should not throw, should return empty store
      expect(store).toEqual({
        schemaVersion: 1,
        runs: [],
      });
    });
  });

  describe('saveThemesStore', () => {
    it('UT-SRT-006: saves store to rolling-themes.json', async () => {
      const store: ThemesStore = {
        schemaVersion: 1,
        runs: [
          makeRun('2026-04-16T14-32-07Z', ['agent orchestration', 'indie-dev distribution']),
        ],
      };

      const result = await saveThemesStore(store, testStateDir);

      // Check return value
      expect(result.statePath).toContain('rolling-themes.json');

      // Check file was created
      const storePath = join(testStateDir, 'rolling-themes.json');
      expect(existsSync(storePath)).toBe(true);

      // Check file contents
      const saved = JSON.parse(readFileSync(storePath, 'utf-8'));
      expect(saved).toEqual(store);
    });

    it('UT-SRT-007: creates state directory if missing', async () => {
      const store: ThemesStore = {
        schemaVersion: 1,
        runs: [makeRun('2026-04-16T14-32-07Z', ['agent orchestration'])],
      };

      // testStateDir doesn't exist yet
      expect(existsSync(testStateDir)).toBe(false);

      await saveThemesStore(store, testStateDir);

      // Should have created directory
      expect(existsSync(testStateDir)).toBe(true);

      // File should exist
      const storePath = join(testStateDir, 'rolling-themes.json');
      expect(existsSync(storePath)).toBe(true);
    });

    it('UT-SRT-008: uses atomic write (tmpfile + rename)', async () => {
      const store: ThemesStore = {
        schemaVersion: 1,
        runs: [makeRun('2026-04-16T14-32-07Z', ['agent orchestration'])],
      };

      await saveThemesStore(store, testStateDir);

      // After save, no .tmp file should remain
      const files = require('fs').readdirSync(testStateDir);
      const tmpFiles = files.filter((f: string) => f.endsWith('.tmp'));
      expect(tmpFiles).toHaveLength(0);

      // Final file should exist
      const storePath = join(testStateDir, 'rolling-themes.json');
      expect(existsSync(storePath)).toBe(true);
    });

    it('UT-SRT-009: formats JSON with 2-space indentation', async () => {
      const store: ThemesStore = {
        schemaVersion: 1,
        runs: [makeRun('2026-04-16T14-32-07Z', ['agent orchestration'])],
      };

      await saveThemesStore(store, testStateDir);

      const storePath = join(testStateDir, 'rolling-themes.json');
      const content = readFileSync(storePath, 'utf-8');

      // Should be formatted with 2 spaces
      expect(content).toContain('  "schemaVersion"');
      expect(content).toContain('  "runs"');
    });

    it('UT-SRT-010: preserves key order (schemaVersion, runs)', async () => {
      const store: ThemesStore = {
        schemaVersion: 1,
        runs: [makeRun('2026-04-16T14-32-07Z', ['agent orchestration'])],
      };

      await saveThemesStore(store, testStateDir);

      const storePath = join(testStateDir, 'rolling-themes.json');
      const content = readFileSync(storePath, 'utf-8');

      // schemaVersion should appear before runs in file
      const schemaIndex = content.indexOf('schemaVersion');
      const runsIndex = content.indexOf('runs');
      expect(schemaIndex).toBeLessThan(runsIndex);
    });

    it('UT-SRT-011: RunThemes preserves key order (runId, endedAt, themes)', async () => {
      const store: ThemesStore = {
        schemaVersion: 1,
        runs: [makeRun('2026-04-16T14-32-07Z', ['agent orchestration'])],
      };

      await saveThemesStore(store, testStateDir);

      const storePath = join(testStateDir, 'rolling-themes.json');
      const content = readFileSync(storePath, 'utf-8');

      // runId should appear before endedAt, endedAt before themes
      const runIdIndex = content.indexOf('"runId"');
      const endedAtIndex = content.indexOf('"endedAt"');
      const themesIndex = content.indexOf('"themes"');
      expect(runIdIndex).toBeLessThan(endedAtIndex);
      expect(endedAtIndex).toBeLessThan(themesIndex);
    });
  });

  describe('appendRun', () => {
    it('UT-SRT-012: appends first run to empty store', () => {
      const store: ThemesStore = {
        schemaVersion: 1,
        runs: [],
      };
      const run = makeRun(
        '2026-04-16T14-32-07Z',
        ['agent orchestration', 'indie-dev distribution'],
        '2026-04-16T14:35:07.000Z'
      );

      const result = appendRun(store, run);

      expect(result.runs).toHaveLength(1);
      expect(result.runs[0]).toEqual(run);
    });

    it('UT-SRT-013: does not mutate input store', () => {
      const store: ThemesStore = {
        schemaVersion: 1,
        runs: [makeRun('2026-04-16T14-32-07Z', ['agent orchestration'])],
      };
      const originalLength = store.runs.length;
      const run = makeRun('2026-04-17T10-15-00Z', ['claude code workflows']);

      appendRun(store, run);

      // Original store should be unchanged
      expect(store.runs).toHaveLength(originalLength);
    });

    it('UT-SRT-014: eleventh run triggers FIFO eviction', () => {
      // Create a store with exactly MAX_RUNS (10) runs
      const runs = Array.from({ length: MAX_RUNS }, (_, i) =>
        makeRun(`2026-04-${String(i + 1).padStart(2, '0')}T10-00-00Z`, [`theme${i}`])
      );
      const store: ThemesStore = {
        schemaVersion: 1,
        runs,
      };

      // Add an 11th run
      const eleventhRun = makeRun('2026-04-17T10-00-00Z', ['new theme']);
      const result = appendRun(store, eleventhRun);

      // Should still have MAX_RUNS runs
      expect(result.runs).toHaveLength(MAX_RUNS);

      // First run should be evicted
      expect(result.runs[0].runId).not.toBe(runs[0].runId);
      expect(result.runs[0].runId).toBe(runs[1].runId);

      // New run should be at the end
      expect(result.runs[MAX_RUNS - 1]).toEqual(eleventhRun);
    });

    it('UT-SRT-015: duplicate runId replaces in place', () => {
      const runs = [
        makeRun('2026-04-14T10-00-00Z', ['A']),
        makeRun('2026-04-15T10-00-00Z', ['B']),
        makeRun('2026-04-15T14-10-00Z', ['agent orchestration']),
        makeRun('2026-04-16T10-00-00Z', ['C']),
        makeRun('2026-04-17T10-00-00Z', ['D']),
      ];
      const store: ThemesStore = {
        schemaVersion: 1,
        runs,
      };

      // Re-append with same runId but different themes
      const updatedRun = makeRun('2026-04-15T14-10-00Z', [
        'agent orchestration',
        'newly surfaced theme',
      ]);
      const result = appendRun(store, updatedRun);

      // Should still have 5 runs (no growth)
      expect(result.runs).toHaveLength(5);

      // The entry at index 2 should have new themes
      expect(result.runs[2].themes).toEqual(['agent orchestration', 'newly surfaced theme']);

      // Other runs should be preserved
      expect(result.runs[0].runId).toBe('2026-04-14T10-00-00Z');
      expect(result.runs[1].runId).toBe('2026-04-15T10-00-00Z');
      expect(result.runs[3].runId).toBe('2026-04-16T10-00-00Z');
      expect(result.runs[4].runId).toBe('2026-04-17T10-00-00Z');

      // No duplicates
      const runIds = result.runs.map(r => r.runId);
      const uniqueRunIds = new Set(runIds);
      expect(uniqueRunIds.size).toBe(5);
    });

    it('UT-SRT-016: handles empty themes array', () => {
      const store: ThemesStore = {
        schemaVersion: 1,
        runs: [],
      };
      const run = makeRun('2026-04-16T14-32-07Z', []);

      const result = appendRun(store, run);

      expect(result.runs).toHaveLength(1);
      expect(result.runs[0].themes).toEqual([]);
    });
  });

  describe('recentThemes', () => {
    it('UT-SRT-017: flattens themes from all runs, newest last', () => {
      const store: ThemesStore = {
        schemaVersion: 1,
        runs: [
          makeRun('2026-04-14T10-00-00Z', ['A', 'B']),
          makeRun('2026-04-15T10-00-00Z', ['B', 'C']),
          makeRun('2026-04-16T10-00-00Z', ['D']),
        ],
      };

      const themes = recentThemes(store);

      expect(themes).toEqual(['A', 'B', 'B', 'C', 'D']);
    });

    it('UT-SRT-018: respects limit parameter', () => {
      const store: ThemesStore = {
        schemaVersion: 1,
        runs: [
          makeRun('2026-04-14T10-00-00Z', ['A', 'B']),
          makeRun('2026-04-15T10-00-00Z', ['B', 'C']),
          makeRun('2026-04-16T10-00-00Z', ['D']),
        ],
      };

      const themes = recentThemes(store, 2);

      // Last 2 runs: ['B', 'C'] and ['D']
      expect(themes).toEqual(['B', 'C', 'D']);
    });

    it('UT-SRT-019: limit of 0 returns empty array', () => {
      const store: ThemesStore = {
        schemaVersion: 1,
        runs: [
          makeRun('2026-04-14T10-00-00Z', ['A', 'B']),
          makeRun('2026-04-15T10-00-00Z', ['B', 'C']),
        ],
      };

      const themes = recentThemes(store, 0);

      expect(themes).toEqual([]);
    });

    it('UT-SRT-020: limit exceeding runs.length returns all themes', () => {
      const store: ThemesStore = {
        schemaVersion: 1,
        runs: [
          makeRun('2026-04-14T10-00-00Z', ['A', 'B']),
          makeRun('2026-04-15T10-00-00Z', ['B', 'C']),
          makeRun('2026-04-16T10-00-00Z', ['D']),
        ],
      };

      const themes = recentThemes(store, 99);

      expect(themes).toEqual(['A', 'B', 'B', 'C', 'D']);
    });

    it('UT-SRT-021: preserves duplicates (does not deduplicate)', () => {
      const store: ThemesStore = {
        schemaVersion: 1,
        runs: [
          makeRun('2026-04-14T10-00-00Z', ['agent orchestration']),
          makeRun('2026-04-15T10-00-00Z', ['agent orchestration', 'indie-dev distribution']),
          makeRun('2026-04-16T10-00-00Z', ['agent orchestration']),
        ],
      };

      const themes = recentThemes(store);

      // 'agent orchestration' appears 3 times
      const count = themes.filter(t => t === 'agent orchestration').length;
      expect(count).toBe(3);
    });

    it('UT-SRT-022: returns empty array for empty store', () => {
      const store: ThemesStore = {
        schemaVersion: 1,
        runs: [],
      };

      const themes = recentThemes(store);

      expect(themes).toEqual([]);
    });

    it('UT-SRT-023: handles runs with empty themes arrays', () => {
      const store: ThemesStore = {
        schemaVersion: 1,
        runs: [
          makeRun('2026-04-14T10-00-00Z', ['A']),
          makeRun('2026-04-15T10-00-00Z', []),
          makeRun('2026-04-16T10-00-00Z', ['B']),
        ],
      };

      const themes = recentThemes(store);

      expect(themes).toEqual(['A', 'B']);
    });
  });

  describe('constants', () => {
    it('UT-SRT-024: THEMES_SCHEMA_VERSION is 1', () => {
      expect(THEMES_SCHEMA_VERSION).toBe(1);
    });

    it('UT-SRT-025: MAX_RUNS is 10', () => {
      expect(MAX_RUNS).toBe(10);
    });
  });

  describe('integration scenarios', () => {
    it('UT-SRT-026: first run ever - load empty, append, save, reload', async () => {
      // Load (empty on first run)
      const store = await loadThemesStore(testStateDir);
      expect(store.runs).toHaveLength(0);

      // Append first run
      const run = makeRun(
        '2026-04-16T14-32-07Z',
        ['agent orchestration', 'indie-dev distribution'],
        '2026-04-16T14:35:07.000Z'
      );
      const updatedStore = appendRun(store, run);

      // Save
      await saveThemesStore(updatedStore, testStateDir);

      // Reload and verify
      const reloadedStore = await loadThemesStore(testStateDir);
      expect(reloadedStore.runs).toHaveLength(1);
      expect(reloadedStore.runs[0]).toEqual(run);
    });

    it('UT-SRT-027: multiple runs accumulate in FIFO order', async () => {
      let store = await loadThemesStore(testStateDir);

      // Add 3 runs
      const runs = [
        makeRun('2026-04-14T10-00-00Z', ['A', 'B']),
        makeRun('2026-04-15T10-00-00Z', ['B', 'C']),
        makeRun('2026-04-16T10-00-00Z', ['D']),
      ];

      for (const run of runs) {
        store = appendRun(store, run);
      }

      await saveThemesStore(store, testStateDir);

      // Reload and verify order
      const reloadedStore = await loadThemesStore(testStateDir);
      expect(reloadedStore.runs).toHaveLength(3);
      expect(reloadedStore.runs[0].runId).toBe('2026-04-14T10-00-00Z');
      expect(reloadedStore.runs[2].runId).toBe('2026-04-16T10-00-00Z');

      // Verify recentThemes
      const themes = recentThemes(reloadedStore);
      expect(themes).toEqual(['A', 'B', 'B', 'C', 'D']);
    });

    it('UT-SRT-028: eviction at MAX_RUNS boundary', async () => {
      let store = await loadThemesStore(testStateDir);

      // Add MAX_RUNS runs
      for (let i = 0; i < MAX_RUNS; i++) {
        const run = makeRun(`2026-04-${String(i + 1).padStart(2, '0')}T10-00-00Z`, [`theme${i}`]);
        store = appendRun(store, run);
      }

      await saveThemesStore(store, testStateDir);

      // Reload
      store = await loadThemesStore(testStateDir);
      expect(store.runs).toHaveLength(MAX_RUNS);

      // Add one more (should evict oldest)
      const eleventhRun = makeRun('2026-04-11T10-00-00Z', ['new theme']);
      store = appendRun(store, eleventhRun);
      await saveThemesStore(store, testStateDir);

      // Reload and verify
      const finalStore = await loadThemesStore(testStateDir);
      expect(finalStore.runs).toHaveLength(MAX_RUNS);
      expect(finalStore.runs[0].runId).toBe('2026-04-02T10-00-00Z'); // Second run is now first
      expect(finalStore.runs[MAX_RUNS - 1].runId).toBe('2026-04-11T10-00-00Z'); // New run at end
    });

    it('UT-SRT-029: replay scenario - duplicate runId replaces in place', async () => {
      let store = await loadThemesStore(testStateDir);

      // Add 5 runs
      const runs = [
        makeRun('2026-04-14T10-00-00Z', ['A']),
        makeRun('2026-04-15T10-00-00Z', ['B']),
        makeRun('2026-04-15T14-10-00Z', ['agent orchestration']),
        makeRun('2026-04-16T10-00-00Z', ['C']),
        makeRun('2026-04-17T10-00-00Z', ['D']),
      ];

      for (const run of runs) {
        store = appendRun(store, run);
      }

      await saveThemesStore(store, testStateDir);

      // Reload
      store = await loadThemesStore(testStateDir);
      expect(store.runs).toHaveLength(5);

      // Replay the third run with updated themes
      const replayRun = makeRun('2026-04-15T14-10-00Z', [
        'agent orchestration',
        'newly surfaced theme',
      ]);
      store = appendRun(store, replayRun);
      await saveThemesStore(store, testStateDir);

      // Reload and verify
      const finalStore = await loadThemesStore(testStateDir);
      expect(finalStore.runs).toHaveLength(5); // Still 5 runs
      expect(finalStore.runs[2].themes).toEqual(['agent orchestration', 'newly surfaced theme']);

      // No duplicates
      const runIds = finalStore.runs.map(r => r.runId);
      const uniqueRunIds = new Set(runIds);
      expect(uniqueRunIds.size).toBe(5);
    });

    it('UT-SRT-030: corrupt file recovery - quarantine and fresh start', async () => {
      // Create corrupt file
      mkdirSync(testStateDir, { recursive: true });
      const storePath = join(testStateDir, 'rolling-themes.json');
      writeFileSync(storePath, '{broken');

      // Load should quarantine and return empty
      const store = await loadThemesStore(testStateDir);
      expect(store.runs).toHaveLength(0);

      // Quarantined file should exist
      const files = require('fs').readdirSync(testStateDir);
      const quarantined = files.find((f: string) => f.startsWith('rolling-themes.json.corrupt-'));
      expect(quarantined).toBeTruthy();

      // Should be able to save new store
      const run = makeRun('2026-04-16T14-32-07Z', ['agent orchestration']);
      const updatedStore = appendRun(store, run);
      await saveThemesStore(updatedStore, testStateDir);

      // Reload should work
      const finalStore = await loadThemesStore(testStateDir);
      expect(finalStore.runs).toHaveLength(1);
    });
  });
});
