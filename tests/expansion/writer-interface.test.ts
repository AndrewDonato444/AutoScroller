import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import type { RunSummary } from '../../src/summarizer/summarizer.js';
import type { WriteContext, Writer, WriteReceipt } from '../../src/writer/writer.js';
import { runWriters } from '../../src/writer/writer.js';
import { markdownWriter } from '../../src/writer/markdown.js';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Test ID prefix: WT (Writer Tests)

/**
 * Create a minimal RunSummary for testing.
 */
function createTestSummary(): RunSummary {
  return {
    schemaVersion: 1,
    runId: 'test-run-123',
    summarizedAt: '2026-04-17T09:12:00.000Z',
    model: 'claude-sonnet-4-6',
    themes: ['testing', 'writers', 'interfaces'],
    worthClicking: [
      {
        postId: 'post-1',
        url: 'https://x.com/user/status/1',
        author: '@testuser',
        why: 'Great insight on writer patterns',
      },
    ],
    voices: [
      {
        handle: '@standoutuser',
        why: 'Consistently great takes on architecture',
      },
    ],
    noise: {
      count: 42,
      examples: ['reply-guy politics', 'crypto shilling', 'vague quotes'],
    },
    newVsSeen: { newCount: 10, seenCount: 5 },
    feedVerdict: 'mixed',
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
    displayRawJsonPath: '~/test/raw.json',
    displaySummaryJsonPath: '~/test/summary.json',
  };
}

