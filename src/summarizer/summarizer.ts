import Anthropic from '@anthropic-ai/sdk';
import type { ExtractedPost } from '../types/post.js';

/**
 * Schema version for summary files.
 */
export const SUMMARY_SCHEMA_VERSION = 1;

/**
 * Maximum posts to send to Claude in a single call.
 * 200 is the empirical ceiling for reasonable cost + latency.
 */
export const MAX_POSTS_PER_CALL = 200;

/**
 * Timeout for Claude API call in milliseconds (60 seconds).
 */
export const CLAUDE_TIMEOUT_MS = 60_000;

/**
 * Retry delay for transient failures (2 seconds).
 */
export const RETRY_DELAY_MS = 2_000;

/**
 * Error messages for common failure modes.
 */
const ERROR_NO_API_KEY = 'no_api_key: set config.claude.apiKey or ANTHROPIC_API_KEY';
const ERROR_MALFORMED_RESPONSE = 'malformed_response';
const ERROR_TIMEOUT = 'timeout';
const ERROR_RATE_LIMITED = 'rate_limited';

/**
 * Worth clicking item structure.
 */
export interface WorthClickingItem {
  postId: string;
  url: string;
  author: string; // @handle format
  why: string; // One sentence explaining why
}

/**
 * Voice item structure.
 */
export interface VoiceItem {
  handle: string; // @handle format
  why: string; // Why this handle is worth reading more of
}

/**
 * Noise summary structure.
 */
export interface NoiseSummary {
  count: number;
  examples: string[]; // 0-3 short phrases (not handles)
}

/**
 * Run summary structure (schema version 1).
 */
export interface RunSummary {
  schemaVersion: 1;
  runId: string;
  summarizedAt: string; // ISO 8601 UTC
  model: string; // e.g. "claude-sonnet-4-6"
  themes: string[]; // 3-7 short labels
  worthClicking: WorthClickingItem[]; // 0-10 items
  voices: VoiceItem[]; // 0-5 handles
  noise: NoiseSummary;
  newVsSeen: { newCount: number; seenCount: number };
  feedVerdict: 'signal' | 'mixed' | 'noise';
  trends?: {
    schemaVersion: 1;
    persistent: Array<{
      theme: string;
      runCount: number;
      firstSeenRunId: string;
      lastSeenRunId: string;
    }>;
    emerging: Array<{
      theme: string;
      firstSeenRunId: string;
    }>;
    fading: Array<{
      theme: string;
      lastSeenRunId: string;
      runsSinceLastSeen: number;
    }>;
  };
}

/**
 * Input to the summarizer.
 */
export interface SummarizerInput {
  posts: ExtractedPost[];
  newPostIds: string[]; // IDs of new posts (not in cache)
  priorThemes: string[]; // From rolling-themes store
  interests: string[]; // From config.interests
  runId: string;
  model: string;
  apiKey: string; // From config.claude.apiKey or process.env.ANTHROPIC_API_KEY
}

/**
 * Summarizer result (typed union).
 */
export type SummarizerResult =
  | { status: 'ok'; summary: RunSummary }
  | { status: 'error'; reason: string; rawResponse?: string };

/**
 * Claude tool schema for structured output.
 */
interface ClaudeToolInput {
  themes: string[];
  worthClicking: Array<{
    postId: string;
    url: string;
    author: string;
    why: string;
  }>;
  voices: Array<{
    handle: string;
    why: string;
  }>;
  noise: {
    count: number;
    examples: string[];
  };
  feedVerdict: 'signal' | 'mixed' | 'noise';
}

/**
 * Tool schema definition for Claude API.
 * Extracted as a constant to reduce function complexity.
 */
const RETURN_SUMMARY_TOOL: Anthropic.Tool = {
  name: 'return_summary',
  description: 'Return the structured summary of the feed',
  input_schema: {
    type: 'object',
    properties: {
      themes: {
        type: 'array',
        items: { type: 'string' },
        minItems: 3,
        maxItems: 7,
        description: 'Short theme labels (not sentences)',
      },
      worthClicking: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            postId: { type: 'string' },
            url: { type: 'string' },
            author: { type: 'string', description: '@handle format' },
            why: { type: 'string', description: 'One sentence why this is worth clicking' },
          },
          required: ['postId', 'url', 'author', 'why'],
        },
        maxItems: 10,
      },
      voices: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            handle: { type: 'string', description: '@handle format' },
            why: { type: 'string', description: 'Why this handle is worth reading' },
          },
          required: ['handle', 'why'],
        },
        maxItems: 5,
      },
      noise: {
        type: 'object',
        properties: {
          count: { type: 'number' },
          examples: {
            type: 'array',
            items: { type: 'string' },
            maxItems: 3,
            description: 'Short phrases describing noise patterns',
          },
        },
        required: ['count', 'examples'],
      },
      feedVerdict: {
        type: 'string',
        enum: ['signal', 'mixed', 'noise'],
      },
    },
    required: ['themes', 'worthClicking', 'voices', 'noise', 'feedVerdict'],
  },
};

