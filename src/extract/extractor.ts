import type { Page } from 'playwright';

/**
 * Selector constants - single place to patch when X changes the DOM.
 */
export const POST_SELECTOR = 'article[data-testid="tweet"]';
export const AD_MARKER_SELECTORS = [
  '[data-testid="placementTracking"]',
  '[data-testid*="promoted"]',
];
export const AD_LABEL_TEXTS = ['Ad', 'Promoted'];
export const PERMALINK_SELECTOR = 'a[href*="/status/"]';
export const USER_NAME_SELECTOR = '[data-testid="User-Name"]';
export const TWEET_TEXT_SELECTOR = '[data-testid="tweetText"]';
export const TIME_SELECTOR = 'time[datetime]';
export const VERIFIED_ICON_SELECTOR = '[data-testid="icon-verified"]';
export const MEDIA_IMAGE_SELECTOR = 'img[src*="pbs.twimg.com"]';
export const MEDIA_VIDEO_SELECTOR = 'video';

/**
 * Author metadata for a post.
 */
export interface Author {
  handle: string;
  displayName: string;
  verified: boolean;
}

/**
 * Post metrics (engagement counts).
 */
export interface Metrics {
  replies: number | null;
  reposts: number | null;
  likes: number | null;
  views: number | null;
}

/**
 * Media item (image, video, or gif).
 */
export interface MediaItem {
  type: 'image' | 'video' | 'gif';
  url: string;
}

/**
 * Extracted post data structure.
 */
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
}

/**
 * Selector failure record.
 */
export interface SelectorFailure {
  field: string;
  postIdOrIndex: string;
  tickIndex: number;
  reason: string;
}

/**
 * Extraction statistics.
 */
export interface ExtractionStats {
  postsExtracted: number;
  adsSkipped: number;
  selectorFailures: SelectorFailure[];
  duplicateHits: number;
}

/**
 * Context passed to the tick hook.
 */
export interface TickHookContext {
  page: Page;
  tickIndex: number;
  elapsedMs: number;
}

/**
 * Extractor instance API.
 */
export interface Extractor {
  onTick: (ctx: TickHookContext) => Promise<void>;
  getPosts: () => ExtractedPost[];
  getStats: () => ExtractionStats;
}

/**
 * Parse a metric string like "1.2k" or "3.4M" into a number.
 * Returns null if unparseable.
 */
function parseMetric(text: string | null | undefined): number | null {
  if (!text) return null;

  const trimmed = text.trim();
  const match = trimmed.match(/^([\d.]+)\s*([kKmM])?/);

  if (!match) return null;

  const num = parseFloat(match[1]);
  const suffix = match[2]?.toLowerCase();

  if (isNaN(num)) return null;

  if (suffix === 'k') return Math.round(num * 1000);
  if (suffix === 'm') return Math.round(num * 1000000);

  return Math.round(num);
}

/**
 * Extract post ID from permalink URL.
 * Returns null if not found.
 */
function extractPostId(url: string | null | undefined): string | null {
  if (!url) return null;

  const match = url.match(/\/status\/(\d+)/);
  return match ? match[1] : null;
}

/**
 * Check if an article is an ad/promoted post.
 */
async function isAd(article: any, page: Page): Promise<boolean> {
  try {
    const result = await page.evaluate(
      ({ article, adMarkers, adLabels }) => {
        // Check for ad marker elements
        for (const selector of adMarkers) {
          if (article.querySelector(selector)) {
            return true;
          }
        }

        // Check for ad label text
        const textContent = article.textContent || '';
        for (const label of adLabels) {
          if (textContent.includes(label)) {
            return true;
          }
        }

        return false;
      },
      { article, adMarkers: AD_MARKER_SELECTORS, adLabels: AD_LABEL_TEXTS }
    );

    return result;
  } catch {
    return false;
  }
}

/**
 * Extract author information from an article.
 */
async function extractAuthor(
  article: any,
  page: Page,
  tickIndex: number,
  postId: string,
  failures: SelectorFailure[]
): Promise<Author> {
  try {
    const result = await page.evaluate(
      ({ article, userNameSelector, verifiedSelector }) => {
        const userNameDiv = article.querySelector(userNameSelector);
        if (!userNameDiv) {
          return { handle: null, displayName: null, verified: false };
        }

        const spans = userNameDiv.querySelectorAll('span');
        let displayName = '';
        let handle = '';

        for (const span of spans) {
          const text = span.textContent?.trim() || '';
          if (text.startsWith('@')) {
            handle = text.slice(1);
          } else if (text && !text.startsWith('@') && text.length > 0) {
            displayName = text;
          }
        }

        const verified = !!article.querySelector(verifiedSelector);

        return { handle, displayName, verified };
      },
      {
        article,
        userNameSelector: USER_NAME_SELECTOR,
        verifiedSelector: VERIFIED_ICON_SELECTOR,
      }
    );

    if (!result.handle) {
      failures.push({
        field: 'author.handle',
        postIdOrIndex: postId,
        tickIndex,
        reason: 'handle not found',
      });
    }

    return {
      handle: result.handle || '',
      displayName: result.displayName || '',
      verified: result.verified,
    };
  } catch (error: any) {
    failures.push({
      field: 'author',
      postIdOrIndex: postId,
      tickIndex,
      reason: error.message,
    });

    return {
      handle: '',
      displayName: '',
      verified: false,
    };
  }
}

