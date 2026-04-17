import type { RunSummary } from '../summarizer/summarizer.js';
import { writeFile, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

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
    return '_(no themes — summarizer returned an empty list)_\n';
  }

  return themes.map(theme => `- ${theme}`).join('\n') + '\n';
}

/**
 * Render the worth-clicking section.
 */
function renderWorthClicking(worthClicking: RunSummary['worthClicking']): string {
  if (worthClicking.length === 0) {
    return '_Nothing worth clicking this run._\n';
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
    return '_No standout voices this run._\n';
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
    return 'No noise flagged.\n';
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
  if (summary.schemaVersion !== 1) {
    throw new Error(`markdown_writer: unsupported schemaVersion ${summary.schemaVersion}, expected 1`);
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
  lines.push('## Themes\n');
  lines.push(renderThemes(summary.themes));

  // Worth clicking
  lines.push('## Worth clicking\n');
  lines.push(renderWorthClicking(summary.worthClicking));

  // Voices
  lines.push('## Voices\n');
  lines.push(renderVoices(summary.voices));

  // Noise
  lines.push('## Noise\n');
  lines.push(renderNoise(summary.noise));

  // Footer
  lines.push('---\n');
  lines.push(`Raw posts: \`${rawPath}\`\n`);
  lines.push(`Summary JSON: \`${summaryPath}\`\n`);

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
  const effectiveSummaryJsonPath = summaryJsonPath || join(runDir, 'summary.json');

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
  const summaryMdPath = join(runDir, 'summary.md');
  const tmpPath = join(runDir, 'summary.md.tmp');

  await writeFile(tmpPath, markdown, 'utf-8');

  // Atomic rename
  await rename(tmpPath, summaryMdPath);

  return { summaryMdPath };
}