/**
 * Compact post for Claude payload (strips fields Claude doesn't need).
 */
interface CompactPost {
  id: string;
  url: string;
  author: {
    handle: string;
    displayName: string;
    verified: boolean;
  };
  text: string;
  postedAt: string | null;
  metrics: {
    replies: number | null;
    reposts: number | null;
    likes: number | null;
    views: number | null;
  };
  media: Array<{ type: string; url: string }>;
  isRepost: boolean;
  repostedBy: string | null;
  quoted: CompactPost | null; // One level deep only
}

/**
 * Convert an ExtractedPost to CompactPost format (without handling quoted field).
 */
function toCompactPostBase(post: ExtractedPost): Omit<CompactPost, 'quoted'> {
  return {
    id: post.id,
    url: post.url,
    author: post.author,
    text: post.text,
    postedAt: post.postedAt,
    metrics: post.metrics,
    media: post.media,
    isRepost: post.isRepost,
    repostedBy: post.repostedBy,
  };
}

/**
 * Flatten quoted.quoted chains to one level.
 * Returns a compact post with quoted.quoted set to null.
 */
function flattenQuotedChains(post: ExtractedPost): CompactPost {
  return {
    ...toCompactPostBase(post),
    quoted: post.quoted
      ? {
          ...toCompactPostBase(post.quoted),
          quoted: null, // Strip nested quote
        }
      : null,
  };
}

/**
 * Cap posts at MAX_POSTS_PER_CALL, keeping the most recent by tickIndex.
 */
function capPosts(posts: ExtractedPost[]): { posts: ExtractedPost[]; omittedCount: number } {
  if (posts.length <= MAX_POSTS_PER_CALL) {
    return { posts, omittedCount: 0 };
  }

  // Sort by tickIndex descending (most recent first)
  const sorted = [...posts].sort((a, b) => b.tickIndex - a.tickIndex);

  // Take the first 200
  const capped = sorted.slice(0, MAX_POSTS_PER_CALL);
  const omittedCount = posts.length - MAX_POSTS_PER_CALL;

  return { posts: capped, omittedCount };
}

/**
 * Build the prompt for Claude.
 */
function buildPrompt(input: {
  posts: CompactPost[];
  newPostIds: Set<string>;
  priorThemes: string[];
  interests: string[];
  omittedCount: number;
}): string {
  const { posts, newPostIds, priorThemes, interests, omittedCount } = input;

  const priorThemesText = priorThemes.length > 0
    ? `Prior themes from recent runs (newest last): ${JSON.stringify(priorThemes)}`
    : 'Prior themes: [] (this is the first run, no prior context)';

  const omittedText = omittedCount > 0
    ? `\n\nNote: ${omittedCount} older posts omitted for payload size; summarize from the ${posts.length} provided.`
    : '';

  return `You are a ruthless feed editor. Your job is to tell the operator what matters, not to summarize everything.

Signal over completeness. If the feed is noise, say so. Don't pad worthClicking to 10 on a noisy day.

Operator's interests: ${JSON.stringify(interests)}

${priorThemesText}

New post IDs (not seen before): ${JSON.stringify(Array.from(newPostIds))}

Posts (compact JSON):
${JSON.stringify(posts, null, 2)}${omittedText}

Return a structured summary using the return_summary tool.

Rules:
- themes: 3-7 short labels (e.g., "agent orchestration", not sentences). Use prior themes to identify continuations vs. new topics.
- worthClicking: 0-10 items, ruthlessly curated. Only include posts worth the operator's attention. Each "why" should be one sentence using natural language (not marketing speak like "engagement potential" or "trending").
- voices: 0-5 handles worth reading more of. Favor relevance to interests over raw engagement metrics.
- noise.count: number of posts that are noise (reply-guy politics, vague quotes, crypto shilling, etc.)
- noise.examples: 0-3 short phrases describing noise patterns (not handles, not post IDs)
- feedVerdict: "signal" if most posts are relevant, "noise" if most are noise, "mixed" otherwise`;
}

