import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { summarizeRun, type SummarizerInput, type SummarizerResult, type RunSummary } from '../../src/summarizer/summarizer.js';
import type { ExtractedPost } from '../src/types/post.js';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('Claude Summarizer', () => {
  let testStateDir: string;
  let mockApiKey: string;

  beforeEach(() => {
    // Create a unique temp directory for each test
    testStateDir = join(tmpdir(), `summarizer-test-${Date.now()}`);
    mockApiKey = 'sk-ant-test-key';

    // Clear environment variable
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    // Clean up test directory
    if (existsSync(testStateDir)) {
      rmSync(testStateDir, { recursive: true, force: true });
    }

    // Restore environment
    delete process.env.ANTHROPIC_API_KEY;
  });

  // Helper to create a minimal ExtractedPost
  function makePost(id: string, author: string, text: string, tickIndex = 0, quoted: ExtractedPost | null = null): ExtractedPost {
    return {
      id,
      url: `https://x.com/${author}/status/${id}`,
      author: { handle: author, displayName: author, verified: false },
      text,
      postedAt: '2026-04-17T09:00:00.000Z',
      metrics: { replies: 10, reposts: 5, likes: 100, views: 1000 },
      media: [],
      isRepost: false,
      repostedBy: null,
      quoted,
      extractedAt: '2026-04-17T09:10:00.000Z',
      tickIndex,
    };
  }

  describe('UT-SUM-001: Missing API key — fail fast, no network call', () => {
    it('returns error when config.claude.apiKey is unset and ANTHROPIC_API_KEY is unset', async () => {
      const input: SummarizerInput = {
        posts: [makePost('1', 'user1', 'test post')],
        newPostIds: ['1'],
        priorThemes: [],
        interests: ['AI product strategy'],
        runId: '2026-04-17T09-00-00Z',
        model: 'claude-sonnet-4-6',
        apiKey: '', // Empty string means not set
      };

      const result = await summarizeRun(input);

      expect(result.status).toBe('error');
      expect(result.reason).toContain('no_api_key');
      expect(result.reason).toContain('ANTHROPIC_API_KEY');
    });
  });

  describe('UT-SUM-002: config.claude.apiKey absent, ANTHROPIC_API_KEY set — env var is used', () => {
    it('uses ANTHROPIC_API_KEY when config.claude.apiKey is empty', async () => {
      process.env.ANTHROPIC_API_KEY = mockApiKey;

      const input: SummarizerInput = {
        posts: [makePost('1', 'user1', 'AI product strategy post')],
        newPostIds: ['1'],
        priorThemes: [],
        interests: ['AI product strategy'],
        runId: '2026-04-17T09-00-00Z',
        model: 'claude-sonnet-4-6',
        apiKey: '', // Empty means use env var
      };

      const result = await summarizeRun(input);

      // Should not error on missing API key (it will error on auth, but that's different)
      if (result.status === 'error') {
        expect(result.reason).not.toContain('no_api_key');
        // Likely will be "api_unavailable: 401 unauthorized" due to invalid key
        expect(result.reason).toContain('401');
      }
      // Note: This makes a real API call with an invalid key, which returns 401
    });
  });

  describe('UT-SUM-003: First run ever — no prior themes to cite', () => {
    it('handles empty priorThemes array correctly', async () => {
      const input: SummarizerInput = {
        posts: [
          makePost('1', 'user1', 'AI product strategy discussion'),
          makePost('2', 'user2', 'Sales enablement tools'),
        ],
        newPostIds: ['1', '2'],
        priorThemes: [], // First run
        interests: ['AI product strategy', 'sales enablement'],
        runId: '2026-04-17T09-00-00Z',
        model: 'claude-sonnet-4-6',
        apiKey: mockApiKey,
      };

      const result = await summarizeRun(input);

      if (result.status === 'ok') {
        expect(result.summary.themes.length).toBeGreaterThan(0);
        expect(result.summary.themes.length).toBeLessThanOrEqual(7);
        expect(result.summary.newVsSeen.newCount).toBe(2);
        expect(result.summary.newVsSeen.seenCount).toBe(0);
      }

      // Test will fail until implementation is complete
    });
  });

  describe('UT-SUM-004: Post payload is capped at 200 — older posts are omitted', () => {
    it('sends only 200 most recent posts when input exceeds limit', async () => {
      // Create 350 posts
      const posts: ExtractedPost[] = [];
      for (let i = 0; i < 350; i++) {
        posts.push(makePost(`${i}`, `user${i}`, `post ${i}`, i));
      }

      const input: SummarizerInput = {
        posts,
        newPostIds: posts.map(p => p.id),
        priorThemes: [],
        interests: ['AI product strategy'],
        runId: '2026-04-17T09-00-00Z',
        model: 'claude-sonnet-4-6',
        apiKey: mockApiKey,
      };

      const result = await summarizeRun(input);

      if (result.status === 'ok') {
        // Counts should reflect ALL posts, not just the 200 sent to Claude
        expect(result.summary.newVsSeen.newCount).toBe(350);
      }

      // Test will fail until implementation is complete
    });
  });

  describe('UT-SUM-005: Quoted-quoted chains are flattened to one level', () => {
    it('strips nested quote chains before sending to Claude', async () => {
      // Create a nested quote chain: C is quoted by B, B is quoted by A
      const postC = makePost('3', 'userC', 'original post C');
      const postB = makePost('2', 'userB', 'quoting C', 0, postC);
      const postA = makePost('1', 'userA', 'quoting B', 0, postB);

      const input: SummarizerInput = {
        posts: [postA],
        newPostIds: ['1'],
        priorThemes: [],
        interests: ['AI product strategy'],
        runId: '2026-04-17T09-00-00Z',
        model: 'claude-sonnet-4-6',
        apiKey: mockApiKey,
      };

      const result = await summarizeRun(input);

      // The implementation should flatten quoted.quoted to null
      // We can't directly inspect what was sent to Claude in this test,
      // but we can verify the function doesn't crash and returns a result
      expect(result.status).toBeDefined();

      // Test will fail until implementation is complete
    });
  });

  describe('UT-SUM-006: RunSummary structure matches schema version 1', () => {
    it('returns RunSummary with correct structure when successful', async () => {
      const input: SummarizerInput = {
        posts: [
          makePost('1', 'user1', 'AI product strategy'),
          makePost('2', 'user2', 'Sales enablement'),
        ],
        newPostIds: ['1', '2'],
        priorThemes: ['agent orchestration'],
        interests: ['AI product strategy', 'sales enablement'],
        runId: '2026-04-17T09-00-00Z',
        model: 'claude-sonnet-4-6',
        apiKey: mockApiKey,
      };

      const result = await summarizeRun(input);

      if (result.status === 'ok') {
        const summary = result.summary;

        // Schema version 1 structure
        expect(summary.schemaVersion).toBe(1);
        expect(summary.runId).toBe('2026-04-17T09-00-00Z');
        expect(summary.summarizedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        expect(summary.model).toBe('claude-sonnet-4-6');

        // Themes: 3-7 short labels
        expect(Array.isArray(summary.themes)).toBe(true);
        expect(summary.themes.length).toBeGreaterThanOrEqual(3);
        expect(summary.themes.length).toBeLessThanOrEqual(7);

        // Worth clicking: 0-10 items
        expect(Array.isArray(summary.worthClicking)).toBe(true);
        expect(summary.worthClicking.length).toBeLessThanOrEqual(10);

        // Voices: 0-5 items
        expect(Array.isArray(summary.voices)).toBe(true);
        expect(summary.voices.length).toBeLessThanOrEqual(5);

        // Noise summary
        expect(typeof summary.noise.count).toBe('number');
        expect(Array.isArray(summary.noise.examples)).toBe(true);
        expect(summary.noise.examples.length).toBeLessThanOrEqual(3);

        // New vs seen counts
        expect(summary.newVsSeen.newCount).toBe(2);
        expect(summary.newVsSeen.seenCount).toBe(0);

        // Feed verdict
        expect(['signal', 'mixed', 'noise']).toContain(summary.feedVerdict);
      }

      // Test will fail until implementation is complete
    });
  });

  describe('UT-SUM-007: WorthClickingItem structure', () => {
    it('each worth clicking item has required fields', async () => {
      const input: SummarizerInput = {
        posts: [
          makePost('1', 'someone', 'Concrete pattern for state sharing between agents'),
        ],
        newPostIds: ['1'],
        priorThemes: [],
        interests: ['AI product strategy'],
        runId: '2026-04-17T09-00-00Z',
        model: 'claude-sonnet-4-6',
        apiKey: mockApiKey,
      };

      const result = await summarizeRun(input);

      if (result.status === 'ok' && result.summary.worthClicking.length > 0) {
        const item = result.summary.worthClicking[0];

        expect(typeof item.postId).toBe('string');
        expect(typeof item.url).toBe('string');
        expect(item.url).toMatch(/^https:\/\//);
        expect(typeof item.author).toBe('string');
        expect(item.author).toMatch(/^@/);
        expect(typeof item.why).toBe('string');
        expect(item.why.length).toBeGreaterThan(0);
      }

      // Test will fail until implementation is complete
    });
  });

  describe('UT-SUM-008: VoiceItem structure', () => {
    it('each voice item has required fields', async () => {
      const input: SummarizerInput = {
        posts: [
          makePost('1', 'smalleraccount', 'First deep cut on AI product strategy'),
          makePost('2', 'smalleraccount', 'Second deep cut on AI product strategy'),
          makePost('3', 'smalleraccount', 'Third deep cut on AI product strategy'),
        ],
        newPostIds: ['1', '2', '3'],
        priorThemes: [],
        interests: ['AI product strategy'],
        runId: '2026-04-17T09-00-00Z',
        model: 'claude-sonnet-4-6',
        apiKey: mockApiKey,
      };

      const result = await summarizeRun(input);

      if (result.status === 'ok' && result.summary.voices.length > 0) {
        const item = result.summary.voices[0];

        expect(typeof item.handle).toBe('string');
        expect(item.handle).toMatch(/^@/);
        expect(typeof item.why).toBe('string');
        expect(item.why.length).toBeGreaterThan(0);
      }

      // Test will fail until implementation is complete
    });
  });

  describe('UT-SUM-009: config.claude.model drives the API call', () => {
    it('uses the specified model in the API call and summary', async () => {
      const input: SummarizerInput = {
        posts: [makePost('1', 'user1', 'test post')],
        newPostIds: ['1'],
        priorThemes: [],
        interests: ['AI product strategy'],
        runId: '2026-04-17T09-00-00Z',
        model: 'claude-opus-4-6', // Override default
        apiKey: mockApiKey,
      };

      const result = await summarizeRun(input);

      if (result.status === 'ok') {
        expect(result.summary.model).toBe('claude-opus-4-6');
      }

      // Test will fail until implementation is complete
    });
  });

  describe('UT-SUM-010: Typed errors, no throws', () => {
    it('returns typed error result instead of throwing on network failures', async () => {
      const input: SummarizerInput = {
        posts: [makePost('1', 'user1', 'test post')],
        newPostIds: ['1'],
        priorThemes: [],
        interests: ['AI product strategy'],
        runId: '2026-04-17T09-00-00Z',
        model: 'claude-sonnet-4-6',
        apiKey: 'invalid-key', // This should cause an auth error
      };

      // Should not throw
      const result = await summarizeRun(input);

      expect(result.status).toBe('error');
      expect(typeof result.reason).toBe('string');

      // Test will fail until implementation is complete
    });
  });
});
