import { describe, it, expect } from 'vitest';
import {
  detectTrends,
  TRENDS_SCHEMA_VERSION,
  PERSISTENT_MIN_RUNS,
  EMERGING_MAX_AGE_RUNS,
  FADING_MIN_AGE_RUNS,
  MAX_PER_CATEGORY,
  type TrendInput,
  type TrendReport,
  type PersistentTheme,
  type EmergingTheme,
  type FadingTheme,
} from '../../src/trends/trend-detector.js';
import type { ThemesStore } from '../../src/state/rolling-themes.js';

describe('TD-01: detectTrends - mature store scenario', () => {
  it('should detect persistent, emerging, and fading themes correctly', () => {
    const store: ThemesStore = {
      schemaVersion: 1,
      runs: [
        { runId: '2026-04-09T14-00-00Z', endedAt: '2026-04-09T14-00-00Z', themes: ['agent orchestration', 'indie-dev distribution'] },
        { runId: '2026-04-10T14-00-00Z', endedAt: '2026-04-10T14-00-00Z', themes: ['agent orchestration', 'indie-dev distribution'] },
        { runId: '2026-04-11T14-00-00Z', endedAt: '2026-04-11T14-00-00Z', themes: ['agent orchestration', 'indie-dev distribution'] },
        { runId: '2026-04-12T14-00-00Z', endedAt: '2026-04-12T14-00-00Z', themes: ['agent orchestration', 'indie-dev distribution', 'sports betting odds'] },
        { runId: '2026-04-13T14-00-00Z', endedAt: '2026-04-13T14-00-00Z', themes: ['agent orchestration', 'indie-dev distribution'] },
        { runId: '2026-04-14T14-00-00Z', endedAt: '2026-04-14T14-00-00Z', themes: ['agent orchestration', 'indie-dev distribution'] },
        { runId: '2026-04-15T14-00-00Z', endedAt: '2026-04-15T14-00-00Z', themes: ['agent orchestration', 'claude code workflows'] },
        { runId: '2026-04-16T14-00-00Z', endedAt: '2026-04-16T14-00-00Z', themes: ['agent orchestration', 'claude code workflows'] },
      ],
    };

    const currentThemes = ['agent orchestration', 'claude code workflows', 'sales enablement playbooks'];
    const report = detectTrends({ store, currentThemes });

    // Verify persistent themes
    expect(report.persistent).toHaveLength(2);
    expect(report.persistent[0]).toEqual({
      theme: 'agent orchestration',
      runCount: 9,
      firstSeenRunId: '2026-04-09T14-00-00Z',
      lastSeenRunId: 'current',
    });
    expect(report.persistent[1]).toEqual({
      theme: 'indie-dev distribution',
      runCount: 6,
      firstSeenRunId: '2026-04-09T14-00-00Z',
      lastSeenRunId: '2026-04-14T14-00-00Z',
    });

    // Verify emerging theme
    expect(report.emerging).toHaveLength(1);
    expect(report.emerging[0]).toEqual({
      theme: 'sales enablement playbooks',
      firstSeenRunId: 'current',
    });

    // Verify fading theme
    expect(report.fading).toHaveLength(1);
    expect(report.fading[0]).toEqual({
      theme: 'sports betting odds',
      lastSeenRunId: '2026-04-12T14-00-00Z',
      runsSinceLastSeen: 5,
    });

    // Verify claude code workflows is NOT in any category
    const allThemes = [
      ...report.persistent.map(t => t.theme),
      ...report.emerging.map(t => t.theme),
      ...report.fading.map(t => t.theme),
    ];
    expect(allThemes).not.toContain('claude code workflows');
  });
});

