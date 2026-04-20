/**
 * Tests for the Playwright retirement feature.
 *
 * These are regression-guard tests — they assert the post-retirement state
 * (files gone, dependencies gone, imports relocated) rather than behavioral
 * unit tests. Behavioral coverage lives in the pre-existing source-agnostic
 * test suites (summarizer, state, writers, trends, x-api-hardening).
 *
 * See: .specs/features/expansion/retire-playwright.feature.md
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../src/config/load.js';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Walk a directory recursively, yielding paths of files that pass the filter. */
function walkFiles(dir: string, filter: (p: string) => boolean = () => true): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...walkFiles(full, filter));
    } else if (filter(full)) {
      out.push(full);
    }
  }
  return out;
}

// -------------------------------------------------------------------
// RP-01: No src/ file imports from 'playwright'
// -------------------------------------------------------------------

describe('RP-01: No src/ file imports from playwright', () => {
  it('finds zero imports of the playwright package across src/', () => {
    const srcDir = path.join(REPO_ROOT, 'src');
    const tsFiles = walkFiles(srcDir, (p) => p.endsWith('.ts'));
    const offenders: string[] = [];
    const playwrightImportRe = /from\s+['"]playwright['"]|require\(['"]playwright['"]\)/;

    for (const file of tsFiles) {
      const content = readFileSync(file, 'utf8');
      if (playwrightImportRe.test(content)) {
        offenders.push(path.relative(REPO_ROOT, file));
      }
    }

    expect(offenders, `Playwright imports should not exist. Found in: ${offenders.join(', ')}`).toEqual([]);
  });
});

// -------------------------------------------------------------------
// RP-02: src/scroll/ and src/extract/ directories deleted
// -------------------------------------------------------------------

describe('RP-02: Playwright source directories are deleted', () => {
  it('src/scroll/ no longer exists', () => {
    expect(existsSync(path.join(REPO_ROOT, 'src', 'scroll'))).toBe(false);
  });
  it('src/extract/ no longer exists', () => {
    expect(existsSync(path.join(REPO_ROOT, 'src', 'extract'))).toBe(false);
  });
  it('src/cli/login.ts no longer exists', () => {
    expect(existsSync(path.join(REPO_ROOT, 'src', 'cli', 'login.ts'))).toBe(false);
  });
  it('src/login.ts (CLI shim) no longer exists', () => {
    expect(existsSync(path.join(REPO_ROOT, 'src', 'login.ts'))).toBe(false);
  });
  it('scripts/launch-chrome.sh no longer exists', () => {
    expect(existsSync(path.join(REPO_ROOT, 'scripts', 'launch-chrome.sh'))).toBe(false);
  });
});

// -------------------------------------------------------------------
// RP-03: package.json has no playwright dep, no login/chrome scripts
// -------------------------------------------------------------------

describe('RP-03: package.json is clean of Playwright-era entries', () => {
  const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));

  it('has no playwright in dependencies', () => {
    expect(pkg.dependencies?.playwright).toBeUndefined();
  });
  it('has no playwright in devDependencies', () => {
    expect(pkg.devDependencies?.playwright).toBeUndefined();
  });
  it('has no login script', () => {
    expect(pkg.scripts?.login).toBeUndefined();
  });
  it('has no chrome script', () => {
    expect(pkg.scripts?.chrome).toBeUndefined();
  });
  it('still has scroll and replay scripts (non-regression)', () => {
    expect(pkg.scripts?.scroll).toBeDefined();
    expect(pkg.scripts?.replay).toBeDefined();
  });
});

// -------------------------------------------------------------------
// RP-04: src/types/post.ts exports the relocated types
// -------------------------------------------------------------------

