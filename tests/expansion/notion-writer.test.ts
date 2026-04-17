import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import type { RunSummary } from '../../src/summarizer/summarizer.js';
import type { WriteContext } from '../../src/writer/writer.js';
import { createNotionWriter, type NotionWriterConfig } from '../../src/writer/notion.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Test ID prefix: NT (Notion Tests)

/**
 * Create a minimal RunSummary for testing.
 */
function createTestSummary(overrides?: Partial<RunSummary>): RunSummary {
  return {
    schemaVersion: 1,
    runId: 'test-run-123',
    summarizedAt: '2026-04-17T09:12:00.000Z',
    model: 'claude-sonnet-4-6',
    themes: ['agent orchestration', 'indie-dev distribution', 'sales enablement'],
    worthClicking: [
      {
        postId: 'post-1',
        url: 'https://x.com/someone/status/1',
        author: '@someone',
        why: 'Concrete pattern for state sharing — worth reading',
      },
      {
        postId: 'post-2',
        url: 'https://x.com/devgrinder/status/2',
        author: '@devgrinder',
        why: 'Teardown of a mid-market GTM motion',
      },
    ],
    voices: [
      {
        handle: '@smalleraccount',
        why: 'Three deep cuts on AI product strategy',
      },
    ],
    noise: {
      count: 42,
      examples: ['reply-guy politics', 'crypto shilling', 'vague motivational quotes'],
    },
    newVsSeen: { newCount: 10, seenCount: 5 },
    feedVerdict: 'mixed',
    ...overrides,
  };
}

/**
 * Create a test WriteContext.
 */
function createTestContext(runDir: string): WriteContext {
  return {
    runId: 'test-run-123',
    runDir,
    rawJsonPath: join(runDir, 'raw.json'),
    summaryJsonPath: join(runDir, 'summary.json'),
    displayRawJsonPath: '~/scrollproxy/runs/test-run-123/raw.json',
    displaySummaryJsonPath: '~/scrollproxy/runs/test-run-123/summary.json',
  };
}

/**
 * Mock Notion client factory.
 */
function createMockNotionClient(behavior: 'success' | '401' | '403' | '404' | '429' | '500' | 'timeout' | 'network-error' = 'success') {
  const mockCreate = vi.fn();

  switch (behavior) {
    case 'success':
      mockCreate.mockResolvedValue({
        id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      });
      break;
    case '401':
      mockCreate.mockRejectedValue({
        code: 'unauthorized',
        status: 401,
        message: 'Invalid token',
      });
      break;
    case '403':
      mockCreate.mockRejectedValue({
        code: 'restricted_resource',
        status: 403,
        message: 'Integration does not have access',
      });
      break;
    case '404':
      mockCreate.mockRejectedValue({
        code: 'object_not_found',
        status: 404,
        message: 'Parent page not found',
      });
      break;
    case '429':
      mockCreate.mockRejectedValueOnce({
        code: 'rate_limited',
        status: 429,
        message: 'Rate limited',
        headers: { 'retry-after': '2' },
      });
      // Second call succeeds (for retry test)
      mockCreate.mockResolvedValueOnce({
        id: 'retry-success-id',
      });
      break;
    case '500':
      mockCreate.mockRejectedValueOnce({
        status: 500,
        message: 'Internal server error',
      });
      // Second call succeeds (for retry test)
      mockCreate.mockResolvedValueOnce({
        id: 'retry-success-id',
      });
      break;
    case 'timeout':
      mockCreate.mockRejectedValue(new Error('Request timeout'));
      break;
    case 'network-error':
      mockCreate.mockRejectedValue(new Error('Network error: ECONNREFUSED'));
      break;
  }

  return {
    pages: {
      create: mockCreate,
    },
  };
}