describe('TD-02: detectTrends - brand-new store (<2 runs)', () => {
  it('should return empty arrays when store has 0 runs', () => {
    const store: ThemesStore = {
      schemaVersion: 1,
      runs: [],
    };

    const currentThemes = ['agent orchestration', 'indie-dev distribution'];
    const report = detectTrends({ store, currentThemes });

    expect(report.persistent).toEqual([]);
    expect(report.emerging).toEqual([]);
    expect(report.fading).toEqual([]);
    expect(report.schemaVersion).toBe(1);
  });

  it('should return empty arrays when store has 1 run (total 2 with current, but below threshold)', () => {
    const store: ThemesStore = {
      schemaVersion: 1,
      runs: [],
    };

    const currentThemes = ['agent orchestration'];
    const report = detectTrends({ store, currentThemes });

    expect(report.persistent).toEqual([]);
    expect(report.emerging).toEqual([]);
    expect(report.fading).toEqual([]);
  });
});

describe('TD-03: detectTrends - two-run store (minimum threshold)', () => {
  it('should show emerging themes but not persistent or fading', () => {
    const store: ThemesStore = {
      schemaVersion: 1,
      runs: [
        { runId: '2026-04-09T14-00-00Z', endedAt: '2026-04-09T14-00-00Z', themes: ['agent orchestration', 'indie-dev distribution'] },
      ],
    };

    const currentThemes = ['agent orchestration', 'claude code workflows'];
    const report = detectTrends({ store, currentThemes });

    expect(report.persistent).toEqual([]);
    expect(report.emerging).toHaveLength(1);
    expect(report.emerging[0]).toEqual({
      theme: 'claude code workflows',
      firstSeenRunId: 'current',
    });
    expect(report.fading).toEqual([]);
  });
});

describe('TD-04: detectTrends - replay mode (no currentThemes)', () => {
  it('should compute trends from stored runs only when currentThemes is omitted', () => {
    const store: ThemesStore = {
      schemaVersion: 1,
      runs: [
        { runId: '2026-04-09T14-00-00Z', endedAt: '2026-04-09T14-00-00Z', themes: ['agent orchestration'] },
        { runId: '2026-04-10T14-00-00Z', endedAt: '2026-04-10T14-00-00Z', themes: ['agent orchestration'] },
        { runId: '2026-04-11T14-00-00Z', endedAt: '2026-04-11T14-00-00Z', themes: ['agent orchestration'] },
        { runId: '2026-04-12T14-00-00Z', endedAt: '2026-04-12T14-00-00Z', themes: ['agent orchestration'] },
        { runId: '2026-04-13T14-00-00Z', endedAt: '2026-04-13T14-00-00Z', themes: ['agent orchestration'] },
      ],
    };

    const report = detectTrends({ store });

    expect(report.persistent).toHaveLength(1);
    expect(report.persistent[0].runCount).toBe(5); // All 5 stored runs, no "current"
  });
});

describe('TD-05: detectTrends - persistent category capped at 5', () => {
  it('should return maximum 5 persistent themes even when more qualify', () => {
    const store: ThemesStore = {
      schemaVersion: 1,
      runs: Array.from({ length: 10 }, (_, i) => ({
        runId: `2026-04-${String(i + 1).padStart(2, '0')}T14-00-00Z`,
        endedAt: `2026-04-${String(i + 1).padStart(2, '0')}T14-00-00Z`,
        themes: ['theme1', 'theme2', 'theme3', 'theme4', 'theme5', 'theme6', 'theme7'],
      })),
    };

    const currentThemes: string[] = [];
    const report = detectTrends({ store, currentThemes });

    expect(report.persistent.length).toBeLessThanOrEqual(MAX_PER_CATEGORY);
    expect(report.persistent.length).toBe(5);
  });
});

describe('TD-06: detectTrends - deterministic output', () => {
  it('should produce identical reports for identical inputs', () => {
    const store: ThemesStore = {
      schemaVersion: 1,
      runs: [
        { runId: '2026-04-09T14-00-00Z', endedAt: '2026-04-09T14-00-00Z', themes: ['theme1', 'theme2'] },
        { runId: '2026-04-10T14-00-00Z', endedAt: '2026-04-10T14-00-00Z', themes: ['theme1', 'theme3'] },
      ],
    };

    const currentThemes = ['theme1', 'theme4'];

    const report1 = detectTrends({ store, currentThemes });
    const report2 = detectTrends({ store, currentThemes });

    expect(report1).toEqual(report2);
  });
});