/**
 * Extract text content from an article.
 */
async function extractText(
  article: any,
  page: Page,
  tickIndex: number,
  postId: string,
  failures: SelectorFailure[]
): Promise<string> {
  try {
    const result = await page.evaluate(
      ({ article, textSelector }) => {
        const textDiv = article.querySelector(textSelector);
        return textDiv?.textContent?.trim() || '';
      },
      { article, textSelector: TWEET_TEXT_SELECTOR }
    );

    return result;
  } catch (error: any) {
    failures.push({
      field: 'text',
      postIdOrIndex: postId,
      tickIndex,
      reason: error.message,
    });

    return '';
  }
}

/**
 * Extract timestamp from an article.
 */
async function extractTimestamp(
  article: any,
  page: Page,
  tickIndex: number,
  postId: string,
  failures: SelectorFailure[]
): Promise<string | null> {
  try {
    const result = await page.evaluate(
      ({ article, timeSelector }) => {
        const timeElement = article.querySelector(timeSelector);
        return timeElement?.getAttribute('datetime') || null;
      },
      { article, timeSelector: TIME_SELECTOR }
    );

    if (!result) {
      failures.push({
        field: 'postedAt',
        postIdOrIndex: postId,
        tickIndex,
        reason: 'datetime attribute missing',
      });
    }

    return result;
  } catch (error: any) {
    failures.push({
      field: 'postedAt',
      postIdOrIndex: postId,
      tickIndex,
      reason: error.message,
    });

    return null;
  }
}

/**
 * Extract metrics from an article.
 */
async function extractMetrics(
  article: any,
  page: Page,
  tickIndex: number,
  postId: string,
  failures: SelectorFailure[]
): Promise<Metrics> {
  try {
    const result = await page.evaluate(({ article }) => {
      // Find buttons and links with aria-labels containing metric names
      const buttons = article.querySelectorAll('button, a');
      const metrics = {
        replies: null,
        reposts: null,
        likes: null,
        views: null,
      };

      for (const btn of buttons) {
        const ariaLabel = btn.getAttribute('aria-label') || '';
        const lowerLabel = ariaLabel.toLowerCase();

        if (lowerLabel.includes('repl')) {
          const match = ariaLabel.match(/^([\d.,kKmM]+)/);
          metrics.replies = match ? match[1] : null;
        } else if (lowerLabel.includes('repost')) {
          const match = ariaLabel.match(/^([\d.,kKmM]+)/);
          metrics.reposts = match ? match[1] : null;
        } else if (lowerLabel.includes('like')) {
          const match = ariaLabel.match(/^([\d.,kKmM]+)/);
          metrics.likes = match ? match[1] : null;
        } else if (lowerLabel.includes('view')) {
          const match = ariaLabel.match(/^([\d.,kKmM]+)/);
          metrics.views = match ? match[1] : null;
        }
      }

      return metrics;
    }, { article });

    const parsedMetrics = {
      replies: parseMetric(result.replies),
      reposts: parseMetric(result.reposts),
      likes: parseMetric(result.likes),
      views: parseMetric(result.views),
    };

    // Record selector failures for missing metrics
    if (result.replies === null && parsedMetrics.replies === null) {
      failures.push({
        field: 'metrics.replies',
        postIdOrIndex: postId,
        tickIndex,
        reason: 'metric element not found',
      });
    }
    if (result.reposts === null && parsedMetrics.reposts === null) {
      failures.push({
        field: 'metrics.reposts',
        postIdOrIndex: postId,
        tickIndex,
        reason: 'metric element not found',
      });
    }
    if (result.likes === null && parsedMetrics.likes === null) {
      failures.push({
        field: 'metrics.likes',
        postIdOrIndex: postId,
        tickIndex,
        reason: 'metric element not found',
      });
    }
    if (result.views === null && parsedMetrics.views === null) {
      failures.push({
        field: 'metrics.views',
        postIdOrIndex: postId,
        tickIndex,
        reason: 'metric element not found',
      });
    }

    return parsedMetrics;
  } catch (error: any) {
    failures.push({
      field: 'metrics',
      postIdOrIndex: postId,
      tickIndex,
      reason: error.message,
    });

    return {
      replies: null,
      reposts: null,
      likes: null,
      views: null,
    };
  }
}

