import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '../..');

// Exit codes (matching src/cli/index.ts)
const EXIT_SUCCESS = 0;
const EXIT_ERROR = 1;
const EXIT_USAGE_ERROR = 2;

let testTmpDir: string;
let testHomeDir: string;
let testRepoRoot: string;
let testConfigDir: string;

/**
 * Helper to run CLI and capture output/exit code
 */
function runCli(args: string[], options: { configPath?: string } = {}): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number | null;
}> {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      HOME: testHomeDir,
      PWD: testRepoRoot,
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
 * Helper to create a minimal valid raw.json payload
 */
function createMinimalRawJson(runId: string) {
  return {
    schemaVersion: 1,
    runId,
    posts: [
      {
        id: 'post-1',
        url: 'https://x.com/test/status/1',
        author: {
          handle: '@testuser',
          displayName: 'Test User',
          verified: false,
        },
        text: 'Test post 1',
        postedAt: '2026-04-16T08:30:00.000Z',
        tickIndex: 0,
        metrics: { replies: 0, reposts: 0, likes: 0, views: null },
        media: [],
        isRepost: false,
        repostedBy: null,
        quoted: null,
      },
    ],
  };
}

/**
 * Helper to set up a test run directory with raw.json
 */
function setupTestRunDirectory(runId: string, runsDir?: string): string {
  const actualRunsDir = runsDir ?? join(testHomeDir, 'scrollproxy', 'runs');
  const runDir = join(actualRunsDir, runId);
  mkdirSync(runDir, { recursive: true });

  // Create state directory for themes store
  const stateDir = join(testHomeDir, 'scrollproxy', 'state');
  mkdirSync(stateDir, { recursive: true });

  // Create raw.json
  const rawJson = createMinimalRawJson(runId);
  writeFileSync(join(runDir, 'raw.json'), JSON.stringify(rawJson, null, 2), 'utf-8');

  return runDir;
}

beforeEach(() => {
  // Create unique test directories for each test
  testTmpDir = join(tmpdir(), 'scrollproxy-cli-test-' + Date.now());
  testHomeDir = join(testTmpDir, 'home');
  testRepoRoot = join(testTmpDir, 'repo');
  testConfigDir = join(testHomeDir, 'scrollproxy');

  // Create test directories
  mkdirSync(testHomeDir, { recursive: true });
  mkdirSync(testRepoRoot, { recursive: true });
  mkdirSync(testConfigDir, { recursive: true });
});

afterEach(() => {
  // Clean up test directories
  if (existsSync(testTmpDir)) {
    rmSync(testTmpDir, { recursive: true, force: true });
  }
});

describe('CLI Entry + Arg Parsing', () => {
  const validConfigYaml = `interests:
  - TypeScript
  - Rust

output:
  dir: ~/scrollproxy/runs
  state: ~/scrollproxy/state.json
  format: markdown

claude:
  model: claude-opus-4

x:
  baseUrl: https://api.x.com/2
  lists:
    - id: "1234567890"
      name: "Test List"
      tag: "test"
      postsPerRun: 10
  bookmarks:
    enabled: false
    postsPerRun: 25
`;

  // UT-CLI-001, UT-CLI-002, UT-CLI-003 deleted in April 2026 when Playwright
  // was retired: those cases asserted the old Playwright startup line
  // ("persistent context:", "no Chromium profile found") and --minutes flag
  // handling. The x-api path has neither concept. Regression coverage for the
  // new world lives in tests/expansion/retire-playwright.test.ts.

  describe('UT-CLI-004: --dry-run is parsed as a boolean and reaches handler', () => {
    it('should pass dryRun=true to handler (startup line includes the marker)', async () => {
      const configPath = join(testConfigDir, 'config.yaml');
      writeFileSync(configPath, validConfigYaml, 'utf-8');

      const result = await runCli(['scroll', '--dry-run']);

      // "(dry-run)" appears on the startup line iff isDryRun === true, which
      // only happens if --dry-run was parsed AND handleScroll took the correct
      // branch. "x-api pull:" alone would fire regardless of the flag value.
      expect(result.stdout).toContain('(dry-run)');
    });

    it('should not print the dry-run marker when --dry-run is absent', async () => {
      const configPath = join(testConfigDir, 'config.yaml');
      writeFileSync(configPath, validConfigYaml, 'utf-8');

      const result = await runCli(['scroll']);

      expect(result.stdout).toContain('x-api pull:');
      expect(result.stdout).not.toContain('(dry-run)');
    });
  });

  describe('UT-CLI-005: --config <path> overrides config search order', () => {
    it('should load config from the explicit path, not the default', async () => {
      // Write config to a custom location with a distinguishing list tag.
      const customConfigPath = join(testTmpDir, 'my-config.yaml');
      const customConfig = validConfigYaml.replace('tag: "test"', 'tag: "custom-tag-marker"');
      writeFileSync(customConfigPath, customConfig, 'utf-8');

      // Write a DIFFERENT default config at the home-dir search location.
      const defaultConfigPath = join(testConfigDir, 'config.yaml');
      writeFileSync(defaultConfigPath, validConfigYaml, 'utf-8');

      const result = await runCli(['scroll', '--config', customConfigPath, '--dry-run']);

      // The per-list breakdown in the "x-api complete:" line echoes each list's
      // tag. If the custom config was loaded, "custom-tag-marker" appears; if
      // --config was ignored and the default was loaded instead, only "test"
      // (the default tag) would appear.
      expect(result.stdout).toContain('custom-tag-marker');
      expect(result.stdout).not.toContain('tag=test ');
    });
  });

  describe('UT-CLI-006: Unknown flag fails fast with flag name', () => {
    it('should reject unknown flags', async () => {
      const configPath = join(testConfigDir, 'config.yaml');
      writeFileSync(configPath, validConfigYaml, 'utf-8');

      const result = await runCli(['scroll', '--telemetry']);

      expect(result.exitCode).toBe(EXIT_USAGE_ERROR);
      expect(result.stderr).toContain('--telemetry');
      expect(result.stderr).toMatch(/unknown flag/i);
      expect(result.stderr).toMatch(/--help/);
    });
  });

  describe('UT-CLI-007: Unknown verb fails fast', () => {
    it('should reject unknown commands', async () => {
      const configPath = join(testConfigDir, 'config.yaml');
      writeFileSync(configPath, validConfigYaml, 'utf-8');

      const result = await runCli(['foo']);

      expect(result.exitCode).toBe(EXIT_USAGE_ERROR);
      expect(result.stderr).toContain('foo');
      expect(result.stderr).toMatch(/unknown command/i);
      expect(result.stderr).toMatch(/scroll.*replay/i);
    });
  });

  describe('UT-CLI-008: --help prints usage summary and exits 0', () => {
    it('should print usage when --help flag is provided', async () => {
      const result = await runCli(['scroll', '--help']);

      expect(result.exitCode).toBe(EXIT_SUCCESS);
      expect(result.stdout).toContain('usage');
      expect(result.stdout).toContain('scroll');
      expect(result.stdout).toContain('replay');
      expect(result.stdout).toContain('--dry-run');
      expect(result.stdout).toContain('--config');
      expect(result.stdout).toContain('ANTHROPIC_API_KEY');
    });

    it('should accept -h as shorthand', async () => {
      const result = await runCli(['scroll', '-h']);

      expect(result.exitCode).toBe(EXIT_SUCCESS);
      expect(result.stdout).toContain('usage');
    });
  });

  describe('UT-CLI-009: --version prints package version and exits 0', () => {
    it('should print version when --version flag is provided', async () => {
      const result = await runCli(['scroll', '--version']);

      expect(result.exitCode).toBe(EXIT_SUCCESS);
      expect(result.stdout).toMatch(/scrollproxy v\d+\.\d+\.\d+/);
    });

    it('should accept -v as shorthand', async () => {
      const result = await runCli(['scroll', '-v']);

      expect(result.exitCode).toBe(EXIT_SUCCESS);
      expect(result.stdout).toMatch(/scrollproxy v\d+\.\d+\.\d+/);
    });
  });

  // UT-CLI-010 deleted in April 2026 when Playwright was retired. `pnpm login`
  // used to launch a headful browser for the operator to log into X; the x-api
  // source uses OAuth 2.0 tokens (see `pnpm x:auth`). The CLI has no login verb.

  describe('UT-CLI-011: pnpm replay <run-id> routes to replay handler', () => {
    it('should invoke replay handler with run-id', async () => {
      // Write valid config
      const configPath = join(testConfigDir, 'config.yaml');
      writeFileSync(configPath, validConfigYaml, 'utf-8');

      // Create run directory with raw.json
      setupTestRunDirectory('2026-04-16-0830');

      // Since replay calls the real summarizer, we need to run in dry-run mode
      // to avoid making actual API calls in this routing test
      const result = await runCli(['replay', '2026-04-16-0830', '--dry-run']);

      expect(result.exitCode).toBe(EXIT_SUCCESS);
      expect(result.stdout).toContain('replay');
      expect(result.stdout).toContain('2026-04-16-0830');
      expect(result.stdout).toContain('dry-run');
    });
  });

  describe('UT-CLI-012: pnpm replay with no run-id fails with usage hint', () => {
    it('should reject replay command without run-id', async () => {
      const result = await runCli(['replay']);

      expect(result.exitCode).toBe(EXIT_USAGE_ERROR);
      expect(result.stderr).toMatch(/replay requires.*run-id/i);
      expect(result.stderr).toContain('pnpm replay <run-id>');
    });
  });

  describe('UT-CLI-013: Config-loader errors surface through CLI unchanged', () => {
    it('should propagate config loader errors', async () => {
      // Write config with unknown field
      const badConfig = validConfigYaml + '\nanalytics:\n  enabled: true\n';
      const configPath = join(testConfigDir, 'config.yaml');
      writeFileSync(configPath, badConfig, 'utf-8');

      const result = await runCli(['scroll']);

      // Should fail with non-zero exit code
      expect(result.exitCode).not.toBe(0);
      // Should contain config error message
      expect(result.stderr).toMatch(/config error|unknown field/i);
      expect(result.stderr).toContain('analytics');
    });
  });

  describe('UT-CLI-014: Flags come after verb; positionals preserved', () => {
    it('should parse flags relative to verb and preserve positionals', async () => {
      // Create custom config with different output dir
      const altRunsDir = join(testTmpDir, 'alt-runs');
      const altStateDir = join(testTmpDir, 'alt-state');
      mkdirSync(altRunsDir, { recursive: true });
      mkdirSync(altStateDir, { recursive: true });

      const customConfig = validConfigYaml
        .replace('dir: ~/scrollproxy/runs', `dir: ${altRunsDir}`)
        .replace('state: ~/scrollproxy/state.json', `state: ${altStateDir}`);
      const customConfigPath = join(testTmpDir, 'alt.yaml');
      writeFileSync(customConfigPath, customConfig, 'utf-8');

      // Create run directory with raw.json in the alt-runs location
      setupTestRunDirectory('2026-04-16-0830', altRunsDir);

      // Test with dry-run to avoid API calls
      const result = await runCli(['replay', '2026-04-16-0830', '--config', customConfigPath, '--dry-run']);

      expect(result.exitCode).toBe(EXIT_SUCCESS);
      expect(result.stdout).toContain('2026-04-16-0830');
      // Should use the custom config (dry-run confirms it loaded the config successfully)
      expect(result.stdout).toContain('dry-run');
    });
  });

  describe('UT-CLI-015: No hosted-product CLI dependencies', () => {
    it('should not use heavy CLI frameworks in package.json', () => {
      const packageJsonPath = join(projectRoot, 'package.json');
      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
      const deps = {
        ...packageJson.dependencies,
        ...packageJson.devDependencies,
      };

      // Should not have heavy CLI frameworks
      expect(deps).not.toHaveProperty('commander');
      expect(deps).not.toHaveProperty('yargs');
      expect(deps).not.toHaveProperty('oclif');
    });

    it('should have hand-rolled parser under 150 lines', () => {
      const argsPath = join(projectRoot, 'src/cli/args.ts');
      if (existsSync(argsPath)) {
        const content = readFileSync(argsPath, 'utf-8');
        const lines = content.split('\n').filter(line => {
          const trimmed = line.trim();
          // Don't count blank lines or comment-only lines
          return trimmed !== '' && !trimmed.startsWith('//') && !trimmed.startsWith('*');
        });
        expect(lines.length).toBeLessThanOrEqual(150);
      }
    });
  });
});
