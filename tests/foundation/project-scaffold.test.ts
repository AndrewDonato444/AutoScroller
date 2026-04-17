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

      // Required verb commands
      expect(pkg.scripts.scroll).toBeDefined();
      expect(pkg.scripts.login).toBeDefined();
      expect(pkg.scripts.replay).toBeDefined();
      expect(pkg.scripts.dev).toBeDefined();
      expect(pkg.scripts.build).toBeDefined();
      expect(pkg.scripts.typecheck).toBeDefined();

      // Should not have noun-style scripts
      const scriptNames = Object.keys(pkg.scripts);
      expect(scriptNames).not.toContain('extraction-service');
      expect(scriptNames).not.toContain('summarizer-runner');
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

    it('should have module placeholder directories', () => {
      const expectedDirs = [
        'src/cli',
        'src/scroller',
        'src/extractor',
        'src/summarizer',
        'src/writer',
        'src/state',
        'src/config'
      ];

      expectedDirs.forEach(dir => {
        const dirPath = join(rootDir, dir);
        expect(existsSync(dirPath)).toBe(true);
      });
    });

    it('should have .gitkeep in placeholder directories', () => {
      const placeholderDirs = [
        'src/scroller',
        'src/extractor',
        'src/summarizer',
        'src/writer',
        'src/state',
        'src/config'
      ];

      placeholderDirs.forEach(dir => {
        const gitkeepPath = join(rootDir, dir, '.gitkeep');
        expect(existsSync(gitkeepPath)).toBe(true);
      });
    });
  });

  describe('UT-005: CLI execution', () => {
    it('should run pnpm scroll and detect missing profile', () => {
      try {
        execSync('pnpm scroll', {
          cwd: rootDir,
          encoding: 'utf-8',
          stdio: 'pipe'
        });
        // If we get here, that's unexpected
        throw new Error('Expected pnpm scroll to exit with error when profile missing');
      } catch (error: any) {
        // Should exit with code 1 and print error about missing profile
        expect(error.status).toBe(1);
        const output = error.stdout + error.stderr;
        expect(output).toContain('scrolling x.com for');
        expect(output).toContain('no Chromium profile found');
      }
    });

    it('should exit with status code 1 when profile missing', () => {
      let exitCode = -1;

      try {
        execSync('pnpm scroll', {
          cwd: rootDir,
          encoding: 'utf-8',
          stdio: 'pipe'
        });
        exitCode = 0;
      } catch (error: any) {
        exitCode = error.status;
      }

      expect(exitCode).toBe(1);
    });
  });

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