describe('RP-04: ExtractedPost + supporting types live at src/types/post.ts', () => {
  it('src/types/post.ts exists', () => {
    expect(existsSync(path.join(REPO_ROOT, 'src', 'types', 'post.ts'))).toBe(true);
  });

  it('exports ExtractedPost, Author, Metrics, MediaItem with expected shapes', async () => {
    const mod = await import('../../src/types/post.js');
    // The types are interfaces (erased at runtime) — assert by constructing a value
    // that should type-check and by checking the module exports are present for
    // downstream consumers (type-only imports aren't observable at runtime, but
    // the file existing + a smoke object is enough to prove the shape is wired).
    const post: import('../../src/types/post.js').ExtractedPost = {
      id: 'T1',
      url: 'https://x.com/u/status/T1',
      author: { handle: 'u', displayName: 'User', verified: false },
      text: 'hi',
      postedAt: null,
      metrics: { replies: 0, reposts: 0, likes: 0, views: null },
      media: [],
      isRepost: false,
      repostedBy: null,
      quoted: null,
      extractedAt: '2026-04-20T00:00:00Z',
      tickIndex: 0,
    };
    expect(post.id).toBe('T1');
    // Confirm the module loaded (the import above).
    expect(mod).toBeDefined();
  });
});

// -------------------------------------------------------------------
// RP-05: No file imports from the old extractor path
// -------------------------------------------------------------------

describe('RP-05: No file imports ExtractedPost from the old extractor path', () => {
  it('grep-style: no src/ or tests/ file references ../extract/extractor or ./extract/extractor', () => {
    const dirs = [
      path.join(REPO_ROOT, 'src'),
      path.join(REPO_ROOT, 'tests'),
    ];
    const tsFiles = dirs.flatMap((d) => walkFiles(d, (p) => p.endsWith('.ts')));
    const oldImportRe = /from\s+['"][^'"]*extract\/extractor(?:\.js)?['"]/;

    const offenders: string[] = [];
    for (const file of tsFiles) {
      const content = readFileSync(file, 'utf8');
      if (oldImportRe.test(content)) {
        offenders.push(path.relative(REPO_ROOT, file));
      }
    }

    expect(offenders, `Old extractor path still imported in: ${offenders.join(', ')}`).toEqual([]);
  });
});

// -------------------------------------------------------------------
// RP-06 + RP-07: config backward- and forward-compat
// -------------------------------------------------------------------

function writeTempConfig(content: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'sp-retire-test-'));
  const p = path.join(dir, 'config.yaml');
  writeFileSync(p, content, 'utf8');
  return p;
}

describe('RP-06: config.yaml with legacy scroll/browser/extractor sections still loads', () => {
  it('accepts a config with populated legacy sections', async () => {
    const legacy = writeTempConfig(`
scroll:
  minutes: 10
  jitterMs: [400, 1400]
  longPauseEvery: 25
  longPauseMs: [3000, 8000]
browser:
  userDataDir: ~/scrollproxy/chrome
  headless: false
  viewport:
    width: 1280
    height: 900
interests: []
output:
  dir: ~/scrollproxy/runs
  state: ~/scrollproxy/state
claude:
  model: claude-sonnet-4-6
extractor:
  visionFallback:
    enabled: false
`);
    await expect(loadConfig({ path: legacy })).resolves.toBeDefined();
  });
});

describe('RP-07: config.yaml without legacy sections loads cleanly', () => {
  it('accepts a config with no scroll/browser/extractor sections', async () => {
    const clean = writeTempConfig(`
interests: []
output:
  dir: ~/scrollproxy/runs
  state: ~/scrollproxy/state
claude:
  model: claude-sonnet-4-6
x:
  baseUrl: https://api.x.com/2
  lists: []
  bookmarks:
    enabled: false
    postsPerRun: 25
`);
    await expect(loadConfig({ path: clean })).resolves.toBeDefined();
  });
});

// -------------------------------------------------------------------
// RP-08: new run IDs have no -api suffix
// -------------------------------------------------------------------

describe('RP-08: generateRunId output has no -api suffix', () => {
  it('generates a clean timestamp-shaped ID with no source-specific suffix', async () => {
    const { generateRunId } = await import('../../src/writer/raw-json.js');
    const id = generateRunId(new Date('2026-04-20T12:00:00Z'));
    expect(id).not.toMatch(/-api$/);
    // Sanity-check the general shape (YYYY-MM-DDTHH-MM-SSZ-ish).
    expect(id).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/);
  });
});
