import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

const rootDir = join(__dirname, '../..');

describe('Project Scaffold', () => {
  describe('UT-001: Package configuration', () => {
    it('should have package.json with correct engines', () => {
      const pkgPath = join(rootDir, 'package.json');
      expect(existsSync(pkgPath)).toBe(true);

      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      expect(pkg.engines.node).toMatch(/>=\s*20/);
      expect(pkg.engines.pnpm).toBeDefined();
    });

    it('should have verb-based scripts', () => {
      const pkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf-8'));

      // Required verb commands (post-Playwright retirement; login removed).
      expect(pkg.scripts.scroll).toBeDefined();
      expect(pkg.scripts.replay).toBeDefined();
      expect(pkg.scripts.dev).toBeDefined();
      expect(pkg.scripts.build).toBeDefined();
      expect(pkg.scripts.typecheck).toBeDefined();

      // Should not have noun-style scripts
      const scriptNames = Object.keys(pkg.scripts);
      expect(scriptNames).not.toContain('extraction-service');
      expect(scriptNames).not.toContain('summarizer-runner');
      // Retired verb commands
      expect(scriptNames).not.toContain('login');
      expect(scriptNames).not.toContain('chrome');
    });

    it('should have no hosted-product dependencies', () => {
      const pkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf-8'));
      const allDeps = {
        ...pkg.dependencies,
        ...pkg.devDependencies
      };

      // Explicitly forbidden dependencies
      const forbiddenDeps = [
        'auth0',
        '@auth0/auth0-react',
        'firebase',
        'supabase',
        'sentry',
        '@sentry/node',
        'amplitude',
        'mixpanel',
        'segment',
        'posthog',
        'datadog',
        'newrelic'
      ];

      forbiddenDeps.forEach(dep => {
        expect(allDeps[dep]).toBeUndefined();
      });
    });

    it('should have package name and version', () => {
      const pkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf-8'));
      expect(pkg.name).toBe('scrollproxy');
      expect(pkg.version).toBe('0.0.1');
    });
  });

  describe('UT-002: TypeScript configuration', () => {
    it('should have strict mode enabled', () => {
      const tsconfigPath = join(rootDir, 'tsconfig.json');
      expect(existsSync(tsconfigPath)).toBe(true);

      const tsconfig = JSON.parse(readFileSync(tsconfigPath, 'utf-8'));
      expect(tsconfig.compilerOptions.strict).toBe(true);
    });

    it('should have modern target and module resolution', () => {
      const tsconfig = JSON.parse(readFileSync(join(rootDir, 'tsconfig.json'), 'utf-8'));

      // Target should be at least ES2022
      expect(tsconfig.compilerOptions.target).toMatch(/ES202[2-9]|ESNext/i);

      // Module resolution should be NodeNext
      expect(tsconfig.compilerOptions.moduleResolution).toBe('NodeNext');
    });
  });

  describe('UT-003: Node version enforcement', () => {
    it('should have .nvmrc with Node 20+', () => {
      const nvmrcPath = join(rootDir, '.nvmrc');
      expect(existsSync(nvmrcPath)).toBe(true);

      const nodeVersion = readFileSync(nvmrcPath, 'utf-8').trim();
      expect(nodeVersion).toMatch(/^20\./);
    });
  });

  describe('UT-004: Directory structure', () => {
    it('should have src/index.ts', () => {
      const indexPath = join(rootDir, 'src/index.ts');
      expect(existsSync(indexPath)).toBe(true);
    });

    it('should have module directories', () => {
      // Post-Playwright retirement: src/scroller and src/extractor directories
      // are gone; src/sources, src/types, and src/lib are the new homes.
      const expectedDirs = [
        'src/cli',
        'src/sources',
        'src/types',
        'src/lib',
        'src/summarizer',
        'src/writer',
        'src/state',
        'src/config',
      ];

      expectedDirs.forEach(dir => {
        const dirPath = join(rootDir, dir);
        expect(existsSync(dirPath)).toBe(true);
      });
    });

    // .gitkeep assertion removed: the post-retirement directories all contain
    // real TS files, so no placeholder file is needed.
  });

  // UT-005 deleted in April 2026 when Playwright was retired: asserted the
  // Playwright-era "scrolling x.com for" / "no Chromium profile found" error
  // output. The x-api source has no Chrome profile concept. Regression coverage
  // for the post-retirement state lives in tests/expansion/retire-playwright.test.ts.

  describe('UT-006: Repository files', () => {
    it('should have README.md describing ScrollProxy', () => {
      const readmePath = join(rootDir, 'README.md');
      expect(existsSync(readmePath)).toBe(true);

      const readme = readFileSync(readmePath, 'utf-8');
      expect(readme).toContain('ScrollProxy');
      expect(readme).toContain('pnpm install');
      expect(readme).toContain('pnpm scroll');
    });

    it('should have .gitignore with Node.js exclusions', () => {
      const gitignorePath = join(rootDir, '.gitignore');
      expect(existsSync(gitignorePath)).toBe(true);

      const gitignore = readFileSync(gitignorePath, 'utf-8');
      expect(gitignore).toContain('node_modules');
      expect(gitignore).toContain('dist');
      expect(gitignore).toContain('.env');
      expect(gitignore).toContain('.env.local');
      expect(gitignore).toContain('runs/');
      expect(gitignore).toContain('state/');
      expect(gitignore).toContain('*.log');
    });

    it('should have LICENSE file unchanged', () => {
      const licensePath = join(rootDir, 'LICENSE');
      expect(existsSync(licensePath)).toBe(true);
    });
  });
});
