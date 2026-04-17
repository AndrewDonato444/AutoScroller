import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeRawJson, generateRunId, type RunMeta } from '../../src/writer/raw-json.js';
import type { ExtractedPost, SelectorFailure } from '../../src/extract/extractor.js';
import { existsSync, mkdirSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('Raw JSON Writer', () => {
  let testOutputDir: string;

  beforeEach(() => {
    // Create a unique temp directory for each test
    testOutputDir = join(tmpdir(), `raw-json-writer-test-${Date.now()}`);
  });

  afterEach(() => {
    // Clean up test directory
    if (existsSync(testOutputDir)) {
      rmSync(testOutputDir, { recursive: true, force: true });
    }
  });

  describe('generateRunId', () => {
    it('UT-RJW-001: generates UTC-slug directory name with no colons', () => {
      const now = new Date('2026-04-16T14:32:07.123Z');
      const runId = generateRunId(now);

      expect(runId).toBe('2026-04-16T14-32-07Z');
      expect(runId).not.toContain(':');
    });

    it('UT-RJW-002: generates current time when no date provided', () => {
      const before = new Date();
      const runId = generateRunId();
      const after = new Date();

      // Check it's a valid format
      expect(runId).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/);

      // Parse it back to verify it's within the time window
      const parsed = new Date(runId.replace(/T(\d{2})-(\d{2})-(\d{2})Z/, 'T$1:$2:$3Z'));
      expect(parsed.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
      expect(parsed.getTime()).toBeLessThanOrEqual(after.getTime() + 1000);
    });
  });

  describe('writeRawJson', () => {
    it('UT-RJW-003: writes raw.json to timestamped run directory', async () => {
      const runId = '2026-04-16T14-32-07Z';
      const posts: ExtractedPost[] = [
        {
          id: '1234567890',
          url: 'https://x.com/user/status/1234567890',
          author: {
            handle: 'testuser',
            displayName: 'Test User',
            verified: false,
          },
          text: 'Test post',
          postedAt: '2026-04-16T14:00:00.000Z',
          metrics: {
            replies: 10,
            reposts: 5,
            likes: 20,
            views: 100,
          },
          media: [],
          isRepost: false,
          repostedBy: null,
          quoted: null,
          extractedAt: '2026-04-16T14:32:00.000Z',
          tickIndex: 1,
        },
      ];

      const stats = {
        postsExtracted: 84,
        adsSkipped: 6,
        selectorFailures: [] as SelectorFailure[],
        duplicateHits: 2,
      };

      const meta: RunMeta = {
        startedAt: '2026-04-16T14:32:07.000Z',
        endedAt: '2026-04-16T14:35:07.000Z',
        elapsedMs: 180000,
        tickCount: 132,
        minutes: 3,
        dryRun: false,
      };

      const result = await writeRawJson({
        outputDir: testOutputDir,
        runId,
        posts,
        stats,
        meta,
      });

      // Check return value
      expect(result.runDir).toBe(join(testOutputDir, runId));
      expect(result.rawJsonPath).toBe(join(testOutputDir, runId, 'raw.json'));

      // Check directory exists
      expect(existsSync(result.runDir)).toBe(true);

      // Check file exists
      expect(existsSync(result.rawJsonPath)).toBe(true);

      // Read and parse the file
      const content = readFileSync(result.rawJsonPath, 'utf-8');
      const payload = JSON.parse(content);

      // Verify structure
      expect(payload.schemaVersion).toBe(1);
      expect(payload.posts.length).toBe(1);
      expect(payload.stats.adsSkipped).toBe(6);
      expect(payload.stats.duplicateHits).toBe(2);
    });

    it('UT-RJW-004: JSON payload has exact schema version 1 structure', async () => {
      const runId = '2026-04-16T14-32-07Z';
      const posts: ExtractedPost[] = [];
      const selectorFailures: SelectorFailure[] = [
        {
          field: 'metrics.views',
          postIdOrIndex: '1234567890',
          tickIndex: 12,
          reason: 'aria-label not found',
        },
      ];

      const stats = {
        postsExtracted: 84,
        adsSkipped: 6,
        selectorFailures,
        duplicateHits: 2,
      };

      const meta: RunMeta = {
        startedAt: '2026-04-16T14:32:07.000Z',
        endedAt: '2026-04-16T14:35:07.000Z',
        elapsedMs: 180000,
        tickCount: 132,
        minutes: 3,
        dryRun: false,
      };

      const result = await writeRawJson({
        outputDir: testOutputDir,
        runId,
        posts,
        stats,
        meta,
      });

      const content = readFileSync(result.rawJsonPath, 'utf-8');
      const payload = JSON.parse(content);

      // Check top-level keys are in the correct order
      const keys = Object.keys(payload);
      expect(keys).toEqual([
        'schemaVersion',
        'runId',
        'startedAt',
        'endedAt',
        'elapsedMs',
        'tickCount',
        'config',
        'stats',
        'selectorFailures',
        'posts',
      ]);

      // Check schemaVersion
      expect(payload.schemaVersion).toBe(1);

      // Check config has only minutes and dryRun
      expect(Object.keys(payload.config).sort()).toEqual(['dryRun', 'minutes']);
      expect(payload.config.minutes).toBe(3);
      expect(payload.config.dryRun).toBe(false);

      // Check stats has exactly the right keys
      expect(Object.keys(payload.stats).sort()).toEqual([
        'adsSkipped',
        'duplicateHits',
        'postsExtracted',
        'selectorFailures',
      ]);
      expect(payload.stats.postsExtracted).toBe(84);
      expect(payload.stats.adsSkipped).toBe(6);
      expect(payload.stats.selectorFailures).toBe(1);
      expect(payload.stats.duplicateHits).toBe(2);

      // Check selectorFailures is a top-level array
      expect(Array.isArray(payload.selectorFailures)).toBe(true);
      expect(payload.selectorFailures.length).toBe(1);
      expect(payload.selectorFailures[0]).toEqual({
        field: 'metrics.views',
        postIdOrIndex: '1234567890',
        tickIndex: 12,
        reason: 'aria-label not found',
      });

      // Check posts is an array
      expect(Array.isArray(payload.posts)).toBe(true);
    });

    it('UT-RJW-005: config block excludes secrets and browser paths', async () => {
      const runId = '2026-04-16T14-32-07Z';
      const meta: RunMeta = {
        startedAt: '2026-04-16T14:32:07.000Z',
        endedAt: '2026-04-16T14:35:07.000Z',
        elapsedMs: 180000,
        tickCount: 132,
        minutes: 3,
        dryRun: false,
      };

      const result = await writeRawJson({
        outputDir: testOutputDir,
        runId,
        posts: [],
        stats: {
          postsExtracted: 0,
          adsSkipped: 0,
          selectorFailures: [],
          duplicateHits: 0,
        },
        meta,
      });

      const content = readFileSync(result.rawJsonPath, 'utf-8');
      const payload = JSON.parse(content);

      // Check that config only has minutes and dryRun
      expect(payload.config).toEqual({
        minutes: 3,
        dryRun: false,
      });

      // Verify no secrets anywhere in the file
      expect(content).not.toContain('apiKey');
      expect(content).not.toContain('sk-ant-');
      expect(content).not.toContain('userDataDir');
      expect(content).not.toContain('viewport');
    });

    it('UT-RJW-006: selectorFailures detail array matches extractor stats', async () => {
      const runId = '2026-04-16T14-32-07Z';
      const selectorFailures: SelectorFailure[] = [
        {
          field: 'metrics.views',
          postIdOrIndex: '1234567890',
          tickIndex: 12,
          reason: 'aria-label not found',
        },
        {
          field: 'author.handle',
          postIdOrIndex: '9876543210',
          tickIndex: 15,
          reason: 'handle not found',
        },
        {
          field: 'metrics.likes',
          postIdOrIndex: '5555555555',
          tickIndex: 20,
          reason: 'metric element not found',
        },
      ];

      const stats = {
        postsExtracted: 80,
        adsSkipped: 3,
        selectorFailures,
        duplicateHits: 1,
      };

      const meta: RunMeta = {
        startedAt: '2026-04-16T14:32:07.000Z',
        endedAt: '2026-04-16T14:35:07.000Z',
        elapsedMs: 180000,
        tickCount: 132,
        minutes: 3,
        dryRun: false,
      };

      const result = await writeRawJson({
        outputDir: testOutputDir,
        runId,
        posts: [],
        stats,
        meta,
      });

      const content = readFileSync(result.rawJsonPath, 'utf-8');
      const payload = JSON.parse(content);

      // Check stats summary
      expect(payload.stats.selectorFailures).toBe(3);

      // Check detail array
      expect(payload.selectorFailures).toEqual(selectorFailures);
    });

    it('UT-RJW-007: empty scroll (zero posts) still writes valid raw.json', async () => {
      const runId = '2026-04-16T14-32-07Z';
      const stats = {
        postsExtracted: 0,
        adsSkipped: 0,
        selectorFailures: [],
        duplicateHits: 0,
      };

      const meta: RunMeta = {
        startedAt: '2026-04-16T14:32:07.000Z',
        endedAt: '2026-04-16T14:33:07.000Z',
        elapsedMs: 60000,
        tickCount: 20,
        minutes: 1,
        dryRun: false,
      };

      const result = await writeRawJson({
        outputDir: testOutputDir,
        runId,
        posts: [],
        stats,
        meta,
      });

      // Check file exists
      expect(existsSync(result.rawJsonPath)).toBe(true);

      const content = readFileSync(result.rawJsonPath, 'utf-8');
      const payload = JSON.parse(content);

      // Verify empty posts array
      expect(payload.posts).toEqual([]);
      expect(payload.stats.postsExtracted).toBe(0);
      expect(payload.tickCount).toBe(20);
      expect(payload.elapsedMs).toBe(60000);
    });

    it('UT-RJW-008: output.dir respects tilde expansion', async () => {
      // Use a path with ~ that we'll manually expand
      const tildeOutputDir = '~/scrollproxy-test';
      const expandedOutputDir = tildeOutputDir.replace(/^~/, require('os').homedir());
      const runId = '2026-04-16T14-32-07Z';

      try {
        const meta: RunMeta = {
          startedAt: '2026-04-16T14:32:07.000Z',
          endedAt: '2026-04-16T14:33:07.000Z',
          elapsedMs: 60000,
          tickCount: 20,
          minutes: 1,
          dryRun: false,
        };

        const result = await writeRawJson({
          outputDir: tildeOutputDir,
          runId,
          posts: [],
          stats: {
            postsExtracted: 0,
            adsSkipped: 0,
            selectorFailures: [],
            duplicateHits: 0,
          },
          meta,
        });

        // Check that the result path is expanded
        expect(result.runDir).toBe(join(expandedOutputDir, runId));
        expect(result.rawJsonPath).toBe(join(expandedOutputDir, runId, 'raw.json'));

        // Check file exists at the expanded path
        expect(existsSync(result.rawJsonPath)).toBe(true);
      } finally {
        // Clean up
        if (existsSync(expandedOutputDir)) {
          rmSync(expandedOutputDir, { recursive: true, force: true });
        }
      }
    });

    it('UT-RJW-009: writer is read-only - does not mutate input posts or stats', async () => {
      const runId = '2026-04-16T14-32-07Z';
      const posts: ExtractedPost[] = [
        {
          id: '1234567890',
          url: 'https://x.com/user/status/1234567890',
          author: {
            handle: 'testuser',
            displayName: 'Test User',
            verified: false,
          },
          text: 'Test post',
          postedAt: '2026-04-16T14:00:00.000Z',
          metrics: {
            replies: 10,
            reposts: 5,
            likes: 20,
            views: 100,
          },
          media: [],
          isRepost: false,
          repostedBy: null,
          quoted: null,
          extractedAt: '2026-04-16T14:32:00.000Z',
          tickIndex: 1,
        },
      ];

      const stats = {
        postsExtracted: 1,
        adsSkipped: 0,
        selectorFailures: [] as SelectorFailure[],
        duplicateHits: 0,
      };

      // Create deep copies to compare later
      const postsCopy = JSON.parse(JSON.stringify(posts));
      const statsCopy = JSON.parse(JSON.stringify(stats));

      const meta: RunMeta = {
        startedAt: '2026-04-16T14:32:07.000Z',
        endedAt: '2026-04-16T14:33:07.000Z',
        elapsedMs: 60000,
        tickCount: 20,
        minutes: 1,
        dryRun: false,
      };

      await writeRawJson({
        outputDir: testOutputDir,
        runId,
        posts,
        stats,
        meta,
      });

      // Verify no mutation
      expect(posts).toEqual(postsCopy);
      expect(stats).toEqual(statsCopy);
    });

    it('UT-RJW-010: writer creates directory recursively if missing', async () => {
      const runId = '2026-04-16T14-32-07Z';
      const nestedOutputDir = join(testOutputDir, 'nested', 'path', 'to', 'runs');

      const meta: RunMeta = {
        startedAt: '2026-04-16T14:32:07.000Z',
        endedAt: '2026-04-16T14:33:07.000Z',
        elapsedMs: 60000,
        tickCount: 20,
        minutes: 1,
        dryRun: false,
      };

      // Verify directory doesn't exist yet
      expect(existsSync(nestedOutputDir)).toBe(false);

      const result = await writeRawJson({
        outputDir: nestedOutputDir,
        runId,
        posts: [],
        stats: {
          postsExtracted: 0,
          adsSkipped: 0,
          selectorFailures: [],
          duplicateHits: 0,
        },
        meta,
      });

      // Verify directory was created
      expect(existsSync(result.runDir)).toBe(true);
      expect(existsSync(result.rawJsonPath)).toBe(true);
    });

    it('UT-RJW-011: JSON is formatted with 2-space indentation and trailing newline', async () => {
      const runId = '2026-04-16T14-32-07Z';
      const meta: RunMeta = {
        startedAt: '2026-04-16T14:32:07.000Z',
        endedAt: '2026-04-16T14:33:07.000Z',
        elapsedMs: 60000,
        tickCount: 20,
        minutes: 1,
        dryRun: false,
      };

      const result = await writeRawJson({
        outputDir: testOutputDir,
        runId,
        posts: [],
        stats: {
          postsExtracted: 0,
          adsSkipped: 0,
          selectorFailures: [],
          duplicateHits: 0,
        },
        meta,
      });

      const content = readFileSync(result.rawJsonPath, 'utf-8');

      // Check for 2-space indentation (look for consistent patterns)
      expect(content).toContain('  "schemaVersion"');
      expect(content).toContain('  "runId"');

      // Check for trailing newline
      expect(content.endsWith('\n')).toBe(true);

      // Verify it's valid JSON
      expect(() => JSON.parse(content)).not.toThrow();
    });

    it('UT-RJW-012: atomic write - tmpfile is used and then renamed', async () => {
      const runId = '2026-04-16T14-32-07Z';
      const meta: RunMeta = {
        startedAt: '2026-04-16T14:32:07.000Z',
        endedAt: '2026-04-16T14:33:07.000Z',
        elapsedMs: 60000,
        tickCount: 20,
        minutes: 1,
        dryRun: false,
      };

      const result = await writeRawJson({
        outputDir: testOutputDir,
        runId,
        posts: [],
        stats: {
          postsExtracted: 0,
          adsSkipped: 0,
          selectorFailures: [],
          duplicateHits: 0,
        },
        meta,
      });

      // After successful write, tmpfile should not exist
      const tmpFilePath = result.rawJsonPath + '.tmp';
      expect(existsSync(tmpFilePath)).toBe(false);

      // Final file should exist
      expect(existsSync(result.rawJsonPath)).toBe(true);
    });

    it('UT-RJW-013: writer never writes outside the configured output.dir', async () => {
      const runId = '2026-04-16T14-32-07Z';
      const meta: RunMeta = {
        startedAt: '2026-04-16T14:32:07.000Z',
        endedAt: '2026-04-16T14:33:07.000Z',
        elapsedMs: 60000,
        tickCount: 20,
        minutes: 1,
        dryRun: false,
      };

      const result = await writeRawJson({
        outputDir: testOutputDir,
        runId,
        posts: [],
        stats: {
          postsExtracted: 0,
          adsSkipped: 0,
          selectorFailures: [],
          duplicateHits: 0,
        },
        meta,
      });

      // Verify the result paths are under testOutputDir
      expect(result.runDir.startsWith(testOutputDir)).toBe(true);
      expect(result.rawJsonPath.startsWith(testOutputDir)).toBe(true);

      // Verify no files were created at the repo root
      const repoRootRawJson = join(process.cwd(), 'raw.json');
      expect(existsSync(repoRootRawJson)).toBe(false);
    });
  });
});
