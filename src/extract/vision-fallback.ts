import type { ExtractedPost, ExtractionStats } from './extractor.js';
import type Anthropic from '@anthropic-ai/sdk';
import { readdir, readFile, rm } from 'fs/promises';
import { join } from 'path';
import { createHash } from 'crypto';

/**
 * Vision fallback configuration.
 */
export interface VisionFallbackConfig {
  enabled: boolean;
  minPosts: number;
  maxSelectorFailureRatio: number;
  screenshotEveryTicks: number;
  maxScreenshotsPerRun: number;
}

/**
 * Vision statistics tracked during a rescue attempt.
 */
export interface VisionStats {
  screenshotsSent: number;
  screenshotsDropped: number;
  visionPostsExtracted: number;
  visionPostsMerged: number;
  visionDuplicatesSkipped: number;
  apiCalls: number;
  apiErrors: Array<{
    screenshotPath: string;
    errorMessage: string;
    attempt: number;
  }>;
  costEstimateUsd: number;
  triggerReason?: string;
}

/**
 * Result of shouldTrigger check.
 */
export interface TriggerResult {
  triggered: boolean;
  reason?: 'postCountBelowFloor' | 'selectorFailureRatioAboveCeiling';
}

/**
 * Result of rescue operation.
 */
export interface RescueResult {
  posts: ExtractedPost[];
  visionStats: VisionStats;
}

/**
 * Parameters for rescue operation.
 */
export interface RescueParams {
  runId: string;
  screenshotDir: string;
  existingPosts: ExtractedPost[];
  existingStats: ExtractionStats;
  anthropicClient: Anthropic;
}

/**
 * Vision fallback instance.
 */
export interface VisionFallback {
  shouldTrigger: (stats: ExtractionStats, posts: ExtractedPost[]) => TriggerResult;
  rescue: (params: RescueParams) => Promise<RescueResult>;
}

/**
 * Pricing constants for Claude Sonnet 4.6 (as of 2026-04-17).
 * Source: https://www.anthropic.com/pricing
 */
const SONNET_4_6_INPUT_PRICE_PER_MTK = 3.0; // $3 per million input tokens
const SONNET_4_6_OUTPUT_PRICE_PER_MTK = 15.0; // $15 per million output tokens

/**
 * Vision API configuration constants.
 */
const VISION_MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS_PER_REQUEST = 4096;
const IMAGE_MEDIA_TYPE = 'image/png';
const TEXT_CONTENT_TYPE = 'text';

/**
 * TypeScript type definition for ExtractedPost (used in vision prompt).
 */
const EXTRACTED_POST_TYPE_DEF = `interface ExtractedPost {
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
  media: Array<{
    type: 'image' | 'video' | 'gif';
    url: string;
  }>;
  isRepost: boolean;
  repostedBy: string | null;
  quoted: ExtractedPost | null;
  extractedAt: string;
  tickIndex: number;
}`;

/**
 * Calculate content hash for dedup fallback.
 */
function calculateContentHash(handle: string, text: string): string {
  const content = `${handle}|${text}`;
  return createHash('sha256').update(content).digest('hex').substring(0, 16);
}

/**
 * Calculate unique posts with field-level selector failures.
 * A post is counted if it has at least one selector failure.
 */
function calculateFailedPostCount(stats: ExtractionStats): number {
  const failedPostIds = new Set<string>();

  for (const failure of stats.selectorFailures) {
    // Skip article-level failures (not specific to a post)
    if (failure.postIdOrIndex.includes('article')) {
      continue;
    }
    // Skip tick-level failures without a post ID
    if (failure.postIdOrIndex.startsWith('tick-') && !failure.postIdOrIndex.includes('post')) {
      continue;
    }
    failedPostIds.add(failure.postIdOrIndex);
  }

  return failedPostIds.size;
}

/**
 * Check if a post has any null fields that could be filled by vision.
 */
function hasNullFields(post: ExtractedPost): boolean {
  return (
    post.postedAt === null ||
    post.metrics.replies === null ||
    post.metrics.reposts === null ||
    post.metrics.likes === null ||
    post.metrics.views === null
  );
}

/**
 * Merge vision post into DOM post field-wise.
 * Vision fills null fields from DOM, DOM takes precedence for non-null fields.
 * Returns the merged post and a boolean indicating if any fields were actually filled.
 */
function mergePost(domPost: ExtractedPost, visionPost: ExtractedPost): { post: ExtractedPost; merged: boolean } {
  const mergedPost = {
    ...domPost,
    metrics: {
      replies: domPost.metrics.replies ?? visionPost.metrics.replies,
      reposts: domPost.metrics.reposts ?? visionPost.metrics.reposts,
      likes: domPost.metrics.likes ?? visionPost.metrics.likes,
      views: domPost.metrics.views ?? visionPost.metrics.views,
    },
    postedAt: domPost.postedAt ?? visionPost.postedAt,
    media: domPost.media.length > 0 ? domPost.media : visionPost.media,
  };

  // Check if any fields were actually filled
  const merged = hasNullFields(domPost);

  return { post: mergedPost, merged };
}