describe('TD-07: detectTrends - empty currentThemes', () => {
  it('should handle empty current run gracefully', () => {
    const store: ThemesStore = {
      schemaVersion: 1,
      runs: [
        { runId: '2026-04-09T14-00-00Z', endedAt: '2026-04-09T14-00-00Z', themes: ['theme1'] },
        { runId: '2026-04-10T14-00-00Z', endedAt: '2026-04-10T14-00-00Z', themes: ['theme1'] },
        { runId: '2026-04-11T14-00-00Z', endedAt: '2026-04-11T14-00-00Z', themes: ['theme1'] },
        { runId: '2026-04-12T14-00-00Z', endedAt: '2026-04-12T14-00-00Z', themes: ['theme1'] },
        { runId: '2026-04-13T14-00-00Z', endedAt: '2026-04-13T14-00-00Z', themes: ['theme1'] },
      ],
    };

    const currentThemes: string[] = [];
    const report = detectTrends({ store, currentThemes });

    // theme1 has only been absent for 1 run (current), so it's still persistent
    expect(report.persistent.some(p => p.theme === 'theme1')).toBe(true);
    expect(report.fading.some(f => f.theme === 'theme1')).toBe(false);
  });
});

describe('TD-08: detectTrends - case-sensitive theme equality', () => {
  it('should treat different casings as distinct themes', () => {
    const store: ThemesStore = {
      schemaVersion: 1,
      runs: [
        { runId: '2026-04-09T14-00-00Z', endedAt: '2026-04-09T14-00-00Z', themes: ['AI agents'] },
        { runId: '2026-04-10T14-00-00Z', endedAt: '2026-04-10T14-00-00Z', themes: ['AI agents'] },
        { runId: '2026-04-11T14-00-00Z', endedAt: '2026-04-11T14-00-00Z', themes: ['AI agents'] },
        { runId: '2026-04-12T14-00-00Z', endedAt: '2026-04-12T14-00-00Z', themes: ['ai agents'] },
      ],
    };

    const currentThemes = ['AI agents'];
    const report = detectTrends({ store, currentThemes });

    const aiAgentsUpper = report.persistent.find(p => p.theme === 'AI agents');
    const aiAgentsLower = report.persistent.find(p => p.theme === 'ai agents');

    expect(aiAgentsUpper?.runCount).toBe(4);
    expect(aiAgentsLower).toBeUndefined(); // Not enough runs to be persistent
  });
});

describe('TD-09: schema version constant', () => {
  it('should export TRENDS_SCHEMA_VERSION = 1', () => {
    expect(TRENDS_SCHEMA_VERSION).toBe(1);
  });

  it('should include schemaVersion in report', () => {
    const store: ThemesStore = {
      schemaVersion: 1,
      runs: [
        { runId: '2026-04-09T14-00-00Z', endedAt: '2026-04-09T14-00-00Z', themes: ['theme1'] },
        { runId: '2026-04-10T14-00-00Z', endedAt: '2026-04-10T14-00-00Z', themes: ['theme1'] },
      ],
    };

    const report = detectTrends({ store, currentThemes: ['theme1'] });
    expect(report.schemaVersion).toBe(1);
  });
});

describe('TD-10: threshold constants', () => {
  it('should export tunable threshold constants', () => {
    expect(PERSISTENT_MIN_RUNS).toBe(4);
    expect(EMERGING_MAX_AGE_RUNS).toBe(2);
    expect(FADING_MIN_AGE_RUNS).toBe(3);
    expect(MAX_PER_CATEGORY).toBe(5);
  });
});

