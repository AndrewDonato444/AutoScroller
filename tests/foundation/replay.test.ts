import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '../..');

let testTmpDir: string;
let testHomeDir: string;
let testRepoRoot: string;
let testConfigDir: string;
let testRunsDir: string;
let testStateDir: string;

/**
 * Helper to run CLI and capture output/exit code
 */
function runCli(args: string[], options: { configPath?: string; env?: Record<string, string> } = {}): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number | null;
}> {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      HOME: testHomeDir,
      PWD: testRepoRoot,
      ANTHROPIC_API_KEY: 'test-api-key',
      ...options.env,
    };

    const child = spawn('tsx', [join(projectRoot, 'src/cli/index.ts'), ...args], {
      cwd: testRepoRoot,
      env,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (exitCode) => {
      resolve({ stdout, stderr, exitCode });
    });
  });
}

/**
 * Create a minimal valid config.yaml for testing
 */
function createTestConfig(configPath: string, overrides: Record<string, any> = {}) {
  const config = {
    scroll: {
      minutes: 10,
      jitterMs: [400, 1400],
      longPauseEvery: 25,
      longPauseMs: [3000, 8000],
    },
    browser: {
      userDataDir: join(testConfigDir, 'browser'),
      headless: true,
      viewport: { width: 1920, height: 1080 },
    },
    interests: ['TypeScript', 'Rust'],
    output: {
      dir: testRunsDir,
      state: testStateDir,
      format: 'markdown',
    },
    claude: {
      model: 'claude-sonnet-4-6',
    },
    ...overrides,
  };

  const yaml = `scroll:
  minutes: ${config.scroll.minutes}
  jitterMs: [${config.scroll.jitterMs.join(', ')}]
  longPauseEvery: ${config.scroll.longPauseEvery}
  longPauseMs: [${config.scroll.longPauseMs.join(', ')}]

browser:
  userDataDir: ${config.browser.userDataDir}
  headless: ${config.browser.headless}
  viewport:
    width: ${config.browser.viewport.width}
    height: ${config.browser.viewport.height}

interests:
${config.interests.map((i: string) => `  - ${i}`).join('\n')}

output:
  dir: ${config.output.dir}
  state: ${config.output.state}
  format: ${config.output.format}

claude:
  model: ${config.claude.model}
`;

  writeFileSync(configPath, yaml, 'utf-8');
}

/**
 * Create a valid raw.json file for testing
 */
function createTestRawJson(runDir: string, options: {
  schemaVersion?: number;
  postCount?: number;
  malformed?: boolean;
} = {}) {
  const { schemaVersion = 1, postCount = 84, malformed = false } = options;

  if (malformed) {
    writeFileSync(join(runDir, 'raw.json'), '{{{invalid', 'utf-8');
    return;
  }

  const posts = Array.from({ length: postCount }, (_, i) => ({
    id: `post-${i}`,
    url: `https://x.com/test/status/${i}`,
    author: {
      handle: '@testuser',
      displayName: 'Test User',
      verified: false,
    },
    text: `Test post ${i}`,
    postedAt: '2026-04-17T09:00:00.000Z',
    tickIndex: i,
    metrics: { replies: 0, reposts: 0, likes: 0, views: null },
    media: [],
    isRepost: false,
    repostedBy: null,
    quoted: null,
  }));

  const payload = {
    schemaVersion,
    runId: '2026-04-17T09-02-14Z',
    startedAt: '2026-04-17T09:02:14.000Z',
    endedAt: '2026-04-17T09:12:14.000Z',
    elapsedMs: 600000,
    tickCount: 600,
    config: { minutes: 10, dryRun: false },
    stats: { postsExtracted: postCount, adsSkipped: 6, selectorFailures: 0, duplicateHits: 0 },
    selectorFailures: [],
    posts,
  };

  writeFileSync(join(runDir, 'raw.json'), JSON.stringify(payload, null, 2), 'utf-8');
}

/**
 * Create a summary.json file for testing
 */