/**
 * Estimate cost in USD for a vision API call.
 */
function estimateCost(inputTokens: number, outputTokens: number): number {
  const inputCost = (inputTokens / 1_000_000) * SONNET_4_6_INPUT_PRICE_PER_MTK;
  const outputCost = (outputTokens / 1_000_000) * SONNET_4_6_OUTPUT_PRICE_PER_MTK;
  return parseFloat((inputCost + outputCost).toFixed(4));
}

/**
 * Extract screenshot files from a directory and sort by tick index.
 */
async function getScreenshots(screenshotDir: string): Promise<string[]> {
  try {
    const files = await readdir(screenshotDir);
    const screenshots = files
      .filter(f => f.startsWith('tick-') && f.endsWith('.png'))
      .map(f => ({
        path: join(screenshotDir, f),
        tick: parseInt(f.replace('tick-', '').replace('.png', ''), 10),
      }))
      .sort((a, b) => a.tick - b.tick)
      .map(s => s.path);

    return screenshots;
  } catch (error: any) {
    // Directory doesn't exist or can't be read
    return [];
  }
}

/**
 * Build the vision prompt for extracting posts from screenshots.
 */
function buildVisionPrompt(extractedPostTypeDef: string): string {
  return `You are analyzing screenshots from X.com (formerly Twitter) to extract post data.

Your task: Extract all visible posts from the screenshot and return them as a JSON array.

Each post must match this TypeScript type exactly:

\`\`\`typescript
${extractedPostTypeDef}
\`\`\`

Rules:
1. Return a JSON array of posts, one object per visible post
2. Skip promoted posts and ads (look for "Promoted" or "Ad" labels)
3. For fields you cannot read from the screenshot, set them to \`null\` (not omitted, not "0", not empty string)
4. Extract post ID from the permalink URL (e.g., "/status/123456" → id: "123456")
5. If you cannot read the permalink, set id to null
6. Set extractedAt to the current ISO timestamp
7. Set tickIndex to the tick number from the screenshot filename
8. Do not infer or guess data — only extract what is visibly readable
9. Do not recommend posts to click, accounts to follow, or any write actions — only extract structured data

Return ONLY the JSON array, no other text.`;
}

/**
 * Parse vision API response into ExtractedPost[].
 */
function parseVisionResponse(responseText: string): ExtractedPost[] {
  try {
    const parsed = JSON.parse(responseText);
    if (!Array.isArray(parsed)) {
      throw new Error('Response is not an array');
    }
    return parsed as ExtractedPost[];
  } catch (error: any) {
    throw new Error(`Failed to parse vision response: ${error.message}`);
  }
}

/**
 * Process a single screenshot with the vision API.
 */
async function processScreenshot(
  screenshotPath: string,
  prompt: string,
  anthropicClient: Anthropic
): Promise<{
  posts: ExtractedPost[];
  inputTokens: number;
  outputTokens: number;
}> {
  // Read screenshot as base64
  const screenshotBuffer = await readFile(screenshotPath);
  const screenshotBase64 = screenshotBuffer.toString('base64');

  // Call Claude vision API
  const response = await anthropicClient.messages.create({
    model: VISION_MODEL,
    max_tokens: MAX_TOKENS_PER_REQUEST,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: IMAGE_MEDIA_TYPE,
              data: screenshotBase64,
            },
          },
          {
            type: TEXT_CONTENT_TYPE,
            text: prompt,
          },
        ],
      },
    ],
  });

  // Extract token usage
  const inputTokens = response.usage?.input_tokens ?? 0;
  const outputTokens = response.usage?.output_tokens ?? 0;

  // Parse response
  const textContent = response.content.find(c => c.type === TEXT_CONTENT_TYPE);
  if (!textContent || textContent.type !== TEXT_CONTENT_TYPE) {
    throw new Error('No text content in response');
  }

  const posts = parseVisionResponse(textContent.text);

  return { posts, inputTokens, outputTokens };
}

/**
 * Merge vision posts with DOM posts, deduplicating and filling null fields.
 */