/**
 * Extract media items from an article.
 */
async function extractMedia(
  article: any,
  page: Page
): Promise<MediaItem[]> {
  try {
    const result = await page.evaluate(
      ({ article, imageSelector, videoSelector }) => {
        const media: Array<{ type: 'image' | 'video' | 'gif'; url: string }> = [];

        // Extract images
        const images = article.querySelectorAll(imageSelector);
        for (const img of images) {
          const url = img.getAttribute('src');
          if (url) {
            media.push({ type: 'image', url });
          }
        }

        // Extract videos
        const videos = article.querySelectorAll(videoSelector);
        for (const video of videos) {
          const url = video.getAttribute('src') || video.querySelector('source')?.getAttribute('src');
          if (url) {
            media.push({ type: 'video', url });
          }
        }

        return media;
      },
      {
        article,
        imageSelector: MEDIA_IMAGE_SELECTOR,
        videoSelector: MEDIA_VIDEO_SELECTOR,
      }
    );

    return result;
  } catch {
    return [];
  }
}

/**
 * Check if an article is a repost and extract repostedBy handle.
 */
async function extractRepostInfo(
  article: any,
  page: Page
): Promise<{ isRepost: boolean; repostedBy: string | null }> {
  try {
    const result = await page.evaluate(({ article }) => {
      const textContent = article.textContent || '';
      const match = textContent.match(/@(\w+)\s+reposted/);

      if (match) {
        return { isRepost: true, repostedBy: match[1] };
      }

      return { isRepost: false, repostedBy: null };
    }, { article });

    return result;
  } catch {
    return { isRepost: false, repostedBy: null };
  }
}

/**
 * Extract quoted post from an article.
 * Parses nested quoted tweet if present.
 */
async function extractQuotedPost(
  article: any,
  page: Page,
  tickIndex: number
): Promise<ExtractedPost | null> {
  try {
    // Extract quoted post data in a single page evaluation
    const quotedData = await page.evaluate(
      ({
        article,
        postSelector,
        permalinkSelector,
        userNameSelector,
        textSelector,
        timeSelector,
        verifiedSelector,
      }) => {
        // Look for nested tweet articles (quoted tweets are nested)
        // querySelectorAll finds descendants, so first match is the quoted article
        const nestedArticles = article.querySelectorAll(postSelector);

        // If we have at least one nested article, it's the quoted tweet
        if (nestedArticles.length < 1) {
          return { hasQuoted: false };
        }

        const quotedArticle = nestedArticles[0];

        // Extract quoted post fields
        const permalink = quotedArticle.querySelector(permalinkSelector);
        const permalinkHref = permalink?.getAttribute('href') || null;

        if (!permalinkHref) {
          return { hasQuoted: false };
        }

        const userNameDiv = quotedArticle.querySelector(userNameSelector);
        const spans = userNameDiv?.querySelectorAll('span') || [];
        let displayName = '';
        let handle = '';

        for (const span of spans) {
          const text = span.textContent?.trim() || '';
          if (text.startsWith('@')) {
            handle = text.slice(1);
          } else if (text && !text.startsWith('@') && text.length > 0) {
            displayName = text;
          }
        }

        const textDiv = quotedArticle.querySelector(textSelector);
        const text = textDiv?.textContent?.trim() || '';

        const timeElement = quotedArticle.querySelector(timeSelector);
        const postedAt = timeElement?.getAttribute('datetime') || null;

        const verified = !!quotedArticle.querySelector(verifiedSelector);

        return {
          hasQuoted: true,
          permalink: permalinkHref,
          author: {
            handle,
            displayName,
            verified,
          },
          text,
          postedAt,
        };
      },
      {
        article,
        postSelector: POST_SELECTOR,
        permalinkSelector: PERMALINK_SELECTOR,
        userNameSelector: USER_NAME_SELECTOR,
        textSelector: TWEET_TEXT_SELECTOR,
        timeSelector: TIME_SELECTOR,
        verifiedSelector: VERIFIED_ICON_SELECTOR,
      }
    );

    if (!quotedData.hasQuoted) {
      return null;
    }

    // After hasQuoted check, we know the full structure exists
    const { permalink, author, text, postedAt } = quotedData as {
      hasQuoted: true;
      permalink: string;
      author: Author;
      text: string;
      postedAt: string | null;
    };

    // Extract post ID from permalink
    const postId = extractPostId(permalink);
    if (!postId) {
      return null;
    }

    // Build the quoted post object
    const quotedPost: ExtractedPost = {
      id: postId,
      url: permalink.startsWith('http')
        ? permalink
        : `https://x.com${permalink}`,
      author,
      text,
      postedAt,
      metrics: {
        replies: null,
        reposts: null,
        likes: null,
        views: null,
      },
      media: [],
      isRepost: false,
      repostedBy: null,
      quoted: null, // Don't parse nested quoted posts recursively
      extractedAt: new Date().toISOString(),
      tickIndex,
    };

    return quotedPost;
  } catch {
    return null;
  }
}