describe('Writer Interface (WT)', () => {
  describe('WT-001: Writer interface contract', () => {
    it('should have id, write method', () => {
      const writer: Writer = {
        id: 'test',
        write: async () => ({ ok: true, kind: 'file', displayLocation: '/tmp/test.md' }),
      };

      expect(writer.id).toBe('test');
      expect(typeof writer.write).toBe('function');
    });

    it('should never throw from write method', async () => {
      const throwingWriter: Writer = {
        id: 'thrower',
        write: async () => {
          throw new Error('Intentional test error');
        },
      };

      const summary = createTestSummary();
      const tmpDir = await mkdtemp(join(tmpdir(), 'writer-test-'));
      const context = createTestContext(tmpDir);

      // runWriters should catch the error and convert to receipt
      const result = await runWriters({
        writers: [throwingWriter],
        summary,
        context,
      });

      expect(result.receipts[0].receipt.ok).toBe(false);
      expect(result.receipts[0].receipt).toMatchObject({
        ok: false,
        reason: expect.stringContaining('Intentional test error'),
      });

      await rm(tmpDir, { recursive: true });
    });
  });

  describe('WT-002: runWriters orchestrator', () => {
    it('should run writers sequentially in order', async () => {
      const executionOrder: string[] = [];
      const writer1: Writer = {
        id: 'first',
        write: async () => {
          executionOrder.push('first');
          return { ok: true, kind: 'file', displayLocation: '/first' };
        },
      };
      const writer2: Writer = {
        id: 'second',
        write: async () => {
          executionOrder.push('second');
          return { ok: true, kind: 'file', displayLocation: '/second' };
        },
      };

      const summary = createTestSummary();
      const tmpDir = await mkdtemp(join(tmpdir(), 'writer-test-'));
      const context = createTestContext(tmpDir);

      await runWriters({
        writers: [writer1, writer2],
        summary,
        context,
      });

      expect(executionOrder).toEqual(['first', 'second']);

      await rm(tmpDir, { recursive: true });
    });

    it('should return receipts for all writers', async () => {
      const writer1: Writer = {
        id: 'success',
        write: async () => ({ ok: true, kind: 'file', displayLocation: '/success' }),
      };
      const writer2: Writer = {
        id: 'failure',
        write: async () => ({ ok: false, reason: 'test failure' }),
      };

      const summary = createTestSummary();
      const tmpDir = await mkdtemp(join(tmpdir(), 'writer-test-'));
      const context = createTestContext(tmpDir);

      const result = await runWriters({
        writers: [writer1, writer2],
        summary,
        context,
      });

      expect(result.receipts).toHaveLength(2);
      expect(result.receipts[0]).toEqual({
        id: 'success',
        receipt: { ok: true, kind: 'file', displayLocation: '/success' },
      });
      expect(result.receipts[1]).toEqual({
        id: 'failure',
        receipt: { ok: false, reason: 'test failure' },
      });

      await rm(tmpDir, { recursive: true });
    });

    it('should set markdownSucceeded=true when markdown writer succeeds', async () => {
      const writer1: Writer = {
        id: 'markdown',
        write: async () => ({ ok: true, kind: 'file', displayLocation: '/md' }),
      };

      const summary = createTestSummary();
      const tmpDir = await mkdtemp(join(tmpdir(), 'writer-test-'));
      const context = createTestContext(tmpDir);

      const result = await runWriters({
        writers: [writer1],
        summary,
        context,
      });

      expect(result.markdownSucceeded).toBe(true);

      await rm(tmpDir, { recursive: true });
    });

    it('should set markdownSucceeded=false when markdown writer fails', async () => {
      const writer1: Writer = {
        id: 'markdown',
        write: async () => ({ ok: false, reason: 'disk full' }),
      };

      const summary = createTestSummary();
      const tmpDir = await mkdtemp(join(tmpdir(), 'writer-test-'));
      const context = createTestContext(tmpDir);

      const result = await runWriters({
        writers: [writer1],
        summary,
        context,
      });

      expect(result.markdownSucceeded).toBe(false);

      await rm(tmpDir, { recursive: true });
    });

    it('should set anySucceeded=true when at least one writer succeeds', async () => {
      const writer1: Writer = {
        id: 'success',
        write: async () => ({ ok: true, kind: 'file', displayLocation: '/success' }),
      };
      const writer2: Writer = {
        id: 'failure',
        write: async () => ({ ok: false, reason: 'failed' }),
      };

      const summary = createTestSummary();
      const tmpDir = await mkdtemp(join(tmpdir(), 'writer-test-'));
      const context = createTestContext(tmpDir);

      const result = await runWriters({
        writers: [writer1, writer2],
        summary,
        context,
      });

      expect(result.anySucceeded).toBe(true);

      await rm(tmpDir, { recursive: true });
    });

    it('should set anySucceeded=false when all writers fail', async () => {
      const writer1: Writer = {
        id: 'failure1',
        write: async () => ({ ok: false, reason: 'failed 1' }),
      };
      const writer2: Writer = {
        id: 'failure2',
        write: async () => ({ ok: false, reason: 'failed 2' }),
      };

      const summary = createTestSummary();
      const tmpDir = await mkdtemp(join(tmpdir(), 'writer-test-'));
      const context = createTestContext(tmpDir);

      const result = await runWriters({
        writers: [writer1, writer2],
        summary,
        context,
      });

      expect(result.anySucceeded).toBe(false);

      await rm(tmpDir, { recursive: true });
    });

    it('should continue executing writers after one fails', async () => {
      const executionOrder: string[] = [];
      const writer1: Writer = {
        id: 'first',
        write: async () => {
          executionOrder.push('first');
          return { ok: false, reason: 'first failed' };
        },
      };
      const writer2: Writer = {
        id: 'second',
        write: async () => {
          executionOrder.push('second');
          return { ok: true, kind: 'file', displayLocation: '/second' };
        },
      };

      const summary = createTestSummary();
      const tmpDir = await mkdtemp(join(tmpdir(), 'writer-test-'));
      const context = createTestContext(tmpDir);

      await runWriters({
        writers: [writer1, writer2],
        summary,
        context,
      });

      expect(executionOrder).toEqual(['first', 'second']);

      await rm(tmpDir, { recursive: true });
    });
  });

  describe('WT-003: MarkdownWriter conformance', () => {
    it('should export markdownWriter with id="markdown"', () => {
      expect(markdownWriter.id).toBe('markdown');
    });

    it('should write summary.md and return success receipt', async () => {
      const summary = createTestSummary();
      const tmpDir = await mkdtemp(join(tmpdir(), 'writer-test-'));
      const context = createTestContext(tmpDir);

      const receipt = await markdownWriter.write(summary, context);

      expect(receipt.ok).toBe(true);
      if (receipt.ok) {
        expect(receipt.kind).toBe('file');
        expect(receipt.displayLocation).toContain('summary.md');
      }

      // Verify file exists
      const mdPath = join(tmpDir, 'summary.md');
      const content = await readFile(mdPath, 'utf-8');
      expect(content).toContain('ScrollProxy — 2026-04-17 09:12 UTC');
      expect(content).toContain('## Themes');
      expect(content).toContain('## Worth clicking');

      await rm(tmpDir, { recursive: true });
    });

    it('should produce byte-identical output to direct writeSummaryMarkdown call', async () => {
      const { writeSummaryMarkdown } = await import('../../src/writer/markdown.js');
      const summary = createTestSummary();

      // Create two temp dirs
      const tmpDir1 = await mkdtemp(join(tmpdir(), 'writer-test-'));
      const tmpDir2 = await mkdtemp(join(tmpdir(), 'writer-test-'));

      const context1 = createTestContext(tmpDir1);
      const context2 = createTestContext(tmpDir2);

      // Write via markdownWriter
      await markdownWriter.write(summary, context1);

      // Write via direct call
      await writeSummaryMarkdown({
        runDir: tmpDir2,
        summary,
        rawJsonPath: context2.rawJsonPath,
        summaryJsonPath: context2.summaryJsonPath,
        displayRawJsonPath: context2.displayRawJsonPath,
        displaySummaryJsonPath: context2.displaySummaryJsonPath,
      });

      // Compare files
      const content1 = await readFile(join(tmpDir1, 'summary.md'), 'utf-8');
      const content2 = await readFile(join(tmpDir2, 'summary.md'), 'utf-8');

      expect(content1).toBe(content2);

      await rm(tmpDir1, { recursive: true });
      await rm(tmpDir2, { recursive: true });
    });

    it('should return failure receipt when write fails', async () => {
      const summary = createTestSummary();
      // Use invalid path to force failure
      const context: WriteContext = {
        runId: 'test-run-123',
        runDir: '/nonexistent/invalid/path/that/does/not/exist',
        rawJsonPath: '/nonexistent/raw.json',
        summaryJsonPath: '/nonexistent/summary.json',
      };

      const receipt = await markdownWriter.write(summary, context);

      expect(receipt.ok).toBe(false);
      if (!receipt.ok) {
        expect(receipt.reason).toContain('markdown:');
      }
    });
  });

  describe('WT-004: Defensive orchestration', () => {
    it('should catch exceptions from buggy writers and convert to receipts', async () => {
      const buggyWriter: Writer = {
        id: 'buggy',
        write: async () => {
          throw new Error('Uncaught exception');
        },
      };

      const summary = createTestSummary();
      const tmpDir = await mkdtemp(join(tmpdir(), 'writer-test-'));
      const context = createTestContext(tmpDir);

      const result = await runWriters({
        writers: [buggyWriter],
        summary,
        context,
      });

      expect(result.receipts[0].receipt.ok).toBe(false);
      expect(result.receipts[0].receipt).toMatchObject({
        ok: false,
        reason: expect.stringContaining('Uncaught exception'),
      });

      await rm(tmpDir, { recursive: true });
    });

    it('should not rethrow exceptions', async () => {
      const buggyWriter: Writer = {
        id: 'buggy',
        write: async () => {
          throw new Error('Should not propagate');
        },
      };

      const summary = createTestSummary();
      const tmpDir = await mkdtemp(join(tmpdir(), 'writer-test-'));
      const context = createTestContext(tmpDir);

      // Should not throw
      await expect(
        runWriters({
          writers: [buggyWriter],
          summary,
          context,
        })
      ).resolves.toBeDefined();

      await rm(tmpDir, { recursive: true });
    });
  });
});
