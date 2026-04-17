import { Client } from '@notionhq/client';
import type { RunSummary } from '../summarizer/summarizer.js';
import type { Writer, WriteContext, WriteReceipt } from './writer.js';

/**
 * Configuration for NotionWriter.
 */
export interface NotionWriterConfig {
  token: string; // Personal integration token (starts with 'secret_' or 'ntn_')
  parentPageId: string; // UUID of the Notion page that new summary pages live under
  model?: string; // Optional — defaults to summary.model for the page property
}

/**
 * Notion block types used in page creation.
 */
type NotionBlock = any; // Type from @notionhq/client

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
 * Normalize a handle to always start with @.
 */
function normalizeHandle(handle: string): string {
  return handle.startsWith('@') ? handle : `@${handle}`;
}

/**
 * Convert RunSummary to Notion blocks.
 */
function summaryToNotionBlocks(
  summary: RunSummary,
  context: WriteContext
): NotionBlock[] {
  const blocks: NotionBlock[] = [];

  // Themes section
  blocks.push({
    object: 'block',
    type: 'heading_2',
    heading_2: {
      rich_text: [{ type: 'text', text: { content: 'Themes' } }],
    },
  });

  if (summary.themes.length === 0) {
    blocks.push({
      object: 'block',
      type: 'paragraph',
      paragraph: {
        rich_text: [
          {
            type: 'text',
            text: { content: '(no themes — summarizer returned an empty list)' },
            annotations: { italic: true },
          },
        ],
      },
    });
  } else {
    summary.themes.forEach(theme => {
      blocks.push({
        object: 'block',
        type: 'bulleted_list_item',
        bulleted_list_item: {
          rich_text: [{ type: 'text', text: { content: theme } }],
        },
      });
    });
  }

  // Worth clicking section
  blocks.push({
    object: 'block',
    type: 'heading_2',
    heading_2: {
      rich_text: [{ type: 'text', text: { content: 'Worth clicking' } }],
    },
  });

  if (summary.worthClicking.length === 0) {
    blocks.push({
      object: 'block',
      type: 'paragraph',
      paragraph: {
        rich_text: [
          {
            type: 'text',
            text: { content: 'Nothing worth clicking this run.' },
            annotations: { italic: true },
          },
        ],
      },
    });
  } else {
    summary.worthClicking.forEach(item => {
      const author = normalizeHandle(item.author);
      blocks.push({
        object: 'block',
        type: 'numbered_list_item',
        numbered_list_item: {
          rich_text: [
            {
              type: 'text',
              text: { content: author, link: { url: item.url } },
            },
            {
              type: 'text',
              text: { content: ` — ${item.why}` },
            },
          ],
        },
      });
    });
  }

  // Voices section
  blocks.push({
    object: 'block',
    type: 'heading_2',
    heading_2: {
      rich_text: [{ type: 'text', text: { content: 'Voices' } }],
    },
  });

  if (summary.voices.length === 0) {
    blocks.push({
      object: 'block',
      type: 'paragraph',
      paragraph: {
        rich_text: [
          {
            type: 'text',
            text: { content: 'No standout voices this run.' },
            annotations: { italic: true },
          },
        ],
      },
    });
  } else {
    summary.voices.forEach(voice => {
      const handle = normalizeHandle(voice.handle);
      blocks.push({
        object: 'block',
        type: 'bulleted_list_item',
        bulleted_list_item: {
          rich_text: [
            {
              type: 'text',
              text: { content: handle },
              annotations: { bold: true },
            },
            {
              type: 'text',
              text: { content: ` — ${voice.why}` },
            },
          ],
        },
      });
    });
  }

  // Noise section
  blocks.push({
    object: 'block',
    type: 'heading_2',
    heading_2: {
      rich_text: [{ type: 'text', text: { content: 'Noise' } }],
    },
  });

  let noiseText: string;
  if (summary.noise.count === 0) {
    noiseText = 'No noise flagged.';
  } else if (summary.noise.examples.length === 0) {
    noiseText = `${summary.noise.count} posts skimmed as noise.`;
  } else {
    const examples = summary.noise.examples.join(', ');
    noiseText = `${summary.noise.count} posts skimmed as noise — ${examples}.`;
  }

  blocks.push({
    object: 'block',
    type: 'paragraph',
    paragraph: {
      rich_text: [{ type: 'text', text: { content: noiseText } }],
    },
  });

  // Footer
  blocks.push({
    object: 'block',
    type: 'divider',
    divider: {},
  });

  const rawPath = context.displayRawJsonPath || context.rawJsonPath;
  const summaryPath = context.displaySummaryJsonPath || context.summaryJsonPath;

  blocks.push({
    object: 'block',
    type: 'paragraph',
    paragraph: {
      rich_text: [
        { type: 'text', text: { content: 'Raw posts: ' } },
        {
          type: 'text',
          text: { content: rawPath },
          annotations: { code: true },
        },
      ],
    },
  });

  blocks.push({
    object: 'block',
    type: 'paragraph',
    paragraph: {
      rich_text: [
        { type: 'text', text: { content: 'Summary JSON: ' } },
        {
          type: 'text',
          text: { content: summaryPath },
          annotations: { code: true },
        },
      ],
    },
  });

  return blocks;
}