/**
 * Call Claude API with retry logic and timeout.
 */
async function callClaude(
  client: Anthropic,
  model: string,
  prompt: string,
  signal: AbortSignal
): Promise<{ success: true; data: ClaudeToolInput } | { success: false; reason: string; rawResponse?: string }> {
  try {
    const response = await client.messages.create(
      {
        model,
        max_tokens: 4096,
        tools: [RETURN_SUMMARY_TOOL],
        messages: [{ role: 'user', content: prompt }],
      },
      { signal }
    );

    // Find tool use block
    const toolUse = response.content.find(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use' && block.name === 'return_summary'
    );

    if (!toolUse) {
      const rawResponse = JSON.stringify(response.content);
      return { success: false, reason: ERROR_MALFORMED_RESPONSE, rawResponse };
    }

    return { success: true, data: toolUse.input as ClaudeToolInput };
  } catch (error: any) {
    // Handle different error types
    if (error.name === 'AbortError') {
      return { success: false, reason: ERROR_TIMEOUT };
    }

    if (error.status === 401) {
      return { success: false, reason: 'api_unavailable: 401 unauthorized' };
    }

    if (error.status === 400) {
      return { success: false, reason: 'api_unavailable: 400 bad request', rawResponse: error.message };
    }

    if (error.status === 429) {
      return { success: false, reason: ERROR_RATE_LIMITED };
    }

    if (error.status && error.status >= 500) {
      return { success: false, reason: `api_unavailable: ${error.status}` };
    }

    // Network error or unknown error
    return { success: false, reason: `api_unavailable: ${error.message}` };
  }
}

/**
 * Call Claude with retry logic for transient failures.
 */
async function callClaudeWithRetry(
  client: Anthropic,
  model: string,
  prompt: string,
  signal: AbortSignal
): Promise<{ success: true; data: ClaudeToolInput } | { success: false; reason: string; rawResponse?: string }> {
  // First attempt
  const result = await callClaude(client, model, prompt, signal);

  if (result.success) {
    return result;
  }

  // Check if error is transient (429, 5xx, or network error)
  const isTransient = result.reason === ERROR_RATE_LIMITED || result.reason.includes('api_unavailable');

  if (!isTransient) {
    // Non-transient error (401, 400, malformed_response) - fail immediately
    return result;
  }

  // Wait and retry once
  await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));

  return callClaude(client, model, prompt, signal);
}

/**
 * Summarize a run using Claude.
 *
 * Returns a typed result (never throws on network/parse failures).
 */
export async function summarizeRun(input: SummarizerInput): Promise<SummarizerResult> {
  const { posts, newPostIds, priorThemes, interests, runId, model, apiKey } = input;

  // Check API key
  const effectiveApiKey = apiKey || process.env.ANTHROPIC_API_KEY || '';

  if (!effectiveApiKey) {
    return {
      status: 'error',
      reason: ERROR_NO_API_KEY,
    };
  }

  // Cap posts at 200
  const { posts: cappedPosts, omittedCount } = capPosts(posts);

  // Flatten quoted chains and convert to compact format
  const compactPosts = cappedPosts.map(flattenQuotedChains);

  // Build prompt
  const newPostIdsSet = new Set(newPostIds);
  const prompt = buildPrompt({
    posts: compactPosts,
    newPostIds: newPostIdsSet,
    priorThemes,
    interests,
    omittedCount,
  });

  // Create Anthropic client
  const client = new Anthropic({ apiKey: effectiveApiKey });

  // Set up timeout
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), CLAUDE_TIMEOUT_MS);

  try {
    // Call Claude with retry
    const result = await callClaudeWithRetry(client, model, prompt, abortController.signal);

    if (!result.success) {
      return { status: 'error', reason: result.reason, rawResponse: result.rawResponse };
    }

    // Build RunSummary from Claude's response
    const claudeData = result.data;

    const summary: RunSummary = {
      schemaVersion: SUMMARY_SCHEMA_VERSION,
      runId,
      summarizedAt: new Date().toISOString(),
      model,
      themes: claudeData.themes,
      worthClicking: claudeData.worthClicking,
      voices: claudeData.voices,
      noise: claudeData.noise,
      newVsSeen: {
        newCount: newPostIds.length,
        seenCount: posts.length - newPostIds.length,
      },
      feedVerdict: claudeData.feedVerdict,
    };

    return { status: 'ok', summary };
  } finally {
    clearTimeout(timeoutId);
  }
}