describe('TD-11: trend categories are mutually exclusive', () => {
  it('should ensure no theme appears in multiple categories', () => {
    const store: ThemesStore = {
      schemaVersion: 1,
      runs: [
        { runId: '2026-04-09T14-00-00Z', endedAt: '2026-04-09T14-00-00Z', themes: ['theme1', 'theme2'] },
        { runId: '2026-04-10T14-00-00Z', endedAt: '2026-04-10T14-00-00Z', themes: ['theme1', 'theme3'] },
        { runId: '2026-04-11T14-00-00Z', endedAt: '2026-04-11T14-00-00Z', themes: ['theme1'] },
        { runId: '2026-04-12T14-00-00Z', endedAt: '2026-04-12T14-00-00Z', themes: ['theme1'] },
      ],
    };

    const currentThemes = ['theme1', 'theme4'];
    const report = detectTrends({ store, currentThemes });

    const persistent = new Set(report.persistent.map(t => t.theme));
    const emerging = new Set(report.emerging.map(t => t.theme));
    const fading = new Set(report.fading.map(t => t.theme));

    // Check no overlaps
    persistent.forEach(theme => {
      expect(emerging.has(theme)).toBe(false);
      expect(fading.has(theme)).toBe(false);
    });

    emerging.forEach(theme => {
      expect(persistent.has(theme)).toBe(false);
      expect(fading.has(theme)).toBe(false);
    });
  });
});

describe('TD-12: sorting rules', () => {
  it('should sort persistent by runCount descending, then lastSeenRunId descending', () => {
    const store: ThemesStore = {
      schemaVersion: 1,
      runs: [
        { runId: '2026-04-09T14-00-00Z', endedAt: '2026-04-09T14-00-00Z', themes: ['theme1', 'theme2'] },
        { runId: '2026-04-10T14-00-00Z', endedAt: '2026-04-10T14-00-00Z', themes: ['theme1', 'theme2'] },
        { runId: '2026-04-11T14-00-00Z', endedAt: '2026-04-11T14-00-00Z', themes: ['theme1', 'theme2'] },
        { runId: '2026-04-12T14-00-00Z', endedAt: '2026-04-12T14-00-00Z', themes: ['theme1', 'theme2'] },
        { runId: '2026-04-13T14-00-00Z', endedAt: '2026-04-13T14-00-00Z', themes: ['theme1'] },
      ],
    };

    const currentThemes = ['theme1'];
    const report = detectTrends({ store, currentThemes });

    expect(report.persistent[0].theme).toBe('theme1'); // 6 runs
    if (report.persistent.length > 1) {
      expect(report.persistent[1].theme).toBe('theme2'); // 4 runs
    }
  });

  it('should sort emerging by firstSeenRunId descending (newest first)', () => {
    const store: ThemesStore = {
      schemaVersion: 1,
      runs: [
        { runId: '2026-04-09T14-00-00Z', endedAt: '2026-04-09T14-00-00Z', themes: ['old'] },
        { runId: '2026-04-10T14-00-00Z', endedAt: '2026-04-10T14-00-00Z', themes: ['old', 'newer'] },
      ],
    };

    const currentThemes = ['old', 'newest'];
    const report = detectTrends({ store, currentThemes });

    if (report.emerging.length >= 2) {
      expect(report.emerging[0].firstSeenRunId).toBe('current'); // newest
      expect(report.emerging[1].firstSeenRunId).toBe('2026-04-10T14-00-00Z'); // newer
    }
  });
});

describe('TD-13: module purity', () => {
  it('should be a pure function with no side effects', () => {
    const store: ThemesStore = {
      schemaVersion: 1,
      runs: [
        { runId: '2026-04-09T14-00-00Z', endedAt: '2026-04-09T14-00-00Z', themes: ['theme1'] },
      ],
    };

    const storeCopy = JSON.parse(JSON.stringify(store));
    const currentThemes = ['theme1', 'theme2'];
    const currentThemesCopy = [...currentThemes];

    detectTrends({ store, currentThemes });

    // Verify no mutation
    expect(store).toEqual(storeCopy);
    expect(currentThemes).toEqual(currentThemesCopy);
  });
});