/**
 * Parse a single article into an ExtractedPost.
 * Returns null if the article should be dropped (e.g., no permalink).
 */
async function parseArticle(
  article: any,
  page: Page,
  tickIndex: number,
  failures: SelectorFailure[]
): Promise<ExtractedPost | null> {
  try {
    // Extract permalink and post ID first
    const permalink = await page.evaluate(
      ({ article, permalinkSelector }) => {
        const link = article.querySelector(permalinkSelector);
        return link?.getAttribute('href') || null;
      },
      { article, permalinkSelector: PERMALINK_SELECTOR }
    );

    const postId = extractPostId(permalink);

    if (!postId) {
      failures.push({
        field: 'post',
        postIdOrIndex: `tick-${tickIndex}`,
        tickIndex,
        reason: 'no permalink',
      });
      return null;
    }

    // Extract all fields
    const author = await extractAuthor(article, page, tickIndex, postId, failures);
    const text = await extractText(article, page, tickIndex, postId, failures);
    const postedAt = await extractTimestamp(article, page, tickIndex, postId, failures);
    const metrics = await extractMetrics(article, page, tickIndex, postId, failures);
    const media = await extractMedia(article, page);
    const repostInfo = await extractRepostInfo(article, page);
    const quoted = await extractQuotedPost(article, page, tickIndex);

    const post: ExtractedPost = {
      id: postId,
      url: permalink.startsWith('http')
        ? permalink
        : `https://x.com${permalink}`,
      author,
      text,
      postedAt,
      metrics,
      media,
      isRepost: repostInfo.isRepost,
      repostedBy: repostInfo.repostedBy,
      quoted,
      extractedAt: new Date().toISOString(),
      tickIndex,
    };

    return post;
  } catch (error: any) {
    failures.push({
      field: 'post',
      postIdOrIndex: `tick-${tickIndex}`,
      tickIndex,
      reason: error.message,
    });

    return null;
  }
}

/**
 * Create an extractor instance.
 *
 * Returns an object with:
 * - onTick: callback to wire into the scroller's tick hook
 * - getPosts: returns accumulated ExtractedPost[]
 * - getStats: returns extraction statistics
 */
export function createExtractor(): Extractor {
  const posts = new Map<string, ExtractedPost>();
  const stats: ExtractionStats = {
    postsExtracted: 0,
    adsSkipped: 0,
    selectorFailures: [],
    duplicateHits: 0,
  };

  async function onTick(ctx: TickHookContext): Promise<void> {
    const { page, tickIndex } = ctx;

    try {
      // Query all post articles
      const articles = await page.$$(POST_SELECTOR);

      if (articles.length === 0) {
        // Empty feed tick - not an error
        return;
      }

      // Process each article
      for (const article of articles) {
        try {
          // Check if ad
          if (await isAd(article, page)) {
            stats.adsSkipped++;
            continue;
          }

          // Parse article
          const post = await parseArticle(
            article,
            page,
            tickIndex,
            stats.selectorFailures
          );

          if (!post) {
            // parseArticle already recorded the failure
            continue;
          }

          // Deduplicate by ID
          if (posts.has(post.id)) {
            stats.duplicateHits++;
            continue;
          }

          // Add to accumulator
          posts.set(post.id, post);
          stats.postsExtracted++;

        } catch (error: any) {
          // Per-article error - log and continue
          stats.selectorFailures.push({
            field: 'article',
            postIdOrIndex: `tick-${tickIndex}-article`,
            tickIndex,
            reason: error.message,
          });
        }
      }

    } catch (error: any) {
      // Tick-level error - allowed to propagate per spec
      // (scroller's tick-hook error handling will catch this)
      throw error;
    }
  }

  function getPosts(): ExtractedPost[] {
    return Array.from(posts.values());
  }

  function getStats(): ExtractionStats {
    return {
      ...stats,
      selectorFailures: [...stats.selectorFailures],
    };
  }

  return {
    onTick,
    getPosts,
    getStats,
  };
}