function createTestSummaryJson(runDir: string) {
  const summary = {
    schemaVersion: 1,
    runId: '2026-04-17T09-02-14Z',
    summarizedAt: '2026-04-17T09:12:30.000Z',
    model: 'claude-sonnet-4-6',
    themes: ['TypeScript', 'Rust', 'Testing'],
    worthClicking: [],
    voices: [],
    noise: { count: 0, examples: [] },
    newVsSeen: { newCount: 38, seenCount: 46 },
    feedVerdict: 'mixed',
  };

  writeFileSync(join(runDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf-8');
}

/**
 * Create a summary.md file for testing
 */
function createTestSummaryMd(runDir: string) {
  writeFileSync(join(runDir, 'summary.md'), '# Test Summary\n', 'utf-8');
}

/**
 * Create a summary.error.json file for testing
 */
function createTestSummaryErrorJson(runDir: string, reason: string = 'rate_limited') {
  const errorData = {
    schemaVersion: 1,
    runId: '2026-04-17T09-02-14Z',
    at: '2026-04-17T09:12:30.000Z',
    reason,
  };

  writeFileSync(join(runDir, 'summary.error.json'), JSON.stringify(errorData, null, 2), 'utf-8');
}

/**
 * Create a rolling themes store for testing
 */
function createTestThemesStore(options: { runCount?: number } = {}) {
  const { runCount = 3 } = options;

  const runs = Array.from({ length: runCount }, (_, i) => ({
    runId: `2026-04-${10 + i}T09-02-14Z`,
    endedAt: `2026-04-${10 + i}T09:12:14.000Z`,
    themes: [`theme-${i}-1`, `theme-${i}-2`],
  }));

  const store = {
    schemaVersion: 1,
    runs,
  };

  mkdirSync(testStateDir, { recursive: true });
  writeFileSync(join(testStateDir, 'rolling-themes.json'), JSON.stringify(store, null, 2), 'utf-8');
}

beforeEach(() => {
  // Create unique test directories for each test
  testTmpDir = join(tmpdir(), 'scrollproxy-replay-test-' + Date.now());
  testHomeDir = join(testTmpDir, 'home');
  testRepoRoot = join(testTmpDir, 'repo');
  testConfigDir = join(testHomeDir, 'scrollproxy');
  testRunsDir = join(testConfigDir, 'runs');
  testStateDir = join(testConfigDir, 'state');

  // Create test directories
  mkdirSync(testHomeDir, { recursive: true });
  mkdirSync(testRepoRoot, { recursive: true });
  mkdirSync(testConfigDir, { recursive: true });
  mkdirSync(testRunsDir, { recursive: true });
  mkdirSync(testStateDir, { recursive: true });
});

afterEach(() => {
  // Clean up test directories
  if (existsSync(testTmpDir)) {
    rmSync(testTmpDir, { recursive: true, force: true });
  }
});

describe('Replay Command (REPLAY-*)', () => {
  const hasApiKey = Boolean(process.env.ANTHROPIC_API_KEY);

  it.skipIf(!hasApiKey)('REPLAY-1: happy-path replay — raw.json on disk, Claude succeeds, summary.md is re-rendered', async () => {
    // Given: config, run directory with raw.json, themes store
    const configPath = join(testRepoRoot, 'config.yaml');
    createTestConfig(configPath);

    const runId = '2026-04-17T09-02-14Z';
    const runDir = join(testRunsDir, runId);
    mkdirSync(runDir, { recursive: true });
    createTestRawJson(runDir, { postCount: 84 });
    createTestThemesStore({ runCount: 3 });

    // Record themes store mtime before replay
    const themesStorePath = join(testStateDir, 'rolling-themes.json');
    const themesStoreBeforeStat = statSync(themesStorePath);
    const themesStoreBeforeContent = readFileSync(themesStorePath, 'utf-8');

    // When: run replay command
    const result = await runCli(['replay', runId, '--config', configPath]);

    // Then: exit 0
    expect(result.exitCode).toBe(0);

    // And: summary.json is created
    expect(existsSync(join(runDir, 'summary.json'))).toBe(true);
    const summaryJson = JSON.parse(readFileSync(join(runDir, 'summary.json'), 'utf-8'));
    expect(summaryJson.schemaVersion).toBe(1);
    expect(summaryJson.runId).toBe(runId);

    // And: summary.md is created
    expect(existsSync(join(runDir, 'summary.md'))).toBe(true);
    const summaryMd = readFileSync(join(runDir, 'summary.md'), 'utf-8');
    expect(summaryMd).toContain('# ScrollProxy');
    expect(summaryMd).toContain('## Themes');

    // And: stdout contains success message
    expect(result.stdout).toContain(`replayed ${runId}:`);
    expect(result.stdout).toContain('summarized');
    expect(result.stdout).toContain('themes');
    expect(result.stdout).toContain('worth clicking');
    expect(result.stdout).toContain('summary.md');

    // And: rolling themes store is NOT updated (mtime and content unchanged)
    const themesStoreAfterStat = statSync(themesStorePath);
    const themesStoreAfterContent = readFileSync(themesStorePath, 'utf-8');
    expect(themesStoreAfterContent).toBe(themesStoreBeforeContent);
    // Note: mtime can be tricky to test due to filesystem granularity, but content check is sufficient
  }, 30000);

  it.skipIf(!hasApiKey)('REPLAY-2: recovery replay — original scroll hit rate-limit, replay finishes the job', async () => {
    // Given: config, run directory with raw.json and summary.error.json
    const configPath = join(testRepoRoot, 'config.yaml');
    createTestConfig(configPath);

    const runId = '2026-04-17T09-02-14Z';
    const runDir = join(testRunsDir, runId);
    mkdirSync(runDir, { recursive: true });
    createTestRawJson(runDir);
    createTestSummaryErrorJson(runDir, 'rate_limited');
    createTestThemesStore();

    // When: run replay command
    const result = await runCli(['replay', runId, '--config', configPath]);

    // Then: exit 0
    expect(result.exitCode).toBe(0);

    // And: summary.json is created
    expect(existsSync(join(runDir, 'summary.json'))).toBe(true);

    // And: summary.md is created
    expect(existsSync(join(runDir, 'summary.md'))).toBe(true);

    // And: summary.error.json from original run remains
    expect(existsSync(join(runDir, 'summary.error.json'))).toBe(true);
    const errorJson = JSON.parse(readFileSync(join(runDir, 'summary.error.json'), 'utf-8'));
    expect(errorJson.reason).toBe('rate_limited');

    // And: stdout contains success message
    expect(result.stdout).toContain(`replayed ${runId}:`);
    expect(result.stdout).toContain('summarized');
  }, 30000);

  it('REPLAY-3: run id does not exist — fails fast with the path', async () => {
    // Given: config, runs directory exists but no run with that id
    const configPath = join(testRepoRoot, 'config.yaml');
    createTestConfig(configPath);

    // When: run replay with nonexistent run-id
    const result = await runCli(['replay', 'nonesuch', '--config', configPath]);

    // Then: exit 1
    expect(result.exitCode).toBe(1);

    // And: stdout contains error with path
    expect(result.stdout).toContain('no run found:');
    expect(result.stdout).toContain('nonesuch');
  }, 10000);

  it('REPLAY-4: run directory exists but raw.json does not — fails fast', async () => {
    // Given: config, run directory exists with raw.json.tmp but no raw.json
    const configPath = join(testRepoRoot, 'config.yaml');
    createTestConfig(configPath);

    const runId = '2026-04-17T09-02-14Z';
    const runDir = join(testRunsDir, runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'raw.json.tmp'), '{}', 'utf-8'); // Partial write

    // When: run replay command
    const result = await runCli(['replay', runId, '--config', configPath]);

    // Then: exit 1
    expect(result.exitCode).toBe(1);

    // And: stdout contains error
    expect(result.stdout).toContain('no raw.json in');
    expect(result.stdout).toContain(runId);

    // And: raw.json.tmp is NOT auto-promoted
    expect(existsSync(join(runDir, 'raw.json'))).toBe(false);
    expect(existsSync(join(runDir, 'raw.json.tmp'))).toBe(true);
  }, 10000);

  it('REPLAY-5: raw.json has unknown schemaVersion — fails loudly', async () => {
    // Given: config, run directory with raw.json with schemaVersion 2
    const configPath = join(testRepoRoot, 'config.yaml');
    createTestConfig(configPath);

    const runId = '2026-04-17T09-02-14Z';
    const runDir = join(testRunsDir, runId);
    mkdirSync(runDir, { recursive: true });
    createTestRawJson(runDir, { schemaVersion: 2 });

    // When: run replay command
    const result = await runCli(['replay', runId, '--config', configPath]);

    // Then: exit 1
    expect(result.exitCode).toBe(1);

    // And: stdout contains error with schema version
    expect(result.stdout).toContain('replay: unsupported raw.json schemaVersion 2, expected 1');

    // And: no summary files are written
    expect(existsSync(join(runDir, 'summary.json'))).toBe(false);
    expect(existsSync(join(runDir, 'summary.md'))).toBe(false);
  }, 10000);

  it('REPLAY-6: raw.json is malformed JSON — fails loudly with file path', async () => {
    // Given: config, run directory with malformed raw.json
    const configPath = join(testRepoRoot, 'config.yaml');
    createTestConfig(configPath);

    const runId = '2026-04-17T09-02-14Z';
    const runDir = join(testRunsDir, runId);
    mkdirSync(runDir, { recursive: true });
    createTestRawJson(runDir, { malformed: true });

    // When: run replay command
    const result = await runCli(['replay', runId, '--config', configPath]);

    // Then: exit 1
    expect(result.exitCode).toBe(1);

    // And: stdout contains parse error with file path
    expect(result.stdout).toContain('replay: failed to parse');
    expect(result.stdout).toContain('raw.json');
    expect(result.stdout).toContain(runId);

    // And: no summary files are written
    expect(existsSync(join(runDir, 'summary.json'))).toBe(false);
    expect(existsSync(join(runDir, 'summary.md'))).toBe(false);
  }, 10000);

  it('REPLAY-7: summarizer returns error on replay — summary.error.json is written, existing summary.json is preserved', async () => {
    // Given: config, run directory with raw.json, existing summary.json and summary.md
    const configPath = join(testRepoRoot, 'config.yaml');
    createTestConfig(configPath);

    const runId = '2026-04-17T09-02-14Z';
    const runDir = join(testRunsDir, runId);
    mkdirSync(runDir, { recursive: true });
    createTestRawJson(runDir);
    createTestSummaryJson(runDir);
    createTestSummaryMd(runDir);
    createTestThemesStore();

    // Read existing summary.json content
    const existingSummaryJson = readFileSync(join(runDir, 'summary.json'), 'utf-8');
    const existingSummaryMd = readFileSync(join(runDir, 'summary.md'), 'utf-8');

    // When: run replay with invalid API key (will cause error)
    const result = await runCli(['replay', runId, '--config', configPath], {
      env: { ANTHROPIC_API_KEY: '' }, // Force no API key error
    });

    // Then: exit 1
    expect(result.exitCode).toBe(1);

    // And: stdout contains error message
    expect(result.stdout).toContain(`replayed ${runId}: summarizer failed:`);

    // And: summary.error.json is written
    expect(existsSync(join(runDir, 'summary.error.json'))).toBe(true);
    const errorJson = JSON.parse(readFileSync(join(runDir, 'summary.error.json'), 'utf-8'));
    expect(errorJson.schemaVersion).toBe(1);
    expect(errorJson.runId).toBe(runId);
    expect(errorJson.reason).toBeTruthy();

    // And: existing summary.json is NOT modified
    const currentSummaryJson = readFileSync(join(runDir, 'summary.json'), 'utf-8');
    expect(currentSummaryJson).toBe(existingSummaryJson);

    // And: existing summary.md is NOT modified
    const currentSummaryMd = readFileSync(join(runDir, 'summary.md'), 'utf-8');
    expect(currentSummaryMd).toBe(existingSummaryMd);
  }, 10000);

  it('REPLAY-8: --dry-run replay — no Claude call, no writes, post count reported', async () => {
    // Given: config, run directory with raw.json
    const configPath = join(testRepoRoot, 'config.yaml');
    createTestConfig(configPath);

    const runId = '2026-04-17T09-02-14Z';
    const runDir = join(testRunsDir, runId);
    mkdirSync(runDir, { recursive: true });
    createTestRawJson(runDir, { postCount: 84 });

    // When: run replay with --dry-run
    const result = await runCli(['replay', runId, '--dry-run', '--config', configPath]);

    // Then: exit 0
    expect(result.exitCode).toBe(0);

    // And: stdout contains dry-run message with post count
    expect(result.stdout).toContain(`dry-run: replay ${runId}`);
    expect(result.stdout).toContain('would re-summarize 84 posts');
    expect(result.stdout).toContain('writer skipped');

    // And: no summary files are written
    expect(existsSync(join(runDir, 'summary.json'))).toBe(false);
    expect(existsSync(join(runDir, 'summary.md'))).toBe(false);

    // And: no .tmp files are left behind
    expect(existsSync(join(runDir, 'summary.json.tmp'))).toBe(false);
    expect(existsSync(join(runDir, 'summary.md.tmp'))).toBe(false);
  }, 10000);

  it('REPLAY-9: replay with no run-id is rejected by dispatcher', async () => {
    // Given: config
    const configPath = join(testRepoRoot, 'config.yaml');
    createTestConfig(configPath);

    // When: run replay without run-id
    const result = await runCli(['replay', '--config', configPath]);

    // Then: exit 2 (usage error)
    expect(result.exitCode).toBe(2);

    // And: stderr contains usage error
    expect(result.stderr).toContain('replay requires a run-id');
    expect(result.stderr).toContain('pnpm replay <run-id>');
  }, 10000);

  it.skipIf(!hasApiKey)('REPLAY-10: rolling themes store is not appended on replay', async () => {
    // Given: config, run directory with raw.json, themes store with 3 runs
    const configPath = join(testRepoRoot, 'config.yaml');
    createTestConfig(configPath);

    const runId = '2026-04-12T09-02-14Z'; // One of the existing runs in themes store
    const runDir = join(testRunsDir, runId);
    mkdirSync(runDir, { recursive: true });
    createTestRawJson(runDir);
    createTestThemesStore({ runCount: 3 });

    // Read themes store before replay
    const themesStorePath = join(testStateDir, 'rolling-themes.json');
    const themesStoreBefore = JSON.parse(readFileSync(themesStorePath, 'utf-8'));
    const runCountBefore = themesStoreBefore.runs.length;

    // When: run replay command
    const result = await runCli(['replay', runId, '--config', configPath]);

    // Then: exit 0
    expect(result.exitCode).toBe(0);

    // And: themes store still has same number of entries
    const themesStoreAfter = JSON.parse(readFileSync(themesStorePath, 'utf-8'));
    expect(themesStoreAfter.runs.length).toBe(runCountBefore);

    // And: themes are the same (no duplication)
    expect(themesStoreAfter.runs).toEqual(themesStoreBefore.runs);
  }, 30000);

  it.skipIf(!hasApiKey)('REPLAY-11: config.output.dir override via --config', async () => {
    // Given: alt config with different output.dir
    const altConfigPath = join(testRepoRoot, 'alt-config.yaml');
    const altRunsDir = join(testTmpDir, 'alt-runs');
    const altStateDir = join(testTmpDir, 'alt-state');
    mkdirSync(altRunsDir, { recursive: true });
    mkdirSync(altStateDir, { recursive: true });

    createTestConfig(altConfigPath, {
      output: {
        dir: altRunsDir,
        state: altStateDir,
        format: 'markdown',
      },
    });

    const runId = '2026-04-17T09-02-14Z';
    const runDir = join(altRunsDir, runId);
    mkdirSync(runDir, { recursive: true });
    createTestRawJson(runDir);

    // Create themes store in alt location
    mkdirSync(altStateDir, { recursive: true });
    const themesStorePath = join(altStateDir, 'rolling-themes.json');
    writeFileSync(themesStorePath, JSON.stringify({ schemaVersion: 1, runs: [] }, null, 2), 'utf-8');

    // When: run replay with alt config
    const result = await runCli(['replay', runId, '--config', altConfigPath]);

    // Then: exit 0
    expect(result.exitCode).toBe(0);

    // And: summary files are written under alt-runs directory
    expect(existsSync(join(runDir, 'summary.json'))).toBe(true);
    expect(existsSync(join(runDir, 'summary.md'))).toBe(true);

    // And: default runs directory is NOT touched
    expect(existsSync(join(testRunsDir, runId))).toBe(false);
  }, 30000);

  it('REPLAY-12: run-id with leading path separator is rejected', async () => {
    // Given: config
    const configPath = join(testRepoRoot, 'config.yaml');
    createTestConfig(configPath);

    // When: run replay with path-like run-id
    const result1 = await runCli(['replay', './2026-04-17T09-02-14Z', '--config', configPath]);

    // Then: exit 1
    expect(result1.exitCode).toBe(1);

    // And: stdout contains error
    expect(result1.stdout).toContain('replay: run-id must be a directory name, not a path:');
    expect(result1.stdout).toContain('./2026-04-17T09-02-14Z');

    // When: run replay with absolute path
    const result2 = await runCli(['replay', '/abs/path', '--config', configPath]);

    // Then: exit 1
    expect(result2.exitCode).toBe(1);

    // And: stdout contains error
    expect(result2.stdout).toContain('replay: run-id must be a directory name, not a path:');
    expect(result2.stdout).toContain('/abs/path');
  }, 10000);
});