/**
 * Convert Notion page UUID to notion.so URL (removes dashes).
 */
function pageIdToUrl(pageId: string): string {
  const cleanId = pageId.replace(/-/g, '');
  return `https://notion.so/${cleanId}`;
}

/**
 * Sleep for a duration in milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Create a NotionWriter that implements the Writer interface.
 */
export function createNotionWriter(
  config: NotionWriterConfig,
  notionClient?: Client
): Writer {
  // Use provided client for testing, or create real client
  const client =
    notionClient ||
    new Client({
      auth: config.token,
      timeoutMs: 10000, // 10 second timeout
    });

  return {
    id: 'notion',

    async write(summary: RunSummary, context: WriteContext): Promise<WriteReceipt> {
      try {
        // Build page title
        const title = `ScrollProxy — ${formatTimestamp(summary.summarizedAt)}`;

        // Build blocks
        const blocks = summaryToNotionBlocks(summary, context);

        // Attempt page creation with retry logic
        let lastError: any;
        let retryCount = 0;
        const maxRetries = 1;

        while (retryCount <= maxRetries) {
          try {
            const response = await client.pages.create({
              parent: { page_id: config.parentPageId },
              properties: {
                title: [
                  {
                    type: 'text',
                    text: { content: title },
                  },
                ],
              },
              children: blocks,
            } as any);

            // Success - return receipt with URL
            return {
              ok: true,
              kind: 'notion',
              displayLocation: pageIdToUrl(response.id),
            };
          } catch (error: any) {
            lastError = error;

            // Check if this is a transient error worth retrying
            const isTransient =
              error.status === 429 || // Rate limited
              (error.status >= 500 && error.status < 600); // Server error

            if (isTransient && retryCount < maxRetries) {
              // Retry after delay
              const retryAfter =
                error.status === 429 && error.headers?.['retry-after']
                  ? parseInt(error.headers['retry-after'], 10) * 1000
                  : 2000;

              await sleep(retryAfter);
              retryCount++;
              continue;
            }

            // Non-transient error or max retries reached
            break;
          }
        }

        // If we get here, all attempts failed
        const error = lastError;

        // Handle specific error cases
        if (error.status === 401 || error.code === 'unauthorized') {
          return {
            ok: false,
            reason: 'notion_not_authorized: token invalid or revoked',
          };
        }

        if (error.status === 403 || error.code === 'restricted_resource') {
          return {
            ok: false,
            reason: `notion_not_authorized: integration not added to parent page ${config.parentPageId}`,
          };
        }

        if (error.status === 404 || error.code === 'object_not_found') {
          return {
            ok: false,
            reason: `notion_parent_not_found: ${config.parentPageId}`,
          };
        }

        if (error.status === 429 || error.code === 'rate_limited') {
          return {
            ok: false,
            reason: 'notion_rate_limited',
          };
        }

        if (error.status >= 500 && error.status < 600) {
          return {
            ok: false,
            reason: `notion_unavailable: ${error.status}`,
          };
        }

        if (error.message && error.message.toLowerCase().includes('timeout')) {
          return {
            ok: false,
            reason: 'notion_timeout',
          };
        }

        if (
          error.message &&
          (error.message.toLowerCase().includes('network') ||
            error.message.includes('ECONNREFUSED'))
        ) {
          return {
            ok: false,
            reason: `notion: network error: ${error.message}`,
          };
        }

        // Unknown error
        return {
          ok: false,
          reason: `notion: ${error.message || 'unknown error'}`,
        };
      } catch (error: any) {
        // Outer catch - should never reach here if inner try/catch works
        return {
          ok: false,
          reason: `notion: ${error.message || 'unexpected error'}`,
        };
      }
    },
  };
}
