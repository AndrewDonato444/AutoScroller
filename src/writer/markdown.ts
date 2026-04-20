import type { RunSummary } from '../summarizer/summarizer.js';
import type { Writer, WriteContext, WriteReceipt } from './writer.js';
import { writeFile, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

// Schema version this renderer supports
const SUPPORTED_SCHEMA_VERSION = 1;

// File names
const SUMMARY_MD_FILENAME = 'summary.md';
const SUMMARY_MD_TMP_FILENAME = 'summary.md.tmp';
const SUMMARY_JSON_FILENAME = 'summary.json';

// Section headers
const HEADER_THEMES = '## Themes';
const HEADER_TRENDS = '## Trends';
const HEADER_WORTH_CLICKING = '## Worth clicking';
const HEADER_VOICES = '## Voices';
const HEADER_NOISE = '## Noise';

// Footer labels
const FOOTER_RAW_POSTS = 'Raw posts:';
const FOOTER_SUMMARY_JSON = 'Summary JSON:';

// Placeholder messages
const PLACEHOLDER_NO_THEMES = '_(no themes — summarizer returned an empty list)_';
const PLACEHOLDER_NOTHING_WORTH_CLICKING = '_Nothing worth clicking this run._';
const PLACEHOLDER_NO_VOICES = '_No standout voices this run._';
const PLACEHOLDER_NO_NOISE = 'No noise flagged.';

/**
 * Context for rendering markdown (paths to reference in footer).
 */
export interface MarkdownContext {
  rawJsonPath: string; // Absolute path to raw.json
  summaryJsonPath: string; // Absolute path to summary.json
  displayRawJsonPath?: string; // ~-compressed path for display
  displaySummaryJsonPath?: string; // ~-compressed path for display
}

/**
 * Normalize a handle to always start with @.
 */
function normalizeHandle(handle: string): string {
  return handle.startsWith('@') ? handle : `@${handle}`;
}

/**
 * Format a timestamp from ISO 8601 to "YYYY-MM-DD HH:MM UTC".
 */
function formatTimestamp(isoString: string): string {
  const date = new Date(isoString);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const hours = String(date.getUTCHours()).padStart(2, '0');
  const minutes = String(date.getUTCMinutes()).padStart(2, '0');

  return `${year}-${month}-${day} ${hours}:${minutes} UTC`;
}

/**
 * Render the themes section.
 */
function renderThemes(themes: string[]): string {
  if (themes.length === 0) {
    return `${PLACEHOLDER_NO_THEMES}\n`;
  }

  return themes.map(theme => `- ${theme}`).join('\n') + '\n';
}

/**
 * Render the trends section.
 * Returns null if trends are undefined or all categories are empty.
 */
function renderTrends(trends: RunSummary['trends']): string | null {
  // Omit section if trends undefined or all categories empty
  if (
    !trends ||
    (trends.persistent.length === 0 && trends.emerging.length === 0 && trends.fading.length === 0)
  ) {
    return null;
  }

  const lines: string[] = [];

  // Calculate window size from max runCount among persistent themes
  // If no persistent themes, we can't reliably show the denominator
  const windowSize = trends.persistent.length > 0
    ? Math.max(...trends.persistent.map(t => t.runCount))
    : 0;

  // Persistent subsection
  if (trends.persistent.length > 0) {
    lines.push('### Persistent\n');
    trends.persistent.forEach(item => {
      lines.push(`- ${item.theme} — ${item.runCount}/${windowSize} runs\n`);
    });
    lines.push('');
  }

  // Emerging subsection
  if (trends.emerging.length > 0) {
    lines.push('### Emerging\n');
    trends.emerging.forEach(item => {
      lines.push(`- ${item.theme} — first seen ${item.firstSeenRunId}\n`);
    });
    lines.push('');
  }

  // Fading subsection
  if (trends.fading.length > 0) {
    lines.push('### Fading\n');
    trends.fading.forEach(item => {
      const runsText = item.runsSinceLastSeen === 1 ? 'run' : 'runs';
      lines.push(`- ${item.theme} — last seen ${item.lastSeenRunId}, ${item.runsSinceLastSeen} ${runsText} ago\n`);
    });
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Render the worth-clicking section.
 */
function renderWorthClicking(worthClicking: RunSummary['worthClicking']): string {
  if (worthClicking.length === 0) {
    return `${PLACEHOLDER_NOTHING_WORTH_CLICKING}\n`;
  }

  return worthClicking
    .map((item, index) => {
      const author = normalizeHandle(item.author);
      return `${index + 1}. [${author}](${item.url}) — ${item.why}`;
    })
    .join('\n') + '\n';
}

/**
 * Render the voices section.
 */
function renderVoices(voices: RunSummary['voices']): string {
  if (voices.length === 0) {
    return `${PLACEHOLDER_NO_VOICES}\n`;
  }

  return voices
    .map(voice => {
      const handle = normalizeHandle(voice.handle);
      return `- **${handle}** — ${voice.why}`;
    })
    .join('\n') + '\n';
}

/**
 * Render the noise section.
 */
function renderNoise(noise: RunSummary['noise']): string {
  if (noise.count === 0) {
    return `${PLACEHOLDER_NO_NOISE}\n`;
  }

  if (noise.examples.length === 0) {
    return `${noise.count} posts skimmed as noise.\n`;
  }

  const examples = noise.examples.join(', ');
  return `${noise.count} posts skimmed as noise — ${examples}.\n`;
}


/**
 * Render a summary to markdown.
 * Pure function — no I/O, no Date.now(), no env reads.
 */
export function renderSummaryMarkdown(summary: RunSummary, context: MarkdownContext): string {
  // Validate schemaVersion
  if (summary.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    throw new Error(`markdown_writer: unsupported schemaVersion ${summary.schemaVersion}, expected ${SUPPORTED_SCHEMA_VERSION}`);
  }

  // Format header timestamp
  const timestamp = formatTimestamp(summary.summarizedAt);

  // Determine footer paths (prefer display variants)
  const rawPath = context.displayRawJsonPath || context.rawJsonPath;
  const summaryPath = context.displaySummaryJsonPath || context.summaryJsonPath;

  // Build sections
  const lines: string[] = [];

  // Header
  lines.push(`# ScrollProxy — ${timestamp}\n`);
  lines.push(
    `**Verdict**: ${summary.feedVerdict} · **New**: ${summary.newVsSeen.newCount} · **Seen**: ${summary.newVsSeen.seenCount} · **Model**: ${summary.model}\n`
  );

  // Themes
  lines.push(`${HEADER_THEMES}\n`);
  lines.push(renderThemes(summary.themes));

  // Trends (optional, rendered between Themes and Worth clicking)
  const trendsContent = renderTrends(summary.trends);
  if (trendsContent) {
    lines.push(`${HEADER_TRENDS}\n`);
    lines.push(trendsContent);
  }

  // Worth clicking
  lines.push(`${HEADER_WORTH_CLICKING}\n`);
  lines.push(renderWorthClicking(summary.worthClicking));

  // Voices
  lines.push(`${HEADER_VOICES}\n`);
  lines.push(renderVoices(summary.voices));

  // Noise
  lines.push(`${HEADER_NOISE}\n`);
  lines.push(renderNoise(summary.noise));

  // Footer
  lines.push('---\n');
  lines.push(`${FOOTER_RAW_POSTS} \`${rawPath}\`\n`);
  lines.push(`${FOOTER_SUMMARY_JSON} \`${summaryPath}\`\n`);

  return lines.join('\n');
}

/**
 * Write summary.md atomically to the run directory.
 */
export async function writeSummaryMarkdown(params: {
  runDir: string;
  summary: RunSummary;
  rawJsonPath: string;
  summaryJsonPath?: string;
  displayRawJsonPath?: string;
  displaySummaryJsonPath?: string;
}): Promise<{ summaryMdPath: string }> {
  const { runDir, summary, rawJsonPath, summaryJsonPath, displayRawJsonPath, displaySummaryJsonPath } = params;

  // Default summaryJsonPath if not provided
  const effectiveSummaryJsonPath = summaryJsonPath || join(runDir, SUMMARY_JSON_FILENAME);

  // Build markdown context
  const context: MarkdownContext = {
    rawJsonPath,
    summaryJsonPath: effectiveSummaryJsonPath,
    displayRawJsonPath,
    displaySummaryJsonPath,
  };

  // Render markdown
  const markdown = renderSummaryMarkdown(summary, context);

  // Ensure run directory exists
  await mkdir(runDir, { recursive: true });

  // Write to tmpfile
  const summaryMdPath = join(runDir, SUMMARY_MD_FILENAME);
  const tmpPath = join(runDir, SUMMARY_MD_TMP_FILENAME);

  await writeFile(tmpPath, markdown, 'utf-8');

  // Atomic rename
  await rename(tmpPath, summaryMdPath);

  return { summaryMdPath };
}

/**
 * MarkdownWriter implementation of the Writer interface.
 */
export const markdownWriter: Writer = {
  id: 'markdown',

  async write(summary: RunSummary, context: WriteContext): Promise<WriteReceipt> {
    try {
      const { summaryMdPath } = await writeSummaryMarkdown({
        runDir: context.runDir,
        summary,
        rawJsonPath: context.rawJsonPath,
        summaryJsonPath: context.summaryJsonPath,
        displayRawJsonPath: context.displayRawJsonPath,
        displaySummaryJsonPath: context.displaySummaryJsonPath,
      });

      const displayPath = context.displayRawJsonPath
        ? summaryMdPath.replace(context.runDir, context.displayRawJsonPath.replace('/raw.json', ''))
        : summaryMdPath;

      return {
        ok: true,
        kind: 'file',
        displayLocation: displayPath,
      };
    } catch (error: any) {
      return {
        ok: false,
        reason: `markdown: ${error.message}`,
      };
    }
  },
};
