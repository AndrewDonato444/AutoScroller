import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderSummaryMarkdown, writeSummaryMarkdown, type MarkdownContext } from '../../src/writer/markdown.js';
import type { RunSummary } from '../../src/summarizer/summarizer.js';
import { existsSync, mkdirSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('Markdown Writer', () => {
  let testRunDir: string;

  beforeEach(() => {
    // Create a unique temp directory for each test
    testRunDir = join(tmpdir(), `markdown-writer-test-${Date.now()}`);
    mkdirSync(testRunDir, { recursive: true });
  });

  afterEach(() => {
    // Clean up test directory
    if (existsSync(testRunDir)) {
      rmSync(testRunDir, { recursive: true, force: true });
    }
  });

  // Helper to create a minimal RunSummary
  function makeSummary(overrides: Partial<RunSummary> = {}): RunSummary {
    return {
      schemaVersion: 1,
      runId: '2026-04-17T09-02-14Z',
      summarizedAt: '2026-04-17T09:12:48.000Z',
      model: 'claude-sonnet-4-6',
      themes: ['agent orchestration patterns', 'indie-dev distribution', 'sales enablement tooling'],
      worthClicking: [],
      voices: [],
      noise: { count: 0, examples: [] },
      newVsSeen: { newCount: 38, seenCount: 46 },
      feedVerdict: 'mixed',
      ...overrides,
    };
  }

  // Helper to create markdown context
  function makeContext(overrides: Partial<MarkdownContext> = {}): MarkdownContext {
    const runId = '2026-04-17T09-02-14Z';
    return {
      rawJsonPath: `/Users/andrew/scrollproxy/runs/${runId}/raw.json`,
      summaryJsonPath: `/Users/andrew/scrollproxy/runs/${runId}/summary.json`,
      displayRawJsonPath: `~/scrollproxy/runs/${runId}/raw.json`,
      displaySummaryJsonPath: `~/scrollproxy/runs/${runId}/summary.json`,
      ...overrides,
    };
  }

  describe('UT-MD-001: Happy-path render — summary.md is written next to raw.json and summary.json', () => {
    it('writes summary.md with all sections in the correct order', async () => {
      const summary = makeSummary({
        feedVerdict: 'mixed',
        themes: ['agent orchestration patterns', 'indie-dev distribution', 'sales enablement tooling', 'distributed training tricks', 'sports-betting odds math'],
        worthClicking: [
          {
            postId: '1780123456789012345',
            url: 'https://x.com/someone/status/1780123456789012345',
            author: '@someone',
            why: 'Concrete pattern for state sharing between agents — worth reading, not just bookmarking.',
          },
          {
            postId: '1780123456789099999',
            url: 'https://x.com/devgrinder/status/1780123456789099999',
            author: '@devgrinder',
            why: 'Teardown of a mid-market GTM motion that actually shipped revenue.',
          },
          {
            postId: '1780123456789022222',
            url: 'https://x.com/oddsnerd/status/1780123456789022222',
            author: '@oddsnerd',
            why: 'Clean derivation of a closing-line value edge the operator has been chasing.',
          },
        ],
        voices: [
          { handle: '@smalleraccount', why: 'Three deep cuts on AI product strategy this run — keep reading.' },
          { handle: '@pragmabuilder', why: 'Consistent signal on distribution tactics for one-person shops.' },
        ],
        noise: { count: 42, examples: ['reply-guy politics', 'crypto shilling', 'vague motivational quotes'] },
      });

      const rawJsonPath = join(testRunDir, 'raw.json');
      const summaryJsonPath = join(testRunDir, 'summary.json');

      const result = await writeSummaryMarkdown({
        runDir: testRunDir,
        summary,
        rawJsonPath,
        summaryJsonPath,
      });

      expect(result.summaryMdPath).toBe(join(testRunDir, 'summary.md'));
      expect(existsSync(result.summaryMdPath)).toBe(true);

      const content = readFileSync(result.summaryMdPath, 'utf-8');

      // Check header
      expect(content).toContain('# ScrollProxy — 2026-04-17 09:12 UTC');
      expect(content).toContain('**Verdict**: mixed · **New**: 38 · **Seen**: 46 · **Model**: claude-sonnet-4-6');

      // Check sections appear in order
      expect(content).toContain('## Themes');
      expect(content).toContain('## Worth clicking');
      expect(content).toContain('## Voices');
      expect(content).toContain('## Noise');

      // Check themes
      expect(content).toContain('- agent orchestration patterns');
      expect(content).toContain('- indie-dev distribution');

      // Check worth clicking
      expect(content).toContain('1. [@someone](https://x.com/someone/status/1780123456789012345) — Concrete pattern for state sharing between agents — worth reading, not just bookmarking.');

      // Check voices
      expect(content).toContain('- **@smalleraccount** — Three deep cuts on AI product strategy this run — keep reading.');

      // Check noise
      expect(content).toContain('42 posts skimmed as noise — reply-guy politics, crypto shilling, vague motivational quotes.');

      // Check footer
      expect(content).toContain('---');
      expect(content).toContain('Raw posts:');
      expect(content).toContain('Summary JSON:');
    });
  });

  describe('UT-MD-002: Worth-clicking entries render with author, real link, and one-sentence why', () => {
    it('renders worth-clicking with correct markdown link format and verbatim why', () => {
      const summary = makeSummary({
        worthClicking: [
          {
            postId: '1780123456789012345',
            url: 'https://x.com/someone/status/1780123456789012345',
            author: '@someone',
            why: 'Concrete pattern for state sharing between agents — worth reading, not just bookmarking.',
          },
        ],
      });

      const context = makeContext();
      const markdown = renderSummaryMarkdown(summary, context);

      // Should render as a numbered list with markdown link
      expect(markdown).toContain('1. [@someone](https://x.com/someone/status/1780123456789012345) — Concrete pattern for state sharing between agents — worth reading, not just bookmarking.');

      // Should NOT contain metadata fields
      expect(markdown).not.toContain('postId');
      expect(markdown).not.toContain('engagement');
      expect(markdown).not.toContain('trending');
      expect(markdown).not.toContain('recommended');

      // Link text should be the author, not the URL
      expect(markdown).toMatch(/\[@someone\]\(https:\/\/x\.com\/someone\/status\/1780123456789012345\)/);
    });
  });

  describe('UT-MD-003: Author handle without @ prefix is normalized', () => {
    it('prepends @ to author handles that lack it', () => {
      const summary = makeSummary({
        worthClicking: [
          {
            postId: '1',
            url: 'https://x.com/someone/status/1',
            author: 'someone', // No @ prefix
            why: 'Test',
          },
        ],
        voices: [
          { handle: 'someoneelse', why: 'Test' }, // No @ prefix
          { handle: '@alreadyhas', why: 'Test' }, // Has @ prefix
        ],
      });

      const context = makeContext();
      const markdown = renderSummaryMarkdown(summary, context);

      // Should add @ exactly once
      expect(markdown).toContain('[@someone](');
      expect(markdown).not.toContain('[[@@someone]');

      // Voices should also be normalized
      expect(markdown).toContain('**@someoneelse**');
      expect(markdown).toContain('**@alreadyhas**');
      expect(markdown).not.toContain('**@@alreadyhas**');
    });
  });

  describe('UT-MD-004: Empty worth-clicking and empty voices render terse placeholders', () => {
    it('renders placeholders for empty sections without omitting headings', () => {
      const summary = makeSummary({
        worthClicking: [],
        voices: [],
      });

      const context = makeContext();
      const markdown = renderSummaryMarkdown(summary, context);

      // Headings should still exist
      expect(markdown).toContain('## Worth clicking');
      expect(markdown).toContain('## Voices');

      // Should have placeholders
      expect(markdown).toContain('_Nothing worth clicking this run._');
      expect(markdown).toContain('_No standout voices this run._');

      // Section order should be stable
      const themesIndex = markdown.indexOf('## Themes');
      const worthClickingIndex = markdown.indexOf('## Worth clicking');
      const voicesIndex = markdown.indexOf('## Voices');
      const noiseIndex = markdown.indexOf('## Noise');

      expect(themesIndex).toBeLessThan(worthClickingIndex);
      expect(worthClickingIndex).toBeLessThan(voicesIndex);
      expect(voicesIndex).toBeLessThan(noiseIndex);
    });
  });

  describe('UT-MD-005: Noise section reads like a human sentence', () => {
    it('renders noise with examples joined by comma-space', () => {
      const summary = makeSummary({
        noise: { count: 42, examples: ['reply-guy politics', 'crypto shilling', 'vague motivational quotes'] },
      });

      const context = makeContext();
      const markdown = renderSummaryMarkdown(summary, context);

      expect(markdown).toContain('42 posts skimmed as noise — reply-guy politics, crypto shilling, vague motivational quotes.');
    });

    it('renders noise without examples when examples array is empty', () => {
      const summary = makeSummary({
        noise: { count: 7, examples: [] },
      });

      const context = makeContext();
      const markdown = renderSummaryMarkdown(summary, context);

      // Extract the noise section
      const noiseMatch = markdown.match(/## Noise\n\n(.*?)\n\n/s);
      expect(noiseMatch).not.toBeNull();
      const noiseSection = noiseMatch![1];

      expect(noiseSection).toBe('7 posts skimmed as noise.');
    });

    it('renders success state when noise count is zero', () => {
      const summary = makeSummary({
        noise: { count: 0, examples: [] },
      });

      const context = makeContext();
      const markdown = renderSummaryMarkdown(summary, context);

      expect(markdown).toContain('No noise flagged.');
      expect(markdown).not.toContain('_No noise flagged._'); // No italics for success state
    });
  });

  describe('UT-MD-006: Header timestamp is derived from summarizedAt in UTC', () => {
    it('formats timestamp as UTC regardless of local timezone', () => {
      const summary = makeSummary({
        summarizedAt: '2026-04-17T09:12:48.000Z',
      });

      const context = makeContext();
      const markdown = renderSummaryMarkdown(summary, context);

      expect(markdown).toContain('# ScrollProxy — 2026-04-17 09:12 UTC');
      expect(markdown).not.toContain('PST');
      expect(markdown).not.toContain('PDT');
      expect(markdown).not.toContain('-07:00');
    });
  });

  describe('UT-MD-007: Footer uses ~-compressed paths when display variants are provided', () => {
    it('uses display paths when provided', () => {
      const summary = makeSummary();
      const context = makeContext({
        rawJsonPath: '/Users/andrew/scrollproxy/runs/2026-04-17T09-02-14Z/raw.json',
        displayRawJsonPath: '~/scrollproxy/runs/2026-04-17T09-02-14Z/raw.json',
        summaryJsonPath: '/Users/andrew/scrollproxy/runs/2026-04-17T09-02-14Z/summary.json',
        displaySummaryJsonPath: '~/scrollproxy/runs/2026-04-17T09-02-14Z/summary.json',
      });

      const markdown = renderSummaryMarkdown(summary, context);

      expect(markdown).toContain('Raw posts: `~/scrollproxy/runs/2026-04-17T09-02-14Z/raw.json`');
      expect(markdown).toContain('Summary JSON: `~/scrollproxy/runs/2026-04-17T09-02-14Z/summary.json`');
    });

    it('falls back to absolute paths when display variants are absent', () => {
      const summary = makeSummary();
      const context: MarkdownContext = {
        rawJsonPath: '/Users/andrew/scrollproxy/runs/2026-04-17T09-02-14Z/raw.json',
        summaryJsonPath: '/Users/andrew/scrollproxy/runs/2026-04-17T09-02-14Z/summary.json',
      };

      const markdown = renderSummaryMarkdown(summary, context);

      expect(markdown).toContain('Raw posts: `/Users/andrew/scrollproxy/runs/2026-04-17T09-02-14Z/raw.json`');
      expect(markdown).toContain('Summary JSON: `/Users/andrew/scrollproxy/runs/2026-04-17T09-02-14Z/summary.json`');
    });
  });

  describe('UT-MD-008: Atomic write — crash mid-write never leaves corrupt summary.md', () => {
    it('writes to tmpfile first then renames atomically', async () => {
      const summary = makeSummary();
      const rawJsonPath = join(testRunDir, 'raw.json');
      const summaryJsonPath = join(testRunDir, 'summary.json');

      await writeSummaryMarkdown({
        runDir: testRunDir,
        summary,
        rawJsonPath,
        summaryJsonPath,
      });

      // The tmpfile should not exist after successful write
      expect(existsSync(join(testRunDir, 'summary.md.tmp'))).toBe(false);

      // The final file should exist
      expect(existsSync(join(testRunDir, 'summary.md'))).toBe(true);
    });
  });

  describe('UT-MD-009: Unknown schemaVersion throws clear error', () => {
    it('throws error for unsupported schemaVersion', () => {
      const summary = makeSummary({
        schemaVersion: 2 as any, // Future version
      });

      const context = makeContext();

      expect(() => renderSummaryMarkdown(summary, context)).toThrow(
        'markdown_writer: unsupported schemaVersion 2, expected 1'
      );
    });
  });

  describe('UT-MD-010: Output is deterministic — same summary.json renders byte-identical summary.md', () => {
    it('produces identical output for identical inputs', () => {
      const summary = makeSummary({
        worthClicking: [
          {
            postId: '1',
            url: 'https://x.com/someone/status/1',
            author: '@someone',
            why: 'Test',
          },
        ],
      });

      const context = makeContext();

      const markdown1 = renderSummaryMarkdown(summary, context);
      const markdown2 = renderSummaryMarkdown(summary, context);

      expect(markdown1).toBe(markdown2);

      // Check that output doesn't contain non-deterministic elements
      expect(markdown1).not.toMatch(/\d{13}/); // No timestamps in ms
      expect(markdown1).not.toContain(process.env.USER || '');
    });
  });

  describe('UT-MD-011: Empty themes renders placeholder', () => {
    it('handles empty themes array defensively', () => {
      const summary = makeSummary({
        themes: [], // Not allowed by schema but should be render-safe
      });

      const context = makeContext();
      const markdown = renderSummaryMarkdown(summary, context);

      expect(markdown).toContain('_(no themes — summarizer returned an empty list)_');
    });
  });

  describe('UT-MD-012: File ends with single trailing newline', () => {
    it('writes file with single trailing newline', async () => {
      const summary = makeSummary();
      const rawJsonPath = join(testRunDir, 'raw.json');
      const summaryJsonPath = join(testRunDir, 'summary.json');

      const result = await writeSummaryMarkdown({
        runDir: testRunDir,
        summary,
        rawJsonPath,
        summaryJsonPath,
      });

      const content = readFileSync(result.summaryMdPath, 'utf-8');

      // Should end with exactly one newline
      expect(content.endsWith('\n')).toBe(true);
      expect(content.endsWith('\n\n')).toBe(false);
    });
  });

  describe('UT-MD-013: summaryJsonPath defaults to <runDir>/summary.json when omitted', () => {
    it('uses default summaryJsonPath when not provided', async () => {
      const summary = makeSummary();
      const rawJsonPath = join(testRunDir, 'raw.json');

      const result = await writeSummaryMarkdown({
        runDir: testRunDir,
        summary,
        rawJsonPath,
        // summaryJsonPath omitted
      });

      const content = readFileSync(result.summaryMdPath, 'utf-8');

      // Should use default path in footer
      expect(content).toContain('Summary JSON:');
    });
  });

  describe('UT-MD-014: Multiple worth-clicking entries render as numbered list', () => {
    it('renders multiple worth-clicking items with sequential numbers', () => {
      const summary = makeSummary({
        worthClicking: [
          {
            postId: '1',
            url: 'https://x.com/author1/status/1',
            author: '@author1',
            why: 'First post',
          },
          {
            postId: '2',
            url: 'https://x.com/author2/status/2',
            author: '@author2',
            why: 'Second post',
          },
          {
            postId: '3',
            url: 'https://x.com/author3/status/3',
            author: '@author3',
            why: 'Third post',
          },
        ],
      });

      const context = makeContext();
      const markdown = renderSummaryMarkdown(summary, context);

      expect(markdown).toContain('1. [@author1](https://x.com/author1/status/1) — First post');
      expect(markdown).toContain('2. [@author2](https://x.com/author2/status/2) — Second post');
      expect(markdown).toContain('3. [@author3](https://x.com/author3/status/3) — Third post');
    });
  });

  describe('UT-MD-015: Voices render with bold handle', () => {
    it('renders voices with bold handle and why', () => {
      const summary = makeSummary({
        voices: [
          { handle: '@handle1', why: 'Reason 1' },
          { handle: '@handle2', why: 'Reason 2' },
        ],
      });

      const context = makeContext();
      const markdown = renderSummaryMarkdown(summary, context);

      expect(markdown).toContain('- **@handle1** — Reason 1');
      expect(markdown).toContain('- **@handle2** — Reason 2');
    });
  });

  describe('UT-MD-016: All themes render as bulleted list', () => {
    it('renders all themes as bullet points', () => {
      const summary = makeSummary({
        themes: ['theme 1', 'theme 2', 'theme 3', 'theme 4', 'theme 5'],
      });

      const context = makeContext();
      const markdown = renderSummaryMarkdown(summary, context);

      expect(markdown).toContain('- theme 1');
      expect(markdown).toContain('- theme 2');
      expect(markdown).toContain('- theme 3');
      expect(markdown).toContain('- theme 4');
      expect(markdown).toContain('- theme 5');
    });
  });
});