function mergeVisionPosts(
  existingPosts: ExtractedPost[],
  visionPosts: ExtractedPost[]
): {
  mergedPosts: ExtractedPost[];
  merged: number;
  duplicatesSkipped: number;
} {
  const mergedPosts = [...existingPosts];
  const domPostsById = new Map(existingPosts.map(p => [p.id, p]));
  const domPostsByHash = new Map(
    existingPosts.map(p => [calculateContentHash(p.author.handle, p.text), p])
  );

  let merged = 0;
  let duplicatesSkipped = 0;

  for (const visionPost of visionPosts) {
    // Try to find by ID first
    const domPost = domPostsById.get(visionPost.id);

    if (domPost) {
      // Same ID found - check if DOM has null fields
      if (hasNullFields(domPost)) {
        // Field-wise merge - vision fills null fields
        const mergeResult = mergePost(domPost, visionPost);
        const index = mergedPosts.findIndex(p => p.id === visionPost.id);
        if (index !== -1) {
          mergedPosts[index] = mergeResult.post;
          if (mergeResult.merged) {
            merged++;
          }
        }
      } else {
        // DOM post is complete - skip vision version as duplicate
        duplicatesSkipped++;
      }
      continue;
    }

    // Try content hash fallback
    const contentHash = calculateContentHash(visionPost.author.handle, visionPost.text);
    const domPostByHash = domPostsByHash.get(contentHash);

    if (domPostByHash) {
      // Same content found - skip as duplicate
      duplicatesSkipped++;
      continue;
    }

    // New post - add to merged list
    mergedPosts.push(visionPost);
    merged++;
  }

  return { mergedPosts, merged, duplicatesSkipped };
}

/**
 * Create a vision fallback instance.
 */
export function createVisionFallback(config: VisionFallbackConfig): VisionFallback {
  function shouldTrigger(stats: ExtractionStats, posts: ExtractedPost[]): TriggerResult {
    // Never trigger if disabled
    if (!config.enabled) {
      return { triggered: false };
    }

    // Never trigger on empty/stalled runs (0 posts AND 0 selector failures)
    if (posts.length === 0 && stats.selectorFailures.length === 0) {
      return { triggered: false };
    }

    // Check post count floor
    if (posts.length < config.minPosts) {
      return { triggered: true, reason: 'postCountBelowFloor' };
    }

    // Check selector failure ratio
    const failedPostCount = calculateFailedPostCount(stats);
    const failureRatio = posts.length > 0 ? failedPostCount / posts.length : 0;

    if (failureRatio > config.maxSelectorFailureRatio) {
      return { triggered: true, reason: 'selectorFailureRatioAboveCeiling' };
    }

    return { triggered: false };
  }

  async function rescue(params: RescueParams): Promise<RescueResult> {
    const { screenshotDir, existingPosts, anthropicClient } = params;

    // Initialize vision stats
    const visionStats: VisionStats = {
      screenshotsSent: 0,
      screenshotsDropped: 0,
      visionPostsExtracted: 0,
      visionPostsMerged: 0,
      visionDuplicatesSkipped: 0,
      apiCalls: 0,
      apiErrors: [],
      costEstimateUsd: 0,
    };

    // Get all screenshots
    const allScreenshots = await getScreenshots(screenshotDir);

    // Enforce screenshot budget
    let screenshots = allScreenshots;
    if (allScreenshots.length > config.maxScreenshotsPerRun) {
      visionStats.screenshotsDropped = allScreenshots.length - config.maxScreenshotsPerRun;
      // Keep newest screenshots (drop oldest)
      screenshots = allScreenshots.slice(-config.maxScreenshotsPerRun);

      // Delete dropped screenshots
      const droppedScreenshots = allScreenshots.slice(0, visionStats.screenshotsDropped);
      await Promise.all(droppedScreenshots.map(path => rm(path, { force: true })));
    }

    visionStats.screenshotsSent = screenshots.length;

    // Build vision prompt with ExtractedPost type definition
    const prompt = buildVisionPrompt(EXTRACTED_POST_TYPE_DEF);

    // Collect vision posts from all screenshots
    const visionPosts: ExtractedPost[] = [];
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    for (let i = 0; i < screenshots.length; i++) {
      const screenshotPath = screenshots[i];

      try {
        const result = await processScreenshot(screenshotPath, prompt, anthropicClient);

        visionStats.apiCalls++;
        totalInputTokens += result.inputTokens;
        totalOutputTokens += result.outputTokens;
        visionStats.visionPostsExtracted += result.posts.length;
        visionPosts.push(...result.posts);

      } catch (error: any) {
        visionStats.apiErrors.push({
          screenshotPath,
          errorMessage: error.message,
          attempt: i + 1,
        });
      }
    }

    // Estimate cost
    visionStats.costEstimateUsd = estimateCost(totalInputTokens, totalOutputTokens);

    // Merge vision posts with DOM posts
    const mergeResult = mergeVisionPosts(existingPosts, visionPosts);
    visionStats.visionPostsMerged = mergeResult.merged;
    visionStats.visionDuplicatesSkipped = mergeResult.duplicatesSkipped;

    return {
      posts: mergeResult.mergedPosts,
      visionStats,
    };
  }

  return {
    shouldTrigger,
    rescue,
  };
}
