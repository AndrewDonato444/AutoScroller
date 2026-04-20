import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir, tmpdir } from 'os';
import { loadConfig } from '../../src/config/load.js';

let testTmpDir: string;
let testHomeDir: string;
let testRepoRoot: string;
let testConfigDir: string;

beforeEach(() => {
  // Create unique test directories for each test
  testTmpDir = join(tmpdir(), 'scrollproxy-test-' + Date.now());
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

describe('Config Loader', () => {
  describe('UT-CL-001: First run with no config writes a default and loads it', () => {
    it('should write default config to ~/scrollproxy/config.yaml when none exists', async () => {
      const defaultConfigPath = join(testConfigDir, 'config.yaml');

      // Ensure config doesn't exist
      expect(existsSync(defaultConfigPath)).toBe(false);

      const config = await loadConfig({ homeDir: testHomeDir, repoRoot: testRepoRoot });

      // Default config should now exist
      expect(existsSync(defaultConfigPath)).toBe(true);

      // Read the file to verify structure
      const configContent = readFileSync(defaultConfigPath, 'utf-8');
      expect(configContent).toContain('scroll:');
      expect(configContent).toContain('browser:');
      expect(configContent).toContain('interests:');
      expect(configContent).toContain('output:');
      expect(configContent).toContain('claude:');
    });

    it('should load default values matching the schema', async () => {
      const config = await loadConfig({ homeDir: testHomeDir, repoRoot: testRepoRoot });

      // Verify default values
      expect(config.scroll.minutes).toBe(10);
      expect(config.scroll.jitterMs).toEqual([400, 1400]);
      expect(config.scroll.longPauseEvery).toBe(25);
      expect(config.scroll.longPauseMs).toEqual([3000, 8000]);

      expect(config.browser.headless).toBe(false);
      expect(config.browser.viewport).toEqual({ width: 1280, height: 900 });

      expect(config.output.destinations).toEqual(['markdown']);

      expect(config.claude.model).toBe('claude-sonnet-4-6');
    });

    it('should print message about writing default config', async () => {
      const consoleSpy: string[] = [];
      const originalLog = console.log;
      console.log = (...args: any[]) => {
        consoleSpy.push(args.join(' '));
      };

      await loadConfig({ homeDir: testHomeDir, repoRoot: testRepoRoot });

      console.log = originalLog;

      const messages = consoleSpy.join('\n');
      expect(messages).toContain('wrote default config');
      expect(messages).toContain('scrollproxy/config.yaml');
      expect(messages).toContain('edit and re-run');
    });
  });

  describe('UT-CL-002: Explicit config path wins over defaults', () => {
    it('should load from explicit path when provided', async () => {
      const explicitPath = join(testTmpDir, 'my-config.yaml');
      const repoPath = join(testRepoRoot, 'config.yaml');

      // Create config at explicit path with custom value
      writeFileSync(explicitPath, `
scroll:
  minutes: 15
browser:
  userDataDir: ~/custom/chrome
  headless: false
  viewport:
    width: 1280
    height: 900
interests: []
output:
  dir: ~/custom/runs
  state: ~/custom/state
  format: markdown
claude:
  model: claude-sonnet-4-6
`);

      // Create different config in repo root
      writeFileSync(repoPath, `
scroll:
  minutes: 20
browser:
  userDataDir: ~/repo/chrome
  headless: false
  viewport:
    width: 1280
    height: 900
interests: []
output:
  dir: ~/repo/runs
  state: ~/repo/state
  format: markdown
claude:
  model: claude-sonnet-4-6
`);

      const config = await loadConfig({
        path: explicitPath,
        homeDir: testHomeDir,
        repoRoot: testRepoRoot
      });

      expect(config.scroll.minutes).toBe(15);
      expect(config.output.dir).toContain('custom/runs');
    });
  });

  describe('UT-CL-003: Repo-root config overrides home-dir config', () => {
    it('should prefer repo-root config over home-dir config', async () => {
      const repoPath = join(testRepoRoot, 'config.yaml');
      const homePath = join(testConfigDir, 'config.yaml');

      // Create config in repo root
      writeFileSync(repoPath, `
scroll:
  minutes: 5
browser:
  userDataDir: ~/repo/chrome
  headless: false
  viewport:
    width: 1280
    height: 900
interests: []
output:
  dir: ~/repo/runs
  state: ~/repo/state
  format: markdown
claude:
  model: claude-sonnet-4-6
`);

      // Create different config in home dir
      writeFileSync(homePath, `
scroll:
  minutes: 10
browser:
  userDataDir: ~/home/chrome
  headless: false
  viewport:
    width: 1280
    height: 900
interests: []
output:
  dir: ~/home/runs
  state: ~/home/state
  format: markdown
claude:
  model: claude-sonnet-4-6
`);

      const config = await loadConfig({ homeDir: testHomeDir, repoRoot: testRepoRoot });

      expect(config.scroll.minutes).toBe(5);
    });
  });

  describe('UT-CL-004: Invalid YAML fails fast with the file path', () => {
    it('should exit with error when YAML is malformed', async () => {
      const configPath = join(testRepoRoot, 'config.yaml');

      // Write malformed YAML
      writeFileSync(configPath, `
scroll:
  minutes: 10
  jitterMs: [400, 1400
  # Missing closing bracket
`);

      await expect(
        loadConfig({ homeDir: testHomeDir, repoRoot: testRepoRoot })
      ).rejects.toThrow();
    });
  });

  describe('UT-CL-005: Zod schema violation fails fast with the field name', () => {
    it('should fail when field has wrong type', async () => {
      const configPath = join(testRepoRoot, 'config.yaml');

      writeFileSync(configPath, `
scroll:
  minutes: "ten"
browser:
  userDataDir: ~/chrome
  headless: false
  viewport:
    width: 1280
    height: 900
interests: []
output:
  dir: ~/runs
  state: ~/state
  format: markdown
claude:
  model: claude-sonnet-4-6
`);

      await expect(
        loadConfig({ homeDir: testHomeDir, repoRoot: testRepoRoot })
      ).rejects.toThrow(/scroll\.minutes/);
    });
  });

  describe('UT-CL-006: Unknown fields are rejected (strict mode)', () => {
    it('should reject config with unknown top-level field', async () => {
      const configPath = join(testRepoRoot, 'config.yaml');

      writeFileSync(configPath, `
scroll:
  minutes: 10
browser:
  userDataDir: ~/chrome
  headless: false
  viewport:
    width: 1280
    height: 900
interests: []
output:
  dir: ~/runs
  state: ~/state
  format: markdown
claude:
  model: claude-sonnet-4-6
analytics:
  enabled: true
`);

      await expect(
        loadConfig({ homeDir: testHomeDir, repoRoot: testRepoRoot })
      ).rejects.toThrow(/analytics/);
    });
  });

  describe('UT-CL-007: Defaults fill in for omitted optional fields', () => {
    it('should populate defaults for omitted fields', async () => {
      const configPath = join(testRepoRoot, 'config.yaml');

      // Minimal config — scroll/browser/extractor sections omitted entirely
      // (they're optional post-Playwright retirement, April 2026). What remains
      // is the forward-clean shape: output + claude + interests + x.
      writeFileSync(configPath, `
interests: []
output:
  dir: ~/runs
  state: ~/state
  format: markdown
claude:
  model: claude-sonnet-4-6
x:
  baseUrl: https://api.x.com/2
  lists: []
`);

      const config = await loadConfig({ homeDir: testHomeDir, repoRoot: testRepoRoot });

      // output defaults fill in
      expect(config.output.destinations).toEqual(['markdown']);
      // x.bookmarks gets its default
      expect(config.x?.bookmarks.enabled).toBe(false);
      expect(config.x?.bookmarks.postsPerRun).toBe(25);
      // vestigial sections are undefined when omitted
      expect(config.scroll).toBeUndefined();
      expect(config.browser).toBeUndefined();
    });
  });

  describe('UT-CL-008: Required secrets are surfaced clearly when missing', () => {
    it('should allow missing claude.apiKey (optional at load time)', async () => {
      const configPath = join(testRepoRoot, 'config.yaml');

      writeFileSync(configPath, `
scroll:
  minutes: 10
browser:
  userDataDir: ~/chrome
  headless: false
  viewport:
    width: 1280
    height: 900
interests: []
output:
  dir: ~/runs
  state: ~/state
  format: markdown
claude:
  model: claude-sonnet-4-6
`);

      const config = await loadConfig({ homeDir: testHomeDir, repoRoot: testRepoRoot });

      // apiKey should be undefined or null (optional)
      expect(config.claude.apiKey).toBeUndefined();
    });
  });

  // UT-CL-009 deleted in April 2026 when Playwright was retired: scroll.minutes
  // is no longer a validated field (the x-api source has no time budget). The
  // schema treats scroll/browser/extractor as vestigial optional blocks for
  // backward compat. See tests/expansion/retire-playwright.test.ts RP-06/RP-07.

  describe('UT-CL-010: Output directory is tilde-expanded', () => {
    it('should expand tilde in output.dir to absolute path', async () => {
      const configPath = join(testRepoRoot, 'config.yaml');

      writeFileSync(configPath, `
scroll:
  minutes: 10
browser:
  userDataDir: ~/chrome
  headless: false
  viewport:
    width: 1280
    height: 900
interests: []
output:
  dir: ~/scrollproxy/runs
  state: ~/scrollproxy/state
  format: markdown
claude:
  model: claude-sonnet-4-6
`);

      const config = await loadConfig({ homeDir: testHomeDir, repoRoot: testRepoRoot });

      // Path should be absolute, not starting with ~
      expect(config.output.dir).not.toContain('~');
      expect(config.output.dir).toContain('scrollproxy/runs');
      expect(config.output.state).not.toContain('~');
    });

    it('should NOT create the directory at load time', async () => {
      const configPath = join(testRepoRoot, 'config.yaml');

      writeFileSync(configPath, `
scroll:
  minutes: 10
browser:
  userDataDir: ~/chrome
  headless: false
  viewport:
    width: 1280
    height: 900
interests: []
output:
  dir: ~/scrollproxy/runs
  state: ~/scrollproxy/state
  format: markdown
claude:
  model: claude-sonnet-4-6
`);

      const config = await loadConfig({ homeDir: testHomeDir, repoRoot: testRepoRoot });

      // Directory should not be created
      expect(existsSync(config.output.dir)).toBe(false);
    });
  });

  describe('UT-CL-011: Interests list is trimmed and deduplicated', () => {
    it('should trim whitespace and deduplicate (case-insensitive)', async () => {
      const configPath = join(testRepoRoot, 'config.yaml');

      writeFileSync(configPath, `
scroll:
  minutes: 10
browser:
  userDataDir: ~/chrome
  headless: false
  viewport:
    width: 1280
    height: 900
interests:
  - " AI product strategy "
  - "ai product strategy"
  - "sales enablement"
output:
  dir: ~/runs
  state: ~/state
  format: markdown
claude:
  model: claude-sonnet-4-6
`);

      const config = await loadConfig({ homeDir: testHomeDir, repoRoot: testRepoRoot });

      expect(config.interests).toEqual([
        'AI product strategy',
        'sales enablement'
      ]);
    });

    it('should preserve order from first occurrence', async () => {
      const configPath = join(testRepoRoot, 'config.yaml');

      writeFileSync(configPath, `
scroll:
  minutes: 10
browser:
  userDataDir: ~/chrome
  headless: false
  viewport:
    width: 1280
    height: 900
interests:
  - "sales enablement"
  - "AI product strategy"
  - "Sales Enablement"
output:
  dir: ~/runs
  state: ~/state
  format: markdown
claude:
  model: claude-sonnet-4-6
`);

      const config = await loadConfig({ homeDir: testHomeDir, repoRoot: testRepoRoot });

      // First occurrence order should be preserved
      expect(config.interests).toEqual([
        'sales enablement',
        'AI product strategy'
      ]);
    });
  });
});
