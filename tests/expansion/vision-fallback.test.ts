import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createVisionFallback } from '../../src/extract/vision-fallback.js';
import type { ExtractedPost, ExtractionStats } from '../../src/extract/extractor.js';
import { mkdir, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

describe('Vision Fallback', () => {
  let testDir: string;
  let screenshotDir: string;

  beforeEach(async () => {
    // Create a temporary directory for each test
    testDir = join(tmpdir(), `vision-fallback-test-${Date.now()}`);
    screenshotDir = join(testDir, 'screenshots');
    await mkdir(screenshotDir, { recursive: true });
  });

  afterEach(async () => {
    // Clean up test directory
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('VF-01: shouldTrigger - healthy run', () => {
    it('returns false when post count is above floor and selector failures are low', () => {
      const fallback = createVisionFallback({
        enabled: true,
        minPosts: 20,
        maxSelectorFailureRatio: 0.3,
        screenshotEveryTicks: 5,
        maxScreenshotsPerRun: 24,
      });

      const stats: ExtractionStats = {
        postsExtracted: 84,
        adsSkipped: 6,
        selectorFailures: [],
        duplicateHits: 3,
      };

      const posts: ExtractedPost[] = Array(84).fill(null).map((_, i) => ({
        id: `${i}`,
        url: `https://x.com/user/status/${i}`,
        author: { handle: 'user', displayName: 'User', verified: false },
        text: `Post ${i}`,
        postedAt: new Date().toISOString(),
        metrics: { replies: 0, reposts: 0, likes: 0, views: 0 },
        media: [],
        isRepost: false,
        repostedBy: null,
        quoted: null,
        extractedAt: new Date().toISOString(),
        tickIndex: i,
      }));

      const result = fallback.shouldTrigger(stats, posts);

      expect(result.triggered).toBe(false);
    });
  });

  describe('VF-02: shouldTrigger - post count below floor', () => {
    it('returns true with reason postCountBelowFloor when posts < minPosts', () => {
      const fallback = createVisionFallback({
        enabled: true,
        minPosts: 20,
        maxSelectorFailureRatio: 0.3,
        screenshotEveryTicks: 5,
        maxScreenshotsPerRun: 24,
      });

      const stats: ExtractionStats = {
        postsExtracted: 4,
        adsSkipped: 6,
        selectorFailures: [],
        duplicateHits: 0,
      };

      const posts: ExtractedPost[] = Array(4).fill(null).map((_, i) => ({
        id: `${i}`,
        url: `https://x.com/user/status/${i}`,
        author: { handle: 'user', displayName: 'User', verified: false },
        text: `Post ${i}`,
        postedAt: new Date().toISOString(),
        metrics: { replies: 0, reposts: 0, likes: 0, views: 0 },
        media: [],
        isRepost: false,
        repostedBy: null,
        quoted: null,
        extractedAt: new Date().toISOString(),
        tickIndex: i,
      }));

      const result = fallback.shouldTrigger(stats, posts);

      expect(result.triggered).toBe(true);
      expect(result.reason).toBe('postCountBelowFloor');
    });
  });

  describe('VF-03: shouldTrigger - selector failure ratio above ceiling', () => {
    it('returns true with reason selectorFailureRatioAboveCeiling when ratio > max', () => {
      const fallback = createVisionFallback({
        enabled: true,
        minPosts: 20,
        maxSelectorFailureRatio: 0.3,
        screenshotEveryTicks: 5,
        maxScreenshotsPerRun: 24,
      });

      const posts: ExtractedPost[] = Array(60).fill(null).map((_, i) => ({
        id: `${i}`,
        url: `https://x.com/user/status/${i}`,
        author: { handle: 'user', displayName: 'User', verified: false },
        text: `Post ${i}`,
        postedAt: new Date().toISOString(),
        metrics: { replies: 0, reposts: 0, likes: 0, views: null }, // metrics.views is null
        media: [],
        isRepost: false,
        repostedBy: null,
        quoted: null,
        extractedAt: new Date().toISOString(),
        tickIndex: i,
      }));

      // 28 posts with at least one field-level failure (views: null)
      const stats: ExtractionStats = {
        postsExtracted: 60,
        adsSkipped: 0,
        selectorFailures: Array(28).fill(null).map((_, i) => ({
          field: 'metrics.views',
          postIdOrIndex: `${i}`,
          tickIndex: 0,
          reason: 'metric element not found',
        })),
        duplicateHits: 0,
      };

      const result = fallback.shouldTrigger(stats, posts);

      expect(result.triggered).toBe(true);
      expect(result.reason).toBe('selectorFailureRatioAboveCeiling');
    });
  });

  describe('VF-04: shouldTrigger - disabled by config', () => {
    it('returns false when enabled is false, regardless of thresholds', () => {
      const fallback = createVisionFallback({
        enabled: false,
        minPosts: 20,
        maxSelectorFailureRatio: 0.3,
        screenshotEveryTicks: 5,
        maxScreenshotsPerRun: 24,
      });

      const stats: ExtractionStats = {
        postsExtracted: 4, // Below floor
        adsSkipped: 6,
        selectorFailures: [],
        duplicateHits: 0,
      };

      const posts: ExtractedPost[] = Array(4).fill(null).map((_, i) => ({
        id: `${i}`,
        url: `https://x.com/user/status/${i}`,
        author: { handle: 'user', displayName: 'User', verified: false },
        text: `Post ${i}`,
        postedAt: new Date().toISOString(),
        metrics: { replies: 0, reposts: 0, likes: 0, views: 0 },
        media: [],
        isRepost: false,
        repostedBy: null,
        quoted: null,
        extractedAt: new Date().toISOString(),
        tickIndex: i,
      }));

      const result = fallback.shouldTrigger(stats, posts);

      expect(result.triggered).toBe(false);
    });
  });

  describe('VF-05: shouldTrigger - empty/stalled first tick', () => {
    it('returns false when post count is 0 and selector failures are 0', () => {
      const fallback = createVisionFallback({
        enabled: true,
        minPosts: 20,
        maxSelectorFailureRatio: 0.3,
        screenshotEveryTicks: 5,
        maxScreenshotsPerRun: 24,
      });

      const stats: ExtractionStats = {
        postsExtracted: 0,
        adsSkipped: 0,
        selectorFailures: [],
        duplicateHits: 0,
      };

      const posts: ExtractedPost[] = [];

      const result = fallback.shouldTrigger(stats, posts);

      expect(result.triggered).toBe(false);
    });
  });

  describe('VF-06: rescue - dedup by id', () => {
    it('deduplicates vision posts against DOM posts by id, keeping DOM version', async () => {
      // Mock Anthropic client
      const mockCreate = vi.fn().mockResolvedValue({
        content: [
          {
            type: 'text',
            text: JSON.stringify([
              {
                id: '999', // Same ID as DOM post
                url: 'https://x.com/user/status/999',
                author: { handle: 'user', displayName: 'User', verified: false },
                text: 'Vision extracted post',
                postedAt: new Date().toISOString(),
                metrics: { replies: 10, reposts: 5, likes: 20, views: 1000 },
                media: [],
                isRepost: false,
                repostedBy: null,
                quoted: null,
                extractedAt: new Date().toISOString(),
                tickIndex: 5,
              },
            ]),
          },
        ],
        usage: { input_tokens: 100, output_tokens: 50 },
      });

      const mockAnthropicClient = {
        messages: {
          create: mockCreate,
        },
      };

      // Create a mock screenshot
      await writeFile(join(screenshotDir, 'tick-5.png'), 'fake-screenshot-data');

      const fallback = createVisionFallback({
        enabled: true,
        minPosts: 20,
        maxSelectorFailureRatio: 0.3,
        screenshotEveryTicks: 5,
        maxScreenshotsPerRun: 24,
      });

      const existingPosts: ExtractedPost[] = [
        {
          id: '999', // Same ID as vision post
          url: 'https://x.com/user/status/999',
          author: { handle: 'user', displayName: 'User', verified: false },
          text: 'DOM extracted post',
          postedAt: new Date().toISOString(),
          metrics: { replies: 10, reposts: 5, likes: 20, views: 1000 },
          media: [],
          isRepost: false,
          repostedBy: null,
          quoted: null,
          extractedAt: new Date().toISOString(),
          tickIndex: 3,
        },
      ];

      const existingStats: ExtractionStats = {
        postsExtracted: 1,
        adsSkipped: 0,
        selectorFailures: [],
        duplicateHits: 0,
      };

      const result = await fallback.rescue({
        runId: 'test-run',
        screenshotDir,
        existingPosts,
        existingStats,
        anthropicClient: mockAnthropicClient as any,
      });

      // Should have 1 post (DOM version), not 2
      expect(result.posts.length).toBe(1);
      expect(result.posts[0].text).toBe('DOM extracted post'); // DOM version kept
      expect(result.visionStats.visionDuplicatesSkipped).toBe(1);
      expect(result.visionStats.visionPostsMerged).toBe(0); // Duplicate was skipped, not merged
    });
  });

  describe('VF-07: rescue - field-wise merge', () => {
    it('fills null fields from vision when same id has partial DOM data', async () => {
      // Mock Anthropic client
      const mockCreate = vi.fn().mockResolvedValue({
        content: [
          {
            type: 'text',
            text: JSON.stringify([
              {
                id: '999',
                url: 'https://x.com/user/status/999',
                author: { handle: 'user', displayName: 'User', verified: false },
                text: 'Post text',
                postedAt: new Date().toISOString(),
                metrics: { replies: 10, reposts: 5, likes: 20, views: 5400 }, // views filled by vision
                media: [],
                isRepost: false,
                repostedBy: null,
                quoted: null,
                extractedAt: new Date().toISOString(),
                tickIndex: 5,
              },
            ]),
          },
        ],
        usage: { input_tokens: 100, output_tokens: 50 },
      });

      const mockAnthropicClient = {
        messages: {
          create: mockCreate,
        },
      };

      await writeFile(join(screenshotDir, 'tick-5.png'), 'fake-screenshot-data');

      const fallback = createVisionFallback({
        enabled: true,
        minPosts: 20,
        maxSelectorFailureRatio: 0.3,
        screenshotEveryTicks: 5,
        maxScreenshotsPerRun: 24,
      });

      const existingPosts: ExtractedPost[] = [
        {
          id: '999',
          url: 'https://x.com/user/status/999',
          author: { handle: 'user', displayName: 'User', verified: false },
          text: 'Post text',
          postedAt: new Date().toISOString(),
          metrics: { replies: 10, reposts: 5, likes: 20, views: null }, // views is null from DOM
          media: [],
          isRepost: false,
          repostedBy: null,
          quoted: null,
          extractedAt: new Date().toISOString(),
          tickIndex: 3,
        },
      ];

      const existingStats: ExtractionStats = {
        postsExtracted: 1,
        adsSkipped: 0,
        selectorFailures: [
          {
            field: 'metrics.views',
            postIdOrIndex: '999',
            tickIndex: 3,
            reason: 'metric element not found',
          },
        ],
        duplicateHits: 0,
      };

      const result = await fallback.rescue({
        runId: 'test-run',
        screenshotDir,
        existingPosts,
        existingStats,
        anthropicClient: mockAnthropicClient as any,
      });

      // Should have 1 post with views filled from vision
      expect(result.posts.length).toBe(1);
      expect(result.posts[0].metrics.views).toBe(5400); // Filled from vision
      expect(result.posts[0].metrics.replies).toBe(10); // Preserved from DOM
      expect(result.visionStats.visionPostsMerged).toBe(1);
    });
  });

  describe('VF-08: rescue - screenshot budget enforcement', () => {
    it('drops oldest screenshots when over maxScreenshotsPerRun', async () => {
      // Mock Anthropic client
      const mockCreate = vi.fn().mockResolvedValue({
        content: [
          {
            type: 'text',
            text: JSON.stringify([]),
          },
        ],
        usage: { input_tokens: 100, output_tokens: 50 },
      });

      const mockAnthropicClient = {
        messages: {
          create: mockCreate,
        },
      };

      // Create 27 screenshots (exceeds budget of 24)
      for (let i = 0; i < 27; i++) {
        await writeFile(join(screenshotDir, `tick-${i * 5}.png`), `fake-screenshot-${i}`);
      }

      const fallback = createVisionFallback({
        enabled: true,
        minPosts: 20,
        maxSelectorFailureRatio: 0.3,
        screenshotEveryTicks: 5,
        maxScreenshotsPerRun: 24,
      });

      const existingPosts: ExtractedPost[] = [];
      const existingStats: ExtractionStats = {
        postsExtracted: 0,
        adsSkipped: 0,
        selectorFailures: [],
        duplicateHits: 0,
      };

      const result = await fallback.rescue({
        runId: 'test-run',
        screenshotDir,
        existingPosts,
        existingStats,
        anthropicClient: mockAnthropicClient as any,
      });

      // Should have sent 24 screenshots (dropped 3 oldest)
      expect(result.visionStats.screenshotsSent).toBe(24);
      expect(result.visionStats.screenshotsDropped).toBe(3);
    });
  });

  describe('VF-09: rescue - cost estimation', () => {
    it('estimates cost based on screenshots sent and tokens used', async () => {
      // Mock Anthropic client
      const mockCreate = vi.fn().mockResolvedValue({
        content: [
          {
            type: 'text',
            text: JSON.stringify([]),
          },
        ],
        usage: { input_tokens: 1000, output_tokens: 500 },
      });

      const mockAnthropicClient = {
        messages: {
          create: mockCreate,
        },
      };

      // Create 18 screenshots
      for (let i = 0; i < 18; i++) {
        await writeFile(join(screenshotDir, `tick-${i * 5}.png`), 'fake-screenshot-data');
      }

      const fallback = createVisionFallback({
        enabled: true,
        minPosts: 20,
        maxSelectorFailureRatio: 0.3,
        screenshotEveryTicks: 5,
        maxScreenshotsPerRun: 24,
      });

      const existingPosts: ExtractedPost[] = [];
      const existingStats: ExtractionStats = {
        postsExtracted: 0,
        adsSkipped: 0,
        selectorFailures: [],
        duplicateHits: 0,
      };

      const result = await fallback.rescue({
        runId: 'test-run',
        screenshotDir,
        existingPosts,
        existingStats,
        anthropicClient: mockAnthropicClient as any,
      });

      // Should have a cost estimate
      expect(result.visionStats.costEstimateUsd).toBeGreaterThan(0);
      expect(typeof result.visionStats.costEstimateUsd).toBe('number');
    });
  });

  describe('VF-10: rescue - API error handling', () => {
    it('records API errors and continues with existing posts', async () => {
      // Mock Anthropic client that throws an error
      const mockCreate = vi.fn().mockRejectedValue(new Error('API timeout'));

      const mockAnthropicClient = {
        messages: {
          create: mockCreate,
        },
      };

      await writeFile(join(screenshotDir, 'tick-5.png'), 'fake-screenshot-data');

      const fallback = createVisionFallback({
        enabled: true,
        minPosts: 20,
        maxSelectorFailureRatio: 0.3,
        screenshotEveryTicks: 5,
        maxScreenshotsPerRun: 24,
      });

      const existingPosts: ExtractedPost[] = [
        {
          id: '1',
          url: 'https://x.com/user/status/1',
          author: { handle: 'user', displayName: 'User', verified: false },
          text: 'DOM post',
          postedAt: new Date().toISOString(),
          metrics: { replies: 0, reposts: 0, likes: 0, views: 0 },
          media: [],
          isRepost: false,
          repostedBy: null,
          quoted: null,
          extractedAt: new Date().toISOString(),
          tickIndex: 0,
        },
      ];

      const existingStats: ExtractionStats = {
        postsExtracted: 1,
        adsSkipped: 0,
        selectorFailures: [],
        duplicateHits: 0,
      };

      const result = await fallback.rescue({
        runId: 'test-run',
        screenshotDir,
        existingPosts,
        existingStats,
        anthropicClient: mockAnthropicClient as any,
      });

      // Should return existing posts unchanged
      expect(result.posts.length).toBe(1);
      expect(result.posts[0].id).toBe('1');
      expect(result.visionStats.apiErrors.length).toBeGreaterThan(0);
      expect(result.visionStats.apiErrors[0].errorMessage).toContain('API timeout');
    });
  });
});
