/**
 * Core post + extraction type definitions.
 *
 * These types were previously co-located with the Playwright extractor
 * (`src/extract/extractor.ts`). The Playwright source was retired in
 * April 2026 when the X API Owned Reads migration completed. The types
 * themselves remained — they describe the canonical `ExtractedPost` shape
 * that flows through the source → state → summarizer → writer pipeline,
 * independent of how the post was acquired.
 *
 * `SelectorFailure` is a legacy shape still read by the raw-json writer
 * and the stats envelope. It is no longer produced by any active source
 * (the X API has no DOM selectors to fail). Preserved as an empty-array
 * default to keep the existing stats schema compatible without forcing
 * downstream consumers to branch.
 */

/** Author metadata for a post. */
export interface Author {
  handle: string;
  displayName: string;
  verified: boolean;
}

/** Post metrics (engagement counts). */
export interface Metrics {
  replies: number | null;
  reposts: number | null;
  likes: number | null;
  views: number | null;
}

/** Media item (image, video, or gif). */
export interface MediaItem {
  type: 'image' | 'video' | 'gif';
  url: string;
}

/** A post adapted into the canonical shape the rest of the pipeline consumes. */
export interface ExtractedPost {
  id: string;
  url: string;
  author: Author;
  text: string;
  postedAt: string | null;
  metrics: Metrics;
  media: MediaItem[];
  isRepost: boolean;
  repostedBy: string | null;
  quoted: ExtractedPost | null;
  extractedAt: string;
  tickIndex: number;
  /**
   * Which source lane produced this post (e.g. "ai-frontier", "convergence",
   * "broad", "bookmarks"). Set by the X API adapter; unset on historical
   * Playwright-era posts.
   */
  sourceTag?: string;
}

/**
 * Legacy selector-failure record from the Playwright extractor era.
 * Retained for backward compatibility with the raw.json stats schema;
 * new sources don't populate it.
 */
export interface SelectorFailure {
  field: string;
  postIdOrIndex: string;
  tickIndex: number;
  reason: string;
}
