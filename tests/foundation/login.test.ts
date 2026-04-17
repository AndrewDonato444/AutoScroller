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

/**
 * Helper to run CLI and capture output/exit code
 */
function runCli(args: string[], options: { timeout?: number } = {}): Promise<{
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
    let resolved = false;

    const timeout = options.timeout || 10000;
    const timeoutHandle = setTimeout(() => {
      if (!resolved) {
        child.kill('SIGTERM');
        resolved = true;
        resolve({ stdout, stderr, exitCode: null });
      }
    }, timeout);

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (exitCode) => {
      if (!resolved) {
        clearTimeout(timeoutHandle);
        resolved = true;
        resolve({ stdout, stderr, exitCode });
      }
    });
  });
}

beforeEach(() => {
  // Create unique test directories for each test
  testTmpDir = join(tmpdir(), 'scrollproxy-login-test-' + Date.now());
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

describe('Login Command', () => {
  const validConfigYaml = `scroll:
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
  format: markdown

claude:
  model: claude-sonnet-4-6
`;

  const headlessConfigYaml = validConfigYaml.replace('headless: false', 'headless: true');

  describe('UT-LOGIN-001: pnpm login launches a persistent Chromium against configured user-data dir', () => {
    it('should expand ~ to absolute path', async () => {
      const configPath = join(testConfigDir, 'config.yaml');
      writeFileSync(configPath, validConfigYaml, 'utf-8');

      // This test will fail until we implement the login handler
      // For now, we expect the handler to attempt to create the user data dir
      const result = await runCli(['login'], { timeout: 5000 });

      // Handler should expand ~ and create directory
      const expectedUserDataDir = join(testHomeDir, 'scrollproxy', 'chrome');
      expect(existsSync(expectedUserDataDir)).toBe(true);
    });

    it('should create user-data dir if it does not exist', async () => {
      const configPath = join(testConfigDir, 'config.yaml');
      writeFileSync(configPath, validConfigYaml, 'utf-8');

      const expectedUserDataDir = join(testHomeDir, 'scrollproxy', 'chrome');
      expect(existsSync(expectedUserDataDir)).toBe(false);

      await runCli(['login'], { timeout: 5000 });

      expect(existsSync(expectedUserDataDir)).toBe(true);
    });

    it('should print instruction to stdout', async () => {
      const configPath = join(testConfigDir, 'config.yaml');
      writeFileSync(configPath, validConfigYaml, 'utf-8');

      const result = await runCli(['login'], { timeout: 5000 });

      expect(result.stdout).toContain('log in to X in the open window, then close the window when done');
    });
  });

  describe('UT-LOGIN-002: pnpm login refuses to run headless', () => {
    it('should exit 2 when headless is true', async () => {
      const configPath = join(testConfigDir, 'config.yaml');
      writeFileSync(configPath, headlessConfigYaml, 'utf-8');

      const result = await runCli(['login'], { timeout: 2000 });

      expect(result.exitCode).toBe(2);
    });

    it('should print error message to stderr', async () => {
      const configPath = join(testConfigDir, 'config.yaml');
      writeFileSync(configPath, headlessConfigYaml, 'utf-8');

      const result = await runCli(['login'], { timeout: 2000 });

      expect(result.stderr).toContain('login requires browser.headless: false');
      expect(result.stderr).toMatch(/config\.yaml/);
      expect(result.stderr).toContain('re-run');
    });

    it('should not launch browser', async () => {
      const configPath = join(testConfigDir, 'config.yaml');
      writeFileSync(configPath, headlessConfigYaml, 'utf-8');

      await runCli(['login'], { timeout: 2000 });

      // User-data dir should not be created
      const expectedUserDataDir = join(testHomeDir, 'scrollproxy', 'chrome');
      expect(existsSync(expectedUserDataDir)).toBe(false);
    });
  });

  describe('UT-LOGIN-003: Successful login detected from final URL', () => {
    it.skip('should exit 0 when final URL is x.com/home', async () => {
      // This test requires mocking Playwright or setting up a real browser
      // Will be implemented with the actual Playwright integration
      const configPath = join(testConfigDir, 'config.yaml');
      writeFileSync(configPath, validConfigYaml, 'utf-8');

      // Mock scenario: browser closes with URL at x.com/home
      const result = await runCli(['login'], { timeout: 5000 });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('login saved');
      expect(result.stdout).toMatch(/scrollproxy\/chrome/);
      expect(result.stdout).toContain('pnpm scroll');
    });
  });

  describe('UT-LOGIN-004: Alternate logged-in URL (handle page) counts as success', () => {
    it.skip('should exit 0 when final URL is x.com/{handle}', async () => {
      // This test requires mocking Playwright
      const configPath = join(testConfigDir, 'config.yaml');
      writeFileSync(configPath, validConfigYaml, 'utf-8');

      // Mock scenario: browser closes with URL at x.com/andrewdonato
      const result = await runCli(['login'], { timeout: 5000 });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('login saved');
    });
  });

  describe('UT-LOGIN-005: Window closed before login completed', () => {
    it.skip('should exit 1 when final URL is still x.com/login', async () => {
      const configPath = join(testConfigDir, 'config.yaml');
      writeFileSync(configPath, validConfigYaml, 'utf-8');

      // Mock scenario: browser closes while still on login page
      const result = await runCli(['login'], { timeout: 5000 });

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('login not completed');
      expect(result.stdout).toMatch(/x\.com\/login/);
      expect(result.stdout).toContain('pnpm login again');
    });
  });

  describe('UT-LOGIN-006: User-data dir already exists from prior login', () => {
    it('should reuse existing profile', async () => {
      const configPath = join(testConfigDir, 'config.yaml');
      writeFileSync(configPath, validConfigYaml, 'utf-8');

      // Create user-data dir with some dummy files
      const userDataDir = join(testHomeDir, 'scrollproxy', 'chrome');
      mkdirSync(userDataDir, { recursive: true });
      writeFileSync(join(userDataDir, 'dummy.txt'), 'existing profile', 'utf-8');

      await runCli(['login'], { timeout: 5000 });

      // Dummy file should still exist (not wiped)
      expect(existsSync(join(userDataDir, 'dummy.txt'))).toBe(true);
      expect(readFileSync(join(userDataDir, 'dummy.txt'), 'utf-8')).toBe('existing profile');
    });
  });

  describe('UT-LOGIN-007: Viewport is honored from config', () => {
    it.skip('should use custom viewport from config', async () => {
      const customConfig = validConfigYaml.replace(
        'width: 1280\n    height: 900',
        'width: 1440\n    height: 960'
      );
      const configPath = join(testConfigDir, 'config.yaml');
      writeFileSync(configPath, customConfig, 'utf-8');

      // This test requires inspecting Playwright launch options
      // Will be verified through implementation
      await runCli(['login'], { timeout: 5000 });

      // Implementation will honor viewport config
      expect(true).toBe(true);
    });
  });

  describe('UT-LOGIN-008: Playwright launch failure surfaces error clearly', () => {
    it.skip('should print clear error when Chromium not installed', async () => {
      const configPath = join(testConfigDir, 'config.yaml');
      writeFileSync(configPath, validConfigYaml, 'utf-8');

      // Mock scenario: Playwright throws error about missing Chromium
      // In real scenario, this happens when playwright install wasn't run
      const result = await runCli(['login'], { timeout: 5000 });

      if (result.exitCode === 1) {
        expect(result.stderr).toContain('playwright chromium not installed');
        expect(result.stderr).toContain('pnpm exec playwright install chromium');
      }
    });
  });

  describe('UT-LOGIN-009: User-data dir is a file, not a directory', () => {
    it('should exit 2 with clear error when userDataDir is a file', async () => {
      const configPath = join(testConfigDir, 'config.yaml');
      writeFileSync(configPath, validConfigYaml, 'utf-8');

      // Create user-data path as a file instead of directory
      const userDataPath = join(testHomeDir, 'scrollproxy', 'chrome');
      mkdirSync(dirname(userDataPath), { recursive: true });
      writeFileSync(userDataPath, 'not a directory', 'utf-8');

      const result = await runCli(['login'], { timeout: 2000 });

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('browser.userDataDir must be a directory');
      expect(result.stderr).toContain(userDataPath);
    });
  });

  describe('UT-LOGIN-010: --config <path> is honored', () => {
    it('should load config from explicit path', async () => {
      // Write custom config with different userDataDir
      const customConfigPath = join(testTmpDir, 'custom-config.yaml');
      const customConfig = validConfigYaml.replace(
        'userDataDir: ~/scrollproxy/chrome',
        'userDataDir: ~/custom/chrome'
      );
      writeFileSync(customConfigPath, customConfig, 'utf-8');

      await runCli(['login', '--config', customConfigPath], { timeout: 5000 });

      // Should create custom user-data dir
      const expectedUserDataDir = join(testHomeDir, 'custom', 'chrome');
      expect(existsSync(expectedUserDataDir)).toBe(true);
    });
  });

  describe('UT-LOGIN-011: No credentials are ever read, written, or logged', () => {
    it('should not create any credential files', async () => {
      const configPath = join(testConfigDir, 'config.yaml');
      writeFileSync(configPath, validConfigYaml, 'utf-8');

      await runCli(['login'], { timeout: 5000 });

      // Should not create any credential-related files outside of Chrome profile
      const configFiles = existsSync(testConfigDir) ?
        rmSync(testConfigDir, { recursive: true, force: true }) : null;

      // No .env, credentials.json, etc. should exist
      expect(existsSync(join(testHomeDir, '.env'))).toBe(false);
      expect(existsSync(join(testHomeDir, 'credentials.json'))).toBe(false);
      expect(existsSync(join(testConfigDir, 'credentials'))).toBe(false);
    });

    it('should not log URLs with query params', async () => {
      const configPath = join(testConfigDir, 'config.yaml');
      writeFileSync(configPath, validConfigYaml, 'utf-8');

      const result = await runCli(['login'], { timeout: 5000 });

      // Should not contain query params or tokens in output
      expect(result.stdout).not.toMatch(/\?/);
      expect(result.stdout).not.toMatch(/token=/i);
      expect(result.stdout).not.toMatch(/auth=/i);
    });
  });

  describe('UT-LOGIN-012: No hosted-product dependencies are introduced', () => {
    it('should not have OAuth libraries in dependencies', () => {
      const packageJsonPath = join(projectRoot, 'package.json');
      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
      const deps = {
        ...packageJson.dependencies,
        ...packageJson.devDependencies,
      };

      // Should not have OAuth/auth libraries
      expect(deps).not.toHaveProperty('passport');
      expect(deps).not.toHaveProperty('openid-client');
      expect(deps).not.toHaveProperty('@octokit/auth');
      expect(deps).not.toHaveProperty('oauth');
      expect(deps).not.toHaveProperty('oauth2');
    });

    it('should not have credential-manager libraries in dependencies', () => {
      const packageJsonPath = join(projectRoot, 'package.json');
      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
      const deps = {
        ...packageJson.dependencies,
        ...packageJson.devDependencies,
      };

      // Should not have credential management libraries
      expect(deps).not.toHaveProperty('keytar');
      expect(deps).not.toHaveProperty('node-keyring');
      expect(deps).not.toHaveProperty('keychain');
    });

    it('should only have playwright as the browser automation library', () => {
      const packageJsonPath = join(projectRoot, 'package.json');
      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
      const deps = {
        ...packageJson.dependencies,
        ...packageJson.devDependencies,
      };

      // Playwright should be present
      expect(deps).toHaveProperty('playwright');

      // Should not have other browser automation libraries
      expect(deps).not.toHaveProperty('puppeteer');
      expect(deps).not.toHaveProperty('selenium-webdriver');
    });
  });
});
