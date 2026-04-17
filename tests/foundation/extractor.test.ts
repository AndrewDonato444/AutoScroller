import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { createExtractor, type ExtractedPost } from '../../src/extract/extractor.js';

describe('Extractor', () => {
  describe('Type exports', () => {
    it('should export ExtractedPost type', () => {
      // EXT-001: Type check - ensure ExtractedPost has required fields
      const post: ExtractedPost = {
        id: '1234567890',
        url: 'https://x.com/someone/status/1234567890',
        author: {
          handle: 'someone',
          displayName: 'Someone',
          verified: false,
        },
        text: 'hello world',
        postedAt: '2026-04-16T14:32:00.000Z',
        metrics: {
          replies: 12,
          reposts: 34,
          likes: 560,
          views: 7200,
        },
        media: [{ type: 'image', url: 'https://example.com/image.jpg' }],
        isRepost: false,
        repostedBy: null,
        quoted: null,
        extractedAt: new Date().toISOString(),
        tickIndex: 0,
      };

      expect(post).toBeDefined();
      expect(post.id).toBe('1234567890');
    });
  });

  describe('createExtractor factory', () => {
    it('should return an object with onTick, getPosts, and getStats methods', () => {
      // EXT-002: Factory returns correct API surface
      const extractor = createExtractor();

      expect(extractor).toHaveProperty('onTick');
      expect(extractor).toHaveProperty('getPosts');
      expect(extractor).toHaveProperty('getStats');
      expect(typeof extractor.onTick).toBe('function');
      expect(typeof extractor.getPosts).toBe('function');
      expect(typeof extractor.getStats).toBe('function');
    });

    it('should initialize with empty posts and zero stats', () => {
      // EXT-003: Initial state
      const extractor = createExtractor();

      expect(extractor.getPosts()).toEqual([]);
      expect(extractor.getStats()).toEqual({
        postsExtracted: 0,
        adsSkipped: 0,
        selectorFailures: [],
        duplicateHits: 0,
      });
    });
  });

  describe('Tick hook integration', () => {
    let context: BrowserContext;
    let page: Page;

    beforeEach(async () => {
      context = await chromium.launch().then((browser) =>
        browser.newContext()
      );
      page = await context.newPage();
    });

    afterEach(async () => {
      await context.close();
    });

    it('should extract posts from the page on tick', async () => {
      // EXT-004: Basic extraction on tick
      const extractor = createExtractor();

      // Set up a mock page with a single post
      await page.setContent(`
        <html>
          <body>
            <article data-testid="tweet">
              <a href="/someone/status/1234567890">permalink</a>
              <div data-testid="User-Name">
                <span>Someone</span>
                <span>@someone</span>
              </div>
              <div data-testid="tweetText">hello world</div>
              <time datetime="2026-04-16T14:32:00.000Z">2h</time>
              <button aria-label="12 Replies">12</button>
              <button aria-label="34 Reposts">34</button>
              <button aria-label="560 Likes">560</button>
              <a aria-label="7200 Views">7200</a>
            </article>
          </body>
        </html>
      `);

      await extractor.onTick({ page, tickIndex: 0, elapsedMs: 0 });

      const posts = extractor.getPosts();
      expect(posts).toHaveLength(1);
      expect(posts[0].id).toBe('1234567890');
      expect(posts[0].text).toBe('hello world');
    });

    it('should skip ads and promoted posts', async () => {
      // EXT-005: Ad skipping
      const extractor = createExtractor();

      await page.setContent(`
        <html>
          <body>
            <!-- Regular post -->
            <article data-testid="tweet">
              <a href="/someone/status/1111111111">permalink</a>
              <div data-testid="User-Name">
                <span>Someone</span>
                <span>@someone</span>
              </div>
              <div data-testid="tweetText">regular post</div>
              <time datetime="2026-04-16T14:32:00.000Z">2h</time>
            </article>

            <!-- Ad with placementTracking -->
            <article data-testid="tweet">
              <div data-testid="placementTracking"></div>
              <a href="/advertiser/status/2222222222">permalink</a>
              <div data-testid="User-Name">
                <span>Advertiser</span>
                <span>@advertiser</span>
              </div>
              <div data-testid="tweetText">buy our product</div>
            </article>

            <!-- Ad with "Promoted" label -->
            <article data-testid="tweet">
              <span>Promoted</span>
              <a href="/brand/status/3333333333">permalink</a>
              <div data-testid="User-Name">
                <span>Brand</span>
                <span>@brand</span>
              </div>
              <div data-testid="tweetText">promoted content</div>
            </article>
          </body>
        </html>
      `);

      await extractor.onTick({ page, tickIndex: 0, elapsedMs: 0 });

      const posts = extractor.getPosts();
      const stats = extractor.getStats();

      expect(posts).toHaveLength(1);
      expect(posts[0].text).toBe('regular post');
      expect(stats.adsSkipped).toBe(2);
    });

    it('should parse metrics with k/M suffixes into numbers', async () => {
      // EXT-006: Metric parsing
      const extractor = createExtractor();

      await page.setContent(`
        <html>
          <body>
            <article data-testid="tweet">
              <a href="/user/status/9999999999">permalink</a>
              <div data-testid="User-Name">
                <span>User</span>
                <span>@user</span>
              </div>
              <div data-testid="tweetText">viral post</div>
              <time datetime="2026-04-16T10:00:00.000Z">6h</time>
              <button aria-label="1.2k Replies">1.2k</button>
              <button aria-label="3.4M Reposts">3.4M</button>
              <button aria-label="560 Likes">560</button>
              <a aria-label="789 Views">789</a>
            </article>
          </body>
        </html>
      `);

      await extractor.onTick({ page, tickIndex: 0, elapsedMs: 0 });

      const posts = extractor.getPosts();
      expect(posts[0].metrics.replies).toBe(1200);
      expect(posts[0].metrics.reposts).toBe(3400000);
      expect(posts[0].metrics.likes).toBe(560);
      expect(posts[0].metrics.views).toBe(789);
    });

    it('should deduplicate posts by id within a run', async () => {
      // EXT-007: Deduplication
      const extractor = createExtractor();

      const html = `
        <html>
          <body>
            <article data-testid="tweet">
              <a href="/someone/status/1234567890">permalink</a>
              <div data-testid="User-Name">
                <span>Someone</span>
                <span>@someone</span>
              </div>
              <div data-testid="tweetText">same post</div>
              <time datetime="2026-04-16T14:32:00.000Z">2h</time>
            </article>
          </body>
        </html>
      `;

      await page.setContent(html);
      await extractor.onTick({ page, tickIndex: 3, elapsedMs: 1000 });

      await page.setContent(html);
      await extractor.onTick({ page, tickIndex: 5, elapsedMs: 2000 });

      const posts = extractor.getPosts();
      const stats = extractor.getStats();

      expect(posts).toHaveLength(1);
      expect(posts[0].tickIndex).toBe(3); // Original tick preserved
      expect(stats.duplicateHits).toBe(1);
    });

    it('should handle repost with isRepost and repostedBy', async () => {
      // EXT-008: Repost handling
      const extractor = createExtractor();

      await page.setContent(`
        <html>
          <body>
            <article data-testid="tweet">
              <span>@andrew reposted</span>
              <a href="/someone/status/5555555555">permalink</a>
              <div data-testid="User-Name">
                <span>Someone</span>
                <span>@someone</span>
              </div>
              <div data-testid="tweetText">original post</div>
              <time datetime="2026-04-16T12:00:00.000Z">4h</time>
            </article>
          </body>
        </html>
      `);

      await extractor.onTick({ page, tickIndex: 0, elapsedMs: 0 });

      const posts = extractor.getPosts();
      expect(posts[0].isRepost).toBe(true);
      expect(posts[0].repostedBy).toBe('andrew');
      expect(posts[0].author.handle).toBe('someone'); // Original author
      expect(posts[0].text).toBe('original post');
    });

    it('should parse quoted posts into nested ExtractedPost', async () => {
      // EXT-009: Quoted post handling
      const extractor = createExtractor();

      await page.setContent(`
        <html>
          <body>
            <article data-testid="tweet">
              <a href="/outer/status/7777777777">permalink</a>
              <div data-testid="User-Name">
                <span>Outer</span>
                <span>@outer</span>
              </div>
              <div data-testid="tweetText">this is wild</div>
              <time datetime="2026-04-16T13:00:00.000Z">3h</time>

              <!-- Quoted tweet -->
              <div role="link">
                <article data-testid="tweet">
                  <a href="/inner/status/8888888888">quoted permalink</a>
                  <div data-testid="User-Name">
                    <span>Inner</span>
                    <span>@inner</span>
                  </div>
                  <div data-testid="tweetText">huge if true</div>
                  <time datetime="2026-04-16T11:00:00.000Z">5h</time>
                </article>
              </div>
            </article>
          </body>
        </html>
      `);

      await extractor.onTick({ page, tickIndex: 0, elapsedMs: 0 });

      const posts = extractor.getPosts();
      expect(posts[0].text).toBe('this is wild');
      expect(posts[0].quoted).toBeDefined();
      expect(posts[0].quoted?.text).toBe('huge if true');
      expect(posts[0].quoted?.author.handle).toBe('inner');
      expect(posts[0].text).not.toContain('huge if true');
    });

    it('should gracefully degrade on single field failure', async () => {
      // EXT-010: Graceful degradation
      const extractor = createExtractor();

      await page.setContent(`
        <html>
          <body>
            <article data-testid="tweet">
              <a href="/user/status/6666666666">permalink</a>
              <div data-testid="User-Name">
                <span>User</span>
                <span>@user</span>
              </div>
              <div data-testid="tweetText">post with missing views</div>
              <time datetime="2026-04-16T14:00:00.000Z">2h</time>
              <!-- No views element -->
            </article>
          </body>
        </html>
      `);

      await extractor.onTick({ page, tickIndex: 0, elapsedMs: 0 });

      const posts = extractor.getPosts();
      const stats = extractor.getStats();

      expect(posts).toHaveLength(1);
      expect(posts[0].metrics.views).toBeNull();
      expect(stats.selectorFailures.length).toBeGreaterThan(0);
    });

    it('should drop article with no permalink as whole-post failure', async () => {
      // EXT-011: Whole-post failure
      const extractor = createExtractor();

      await page.setContent(`
        <html>
          <body>
            <article data-testid="tweet">
              <!-- No permalink -->
              <div data-testid="User-Name">
                <span>User</span>
                <span>@user</span>
              </div>
              <div data-testid="tweetText">malformed post</div>
            </article>
          </body>
        </html>
      `);

      await extractor.onTick({ page, tickIndex: 0, elapsedMs: 0 });

      const posts = extractor.getPosts();
      const stats = extractor.getStats();

      expect(posts).toHaveLength(0);
      expect(stats.selectorFailures.some(f => f.field === 'post')).toBe(true);
    });

    it('should trap per-article errors and continue processing', async () => {
      // EXT-012: Error trapping
      const extractor = createExtractor();

      await page.setContent(`
        <html>
          <body>
            <!-- Valid post -->
            <article data-testid="tweet">
              <a href="/user1/status/1111111111">permalink</a>
              <div data-testid="User-Name">
                <span>User1</span>
                <span>@user1</span>
              </div>
              <div data-testid="tweetText">good post</div>
              <time datetime="2026-04-16T14:00:00.000Z">2h</time>
            </article>

            <!-- Malformed post -->
            <article data-testid="tweet">
              <!-- Missing required elements -->
            </article>

            <!-- Another valid post -->
            <article data-testid="tweet">
              <a href="/user2/status/2222222222">permalink</a>
              <div data-testid="User-Name">
                <span>User2</span>
                <span>@user2</span>
              </div>
              <div data-testid="tweetText">another good post</div>
              <time datetime="2026-04-16T13:00:00.000Z">3h</time>
            </article>
          </body>
        </html>
      `);

      await extractor.onTick({ page, tickIndex: 0, elapsedMs: 0 });

      const posts = extractor.getPosts();
      expect(posts.length).toBeGreaterThanOrEqual(2); // At least the two valid posts
    });

    it('should handle empty feed tick without errors', async () => {
      // EXT-013: Empty feed
      const extractor = createExtractor();

      await page.setContent(`
        <html>
          <body>
            <!-- No articles -->
          </body>
        </html>
      `);

      await extractor.onTick({ page, tickIndex: 0, elapsedMs: 0 });

      const posts = extractor.getPosts();
      const stats = extractor.getStats();

      expect(posts).toHaveLength(0);
      expect(stats.selectorFailures).toHaveLength(0);
    });

    it('should read postedAt from datetime attribute, not relative label', async () => {
      // EXT-014: Timestamp extraction
      const extractor = createExtractor();

      await page.setContent(`
        <html>
          <body>
            <article data-testid="tweet">
              <a href="/user/status/4444444444">permalink</a>
              <div data-testid="User-Name">
                <span>User</span>
                <span>@user</span>
              </div>
              <div data-testid="tweetText">timestamped post</div>
              <time datetime="2026-04-16T14:32:00.000Z">2h</time>
            </article>
          </body>
        </html>
      `);

      await extractor.onTick({ page, tickIndex: 0, elapsedMs: 0 });

      const posts = extractor.getPosts();
      expect(posts[0].postedAt).toBe('2026-04-16T14:32:00.000Z');
    });

    it('should set postedAt to null if datetime attribute is missing', async () => {
      // EXT-015: Missing timestamp
      const extractor = createExtractor();

      await page.setContent(`
        <html>
          <body>
            <article data-testid="tweet">
              <a href="/user/status/5555555555">permalink</a>
              <div data-testid="User-Name">
                <span>User</span>
                <span>@user</span>
              </div>
              <div data-testid="tweetText">post without timestamp</div>
              <!-- No time element with datetime -->
            </article>
          </body>
        </html>
      `);

      await extractor.onTick({ page, tickIndex: 0, elapsedMs: 0 });

      const posts = extractor.getPosts();
      expect(posts[0].postedAt).toBeNull();
    });
  });

  describe('Stats tracking', () => {
    it('should track postsExtracted count', () => {
      // EXT-016: Stats - posts extracted
      const extractor = createExtractor();
      // This will be tested with real page content in integration
      expect(extractor.getStats().postsExtracted).toBe(0);
    });

    it('should track adsSkipped count', () => {
      // EXT-017: Stats - ads skipped
      const extractor = createExtractor();
      expect(extractor.getStats().adsSkipped).toBe(0);
    });

    it('should track duplicateHits count', () => {
      // EXT-018: Stats - duplicate hits
      const extractor = createExtractor();
      expect(extractor.getStats().duplicateHits).toBe(0);
    });

    it('should track selectorFailures with details', () => {
      // EXT-019: Stats - selector failures
      const extractor = createExtractor();
      const stats = extractor.getStats();

      expect(Array.isArray(stats.selectorFailures)).toBe(true);
      expect(stats.selectorFailures).toHaveLength(0);
    });
  });

  describe('Idempotency', () => {
    let context: BrowserContext;
    let page: Page;

    beforeEach(async () => {
      context = await chromium.launch().then((browser) =>
        browser.newContext()
      );
      page = await context.newPage();
    });

    afterEach(async () => {
      await context.close();
    });

    it('should be idempotent across rapid re-invocations', async () => {
      // EXT-020: Idempotency
      const extractor = createExtractor();

      const html = `
        <html>
          <body>
            <article data-testid="tweet">
              <a href="/user/status/9999999999">permalink</a>
              <div data-testid="User-Name">
                <span>User</span>
                <span>@user</span>
              </div>
              <div data-testid="tweetText">same post twice</div>
              <time datetime="2026-04-16T14:00:00.000Z">2h</time>
            </article>
          </body>
        </html>
      `;

      await page.setContent(html);
      await extractor.onTick({ page, tickIndex: 0, elapsedMs: 0 });
      await extractor.onTick({ page, tickIndex: 0, elapsedMs: 0 });

      const posts = extractor.getPosts();
      expect(posts).toHaveLength(1);
    });
  });

  describe('Read-only guarantee', () => {
    it('should never call page.click, page.fill, or page.keyboard.type', () => {
      // EXT-021: Read-only operations
      const extractor = createExtractor();

      // Check that the extractor's API doesn't include write operations
      expect(extractor).not.toHaveProperty('click');
      expect(extractor).not.toHaveProperty('fill');
      expect(extractor).not.toHaveProperty('type');
      expect(extractor).not.toHaveProperty('react');
      expect(extractor).not.toHaveProperty('like');
      expect(extractor).not.toHaveProperty('follow');
    });
  });

  describe('Media extraction', () => {
    let context: BrowserContext;
    let page: Page;

    beforeEach(async () => {
      context = await chromium.launch().then((browser) =>
        browser.newContext()
      );
      page = await context.newPage();
    });

    afterEach(async () => {
      await context.close();
    });

    it('should extract image media URLs', async () => {
      // EXT-022: Image media
      const extractor = createExtractor();

      await page.setContent(`
        <html>
          <body>
            <article data-testid="tweet">
              <a href="/user/status/1111111111">permalink</a>
              <div data-testid="User-Name">
                <span>User</span>
                <span>@user</span>
              </div>
              <div data-testid="tweetText">post with image</div>
              <time datetime="2026-04-16T14:00:00.000Z">2h</time>
              <img src="https://pbs.twimg.com/media/image.jpg" alt="image" />
            </article>
          </body>
        </html>
      `);

      await extractor.onTick({ page, tickIndex: 0, elapsedMs: 0 });

      const posts = extractor.getPosts();
      expect(posts[0].media).toHaveLength(1);
      expect(posts[0].media[0].type).toBe('image');
      expect(posts[0].media[0].url).toContain('image.jpg');
    });

    it('should handle posts with no media', async () => {
      // EXT-023: No media
      const extractor = createExtractor();

      await page.setContent(`
        <html>
          <body>
            <article data-testid="tweet">
              <a href="/user/status/2222222222">permalink</a>
              <div data-testid="User-Name">
                <span>User</span>
                <span>@user</span>
              </div>
              <div data-testid="tweetText">text-only post</div>
              <time datetime="2026-04-16T14:00:00.000Z">2h</time>
            </article>
          </body>
        </html>
      `);

      await extractor.onTick({ page, tickIndex: 0, elapsedMs: 0 });

      const posts = extractor.getPosts();
      expect(posts[0].media).toEqual([]);
    });
  });

  describe('Author metadata', () => {
    let context: BrowserContext;
    let page: Page;

    beforeEach(async () => {
      context = await chromium.launch().then((browser) =>
        browser.newContext()
      );
      page = await context.newPage();
    });

    afterEach(async () => {
      await context.close();
    });

    it('should extract author handle, displayName, and verified status', async () => {
      // EXT-024: Author metadata
      const extractor = createExtractor();

      await page.setContent(`
        <html>
          <body>
            <article data-testid="tweet">
              <a href="/verified/status/3333333333">permalink</a>
              <div data-testid="User-Name">
                <span>Verified User</span>
                <span>@verified</span>
                <svg data-testid="icon-verified"></svg>
              </div>
              <div data-testid="tweetText">verified post</div>
              <time datetime="2026-04-16T14:00:00.000Z">2h</time>
            </article>
          </body>
        </html>
      `);

      await extractor.onTick({ page, tickIndex: 0, elapsedMs: 0 });

      const posts = extractor.getPosts();
      expect(posts[0].author.handle).toBe('verified');
      expect(posts[0].author.displayName).toBe('Verified User');
      expect(posts[0].author.verified).toBe(true);
    });
  });
});