describe('NotionWriter (NT)', () => {
  describe('NT-001: Basic creation and configuration', () => {
    it('should create a writer with id="notion"', () => {
      const config: NotionWriterConfig = {
        token: 'secret_test123',
        parentPageId: 'test-parent-id',
      };

      const writer = createNotionWriter(config);
      expect(writer.id).toBe('notion');
    });

    it('should accept optional model in config', () => {
      const config: NotionWriterConfig = {
        token: 'secret_test123',
        parentPageId: 'test-parent-id',
        model: 'custom-model',
      };

      const writer = createNotionWriter(config);
      expect(writer.id).toBe('notion');
    });
  });

  describe('NT-002: Successful page creation', () => {
    it('should create a Notion page and return success receipt', async () => {
      const config: NotionWriterConfig = {
        token: 'secret_test123',
        parentPageId: 'parent-123',
      };

      const summary = createTestSummary();
      const tmpDir = await mkdtemp(join(tmpdir(), 'notion-test-'));
      const context = createTestContext(tmpDir);

      // Mock the Notion client
      const mockClient = createMockNotionClient('success');
      const writer = createNotionWriter(config, mockClient as any);

      const receipt = await writer.write(summary, context);

      expect(receipt.ok).toBe(true);
      if (receipt.ok) {
        expect(receipt.kind).toBe('notion');
        expect(receipt.displayLocation).toMatch(/^https:\/\/notion\.so\//);
        expect(receipt.displayLocation).toContain('a1b2c3d4e5f67890abcdef1234567890');
      }

      expect(mockClient.pages.create).toHaveBeenCalledOnce();

      await rm(tmpDir, { recursive: true });
    });

    it('should format page title as "ScrollProxy — YYYY-MM-DD HH:MM UTC"', async () => {
      const config: NotionWriterConfig = {
        token: 'secret_test123',
        parentPageId: 'parent-123',
      };

      const summary = createTestSummary({
        summarizedAt: '2026-04-17T09:12:34.567Z',
      });
      const tmpDir = await mkdtemp(join(tmpdir(), 'notion-test-'));
      const context = createTestContext(tmpDir);

      const mockClient = createMockNotionClient('success');
      const writer = createNotionWriter(config, mockClient as any);

      await writer.write(summary, context);

      const createCall = mockClient.pages.create.mock.calls[0][0];
      expect(createCall.properties.title[0].text.content).toBe('ScrollProxy — 2026-04-17 09:12 UTC');

      await rm(tmpDir, { recursive: true });
    });

    it('should include all four sections in correct order', async () => {
      const config: NotionWriterConfig = {
        token: 'secret_test123',
        parentPageId: 'parent-123',
      };

      const summary = createTestSummary();
      const tmpDir = await mkdtemp(join(tmpdir(), 'notion-test-'));
      const context = createTestContext(tmpDir);

      const mockClient = createMockNotionClient('success');
      const writer = createNotionWriter(config, mockClient as any);

      await writer.write(summary, context);

      const createCall = mockClient.pages.create.mock.calls[0][0];
      const blocks = createCall.children;

      // Extract heading texts
      const headings = blocks
        .filter((b: any) => b.type === 'heading_2')
        .map((b: any) => b.heading_2.rich_text[0].text.content);

      expect(headings).toEqual(['Themes', 'Worth clicking', 'Voices', 'Noise']);

      await rm(tmpDir, { recursive: true });
    });

    it('should use persona vocabulary in section headers', async () => {
      const config: NotionWriterConfig = {
        token: 'secret_test123',
        parentPageId: 'parent-123',
      };

      const summary = createTestSummary();
      const tmpDir = await mkdtemp(join(tmpdir(), 'notion-test-'));
      const context = createTestContext(tmpDir);

      const mockClient = createMockNotionClient('success');
      const writer = createNotionWriter(config, mockClient as any);

      await writer.write(summary, context);

      const createCall = mockClient.pages.create.mock.calls[0][0];
      const blocks = createCall.children;

      const headings = blocks
        .filter((b: any) => b.type === 'heading_2')
        .map((b: any) => b.heading_2.rich_text[0].text.content);

      // Must be exact persona vocabulary (not "Recommended", "Top Picks", etc.)
      expect(headings).toContain('Worth clicking');
      expect(headings).toContain('Voices');
      expect(headings).toContain('Noise');
      expect(headings).not.toContain('Recommended');
      expect(headings).not.toContain('Top Picks');
      expect(headings).not.toContain('Filtered');

      await rm(tmpDir, { recursive: true });
    });
  });

  describe('NT-003: Error handling - auth failures', () => {
    it('should return failure receipt on 401 (invalid token)', async () => {
      const config: NotionWriterConfig = {
        token: 'secret_invalid',
        parentPageId: 'parent-123',
      };

      const summary = createTestSummary();
      const tmpDir = await mkdtemp(join(tmpdir(), 'notion-test-'));
      const context = createTestContext(tmpDir);

      const mockClient = createMockNotionClient('401');
      const writer = createNotionWriter(config, mockClient as any);

      const receipt = await writer.write(summary, context);

      expect(receipt.ok).toBe(false);
      if (!receipt.ok) {
        expect(receipt.reason).toContain('notion_not_authorized');
        expect(receipt.reason).toContain('token');
      }

      await rm(tmpDir, { recursive: true });
    });

    it('should return failure receipt on 403 (integration not added to page)', async () => {
      const config: NotionWriterConfig = {
        token: 'secret_test123',
        parentPageId: 'parent-123',
      };

      const summary = createTestSummary();
      const tmpDir = await mkdtemp(join(tmpdir(), 'notion-test-'));
      const context = createTestContext(tmpDir);

      const mockClient = createMockNotionClient('403');
      const writer = createNotionWriter(config, mockClient as any);

      const receipt = await writer.write(summary, context);

      expect(receipt.ok).toBe(false);
      if (!receipt.ok) {
        expect(receipt.reason).toContain('notion_not_authorized');
        expect(receipt.reason).toContain('parent page');
      }

      await rm(tmpDir, { recursive: true });
    });

    it('should not retry on 403 (non-transient error)', async () => {
      const config: NotionWriterConfig = {
        token: 'secret_test123',
        parentPageId: 'parent-123',
      };

      const summary = createTestSummary();
      const tmpDir = await mkdtemp(join(tmpdir(), 'notion-test-'));
      const context = createTestContext(tmpDir);

      const mockClient = createMockNotionClient('403');
      const writer = createNotionWriter(config, mockClient as any);

      await writer.write(summary, context);

      // Should only be called once (no retry)
      expect(mockClient.pages.create).toHaveBeenCalledTimes(1);

      await rm(tmpDir, { recursive: true });
    });
  });

  describe('NT-004: Error handling - parent page not found', () => {
    it('should return failure receipt on 404', async () => {
      const config: NotionWriterConfig = {
        token: 'secret_test123',
        parentPageId: 'nonexistent-parent',
      };

      const summary = createTestSummary();
      const tmpDir = await mkdtemp(join(tmpdir(), 'notion-test-'));
      const context = createTestContext(tmpDir);

      const mockClient = createMockNotionClient('404');
      const writer = createNotionWriter(config, mockClient as any);

      const receipt = await writer.write(summary, context);

      expect(receipt.ok).toBe(false);
      if (!receipt.ok) {
        expect(receipt.reason).toContain('notion_parent_not_found');
        expect(receipt.reason).toContain('nonexistent-parent');
      }

      await rm(tmpDir, { recursive: true });
    });
  });

  describe('NT-005: Retry behavior', () => {
    it('should retry once on 429 and succeed', async () => {
      const config: NotionWriterConfig = {
        token: 'secret_test123',
        parentPageId: 'parent-123',
      };

      const summary = createTestSummary();
      const tmpDir = await mkdtemp(join(tmpdir(), 'notion-test-'));
      const context = createTestContext(tmpDir);

      const mockClient = createMockNotionClient('429');
      const writer = createNotionWriter(config, mockClient as any);

      const receipt = await writer.write(summary, context);

      expect(receipt.ok).toBe(true);
      // Should have been called twice (initial + retry)
      expect(mockClient.pages.create).toHaveBeenCalledTimes(2);

      await rm(tmpDir, { recursive: true });
    });

    it('should retry once on 5xx and succeed', async () => {
      const config: NotionWriterConfig = {
        token: 'secret_test123',
        parentPageId: 'parent-123',
      };

      const summary = createTestSummary();
      const tmpDir = await mkdtemp(join(tmpdir(), 'notion-test-'));
      const context = createTestContext(tmpDir);

      const mockClient = createMockNotionClient('500');
      const writer = createNotionWriter(config, mockClient as any);

      const receipt = await writer.write(summary, context);

      expect(receipt.ok).toBe(true);
      expect(mockClient.pages.create).toHaveBeenCalledTimes(2);

      await rm(tmpDir, { recursive: true });
    });

    it('should return failure if retry also fails', async () => {
      const config: NotionWriterConfig = {
        token: 'secret_test123',
        parentPageId: 'parent-123',
      };

      const summary = createTestSummary();
      const tmpDir = await mkdtemp(join(tmpdir(), 'notion-test-'));
      const context = createTestContext(tmpDir);

      // Create mock that fails on both attempts
      const mockCreate = vi.fn();
      mockCreate.mockRejectedValue({
        code: 'rate_limited',
        status: 429,
        message: 'Rate limited',
      });

      const mockClient = {
        pages: {
          create: mockCreate,
        },
      };

      const writer = createNotionWriter(config, mockClient as any);

      const receipt = await writer.write(summary, context);

      expect(receipt.ok).toBe(false);
      if (!receipt.ok) {
        expect(receipt.reason).toContain('notion_rate_limited');
      }

      // Should have been called twice (initial + retry)
      expect(mockCreate).toHaveBeenCalledTimes(2);

      await rm(tmpDir, { recursive: true });
    });
  });

  describe('NT-006: Network and timeout errors', () => {
    it('should return failure receipt on timeout', async () => {
      const config: NotionWriterConfig = {
        token: 'secret_test123',
        parentPageId: 'parent-123',
      };

      const summary = createTestSummary();
      const tmpDir = await mkdtemp(join(tmpdir(), 'notion-test-'));
      const context = createTestContext(tmpDir);

      const mockClient = createMockNotionClient('timeout');
      const writer = createNotionWriter(config, mockClient as any);

      const receipt = await writer.write(summary, context);

      expect(receipt.ok).toBe(false);
      if (!receipt.ok) {
        expect(receipt.reason).toContain('notion_timeout');
      }

      await rm(tmpDir, { recursive: true });
    });

    it('should return failure receipt on network error', async () => {
      const config: NotionWriterConfig = {
        token: 'secret_test123',
        parentPageId: 'parent-123',
      };

      const summary = createTestSummary();
      const tmpDir = await mkdtemp(join(tmpdir(), 'notion-test-'));
      const context = createTestContext(tmpDir);

      const mockClient = createMockNotionClient('network-error');
      const writer = createNotionWriter(config, mockClient as any);

      const receipt = await writer.write(summary, context);

      expect(receipt.ok).toBe(false);
      if (!receipt.ok) {
        expect(receipt.reason).toMatch(/notion.*network/i);
      }

      await rm(tmpDir, { recursive: true });
    });
  });

  describe('NT-007: Block structure', () => {
    it('should render themes as bulleted list', async () => {
      const config: NotionWriterConfig = {
        token: 'secret_test123',
        parentPageId: 'parent-123',
      };

      const summary = createTestSummary({
        themes: ['theme-1', 'theme-2', 'theme-3'],
      });
      const tmpDir = await mkdtemp(join(tmpdir(), 'notion-test-'));
      const context = createTestContext(tmpDir);

      const mockClient = createMockNotionClient('success');
      const writer = createNotionWriter(config, mockClient as any);

      await writer.write(summary, context);

      const createCall = mockClient.pages.create.mock.calls[0][0];
      const blocks = createCall.children;

      // Find Themes section
      const themesHeadingIndex = blocks.findIndex(
        (b: any) => b.type === 'heading_2' && b.heading_2.rich_text[0].text.content === 'Themes'
      );
      expect(themesHeadingIndex).toBeGreaterThanOrEqual(0);

      // Next 3 blocks should be bulleted list items
      for (let i = 1; i <= 3; i++) {
        const block = blocks[themesHeadingIndex + i];
        expect(block.type).toBe('bulleted_list_item');
      }

      await rm(tmpDir, { recursive: true });
    });

    it('should render empty themes with italic placeholder', async () => {
      const config: NotionWriterConfig = {
        token: 'secret_test123',
        parentPageId: 'parent-123',
      };

      const summary = createTestSummary({
        themes: [],
      });
      const tmpDir = await mkdtemp(join(tmpdir(), 'notion-test-'));
      const context = createTestContext(tmpDir);

      const mockClient = createMockNotionClient('success');
      const writer = createNotionWriter(config, mockClient as any);

      await writer.write(summary, context);

      const createCall = mockClient.pages.create.mock.calls[0][0];
      const blocks = createCall.children;

      const themesHeadingIndex = blocks.findIndex(
        (b: any) => b.type === 'heading_2' && b.heading_2.rich_text[0].text.content === 'Themes'
      );

      const nextBlock = blocks[themesHeadingIndex + 1];
      expect(nextBlock.type).toBe('paragraph');
      expect(nextBlock.paragraph.rich_text[0].annotations.italic).toBe(true);
      expect(nextBlock.paragraph.rich_text[0].text.content).toContain('no themes');

      await rm(tmpDir, { recursive: true });
    });

    it('should render worth-clicking as numbered list with links', async () => {
      const config: NotionWriterConfig = {
        token: 'secret_test123',
        parentPageId: 'parent-123',
      };

      const summary = createTestSummary();
      const tmpDir = await mkdtemp(join(tmpdir(), 'notion-test-'));
      const context = createTestContext(tmpDir);

      const mockClient = createMockNotionClient('success');
      const writer = createNotionWriter(config, mockClient as any);

      await writer.write(summary, context);

      const createCall = mockClient.pages.create.mock.calls[0][0];
      const blocks = createCall.children;

      const worthClickingIndex = blocks.findIndex(
        (b: any) => b.type === 'heading_2' && b.heading_2.rich_text[0].text.content === 'Worth clicking'
      );
      expect(worthClickingIndex).toBeGreaterThanOrEqual(0);

      // Should have numbered list items
      const firstItem = blocks[worthClickingIndex + 1];
      expect(firstItem.type).toBe('numbered_list_item');

      // First rich text segment should have a link
      const richText = firstItem.numbered_list_item.rich_text;
      expect(richText[0].text.link).toBeDefined();
      expect(richText[0].text.link.url).toContain('https://x.com/');

      await rm(tmpDir, { recursive: true });
    });

    it('should render voices with bold handles', async () => {
      const config: NotionWriterConfig = {
        token: 'secret_test123',
        parentPageId: 'parent-123',
      };

      const summary = createTestSummary();
      const tmpDir = await mkdtemp(join(tmpdir(), 'notion-test-'));
      const context = createTestContext(tmpDir);

      const mockClient = createMockNotionClient('success');
      const writer = createNotionWriter(config, mockClient as any);

      await writer.write(summary, context);

      const createCall = mockClient.pages.create.mock.calls[0][0];
      const blocks = createCall.children;

      const voicesIndex = blocks.findIndex(
        (b: any) => b.type === 'heading_2' && b.heading_2.rich_text[0].text.content === 'Voices'
      );

      const firstVoice = blocks[voicesIndex + 1];
      expect(firstVoice.type).toBe('bulleted_list_item');

      // Handle should be bold
      const richText = firstVoice.bulleted_list_item.rich_text;
      expect(richText[0].annotations.bold).toBe(true);
      expect(richText[0].text.content).toContain('@');

      await rm(tmpDir, { recursive: true });
    });

    it('should include footer with divider and file paths', async () => {
      const config: NotionWriterConfig = {
        token: 'secret_test123',
        parentPageId: 'parent-123',
      };

      const summary = createTestSummary();
      const tmpDir = await mkdtemp(join(tmpdir(), 'notion-test-'));
      const context = createTestContext(tmpDir);

      const mockClient = createMockNotionClient('success');
      const writer = createNotionWriter(config, mockClient as any);

      await writer.write(summary, context);

      const createCall = mockClient.pages.create.mock.calls[0][0];
      const blocks = createCall.children;

      // Find divider
      const dividerIndex = blocks.findIndex((b: any) => b.type === 'divider');
      expect(dividerIndex).toBeGreaterThanOrEqual(0);

      // Next two blocks should be paragraphs with raw.json and summary.json
      const rawPostsBlock = blocks[dividerIndex + 1];
      expect(rawPostsBlock.type).toBe('paragraph');
      expect(rawPostsBlock.paragraph.rich_text[0].text.content).toContain('Raw posts:');

      const summaryJsonBlock = blocks[dividerIndex + 2];
      expect(summaryJsonBlock.type).toBe('paragraph');
      expect(summaryJsonBlock.paragraph.rich_text[0].text.content).toContain('Summary JSON:');

      await rm(tmpDir, { recursive: true });
    });
  });

  describe('NT-008: Writer must never throw', () => {
    it('should return failure receipt instead of throwing', async () => {
      const config: NotionWriterConfig = {
        token: 'secret_test123',
        parentPageId: 'parent-123',
      };

      const summary = createTestSummary();
      const tmpDir = await mkdtemp(join(tmpdir(), 'notion-test-'));
      const context = createTestContext(tmpDir);

      const mockClient = createMockNotionClient('network-error');
      const writer = createNotionWriter(config, mockClient as any);

      // Should not throw
      await expect(writer.write(summary, context)).resolves.toBeDefined();

      const receipt = await writer.write(summary, context);
      expect(receipt.ok).toBe(false);

      await rm(tmpDir, { recursive: true });
    });
  });
});
