/**
 * Tests for X API Production Hardening (feature: x-api-hardening).
 *
 * Covers three hardening fixes for the X API source layer:
 *   1. Retweet attribution in the adapter (XH-01 through XH-04)
 *   2. Serialized token refresh in the API client (XH-05 through XH-07)
 *   3. Repo-root-relative .env.local resolution (XH-08, XH-09)
 *
 * Scenarios correspond 1:1 to the Gherkin spec at
 * .specs/features/expansion/x-api-hardening.feature.md.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { adaptListResponse, type XApiListResponse } from '../../src/sources/xListAdapter.js';

// -------------------------------------------------------------------
// XH-01 through XH-04: retweet attribution
// -------------------------------------------------------------------

describe('XH-01: retweet preserves original author and full text', () => {
  it('maps author to the retweeted tweet\'s original author, not the retweeter', () => {
    const resp: XApiListResponse = {
      data: [
        {
          id: 'T1',
          text: 'RT @original: Original thought in ful…', // retweet wrapper, truncated
          author_id: 'retweeter_id',
          created_at: '2026-04-20T00:00:00Z',
          referenced_tweets: [{ type: 'retweeted', id: 'T0' }],
        },
      ],
      includes: {
        users: [
          { id: 'retweeter_id', name: 'The Retweeter', username: 'retweeter' },
          { id: 'original_id', name: 'The Original', username: 'original' },
        ],
        tweets: [
          {
            id: 'T0',
            text: 'Original thought in full',
            author_id: 'original_id',
            created_at: '2026-04-19T00:00:00Z',
          },
        ],
      },
    };

    const posts = adaptListResponse(resp, 'test-tag', '2026-04-20T12:00:00Z');

    expect(posts).toHaveLength(1);
    const post = posts[0];
    expect(post.author.handle).toBe('original');
    expect(post.author.displayName).toBe('The Original');
    expect(post.repostedBy).toBe('retweeter');
    expect(post.isRepost).toBe(true);
    expect(post.text).toBe('Original thought in full');
  });
});

describe('XH-02: retweet with unresolvable reference degrades gracefully', () => {
  it('falls back to current tweet author + text when includes.tweets is missing the reference', () => {
    const resp: XApiListResponse = {
      data: [
        {
          id: 'T1',
          text: 'RT @someone: truncated wrapper…',
          author_id: 'retweeter_id',
          created_at: '2026-04-20T00:00:00Z',
          referenced_tweets: [{ type: 'retweeted', id: 'T_MISSING' }],
        },
      ],
      includes: {
        users: [{ id: 'retweeter_id', name: 'The Retweeter', username: 'retweeter' }],
        // No includes.tweets at all — simulating missing expansion.
      },
    };

    expect(() => adaptListResponse(resp, 'test-tag', '2026-04-20T12:00:00Z')).not.toThrow();
    const posts = adaptListResponse(resp, 'test-tag', '2026-04-20T12:00:00Z');
    expect(posts).toHaveLength(1);
    const post = posts[0];
    // Falls back to retweeter as author (pre-hardening behavior on the specific field).
    expect(post.author.handle).toBe('retweeter');
    expect(post.repostedBy).toBe('retweeter');
    expect(post.isRepost).toBe(true);
    // Text stays as the (truncated) wrapper since we can't resolve the full original.
    expect(post.text).toBe('RT @someone: truncated wrapper…');
  });
});

describe('XH-03: quoted tweet is unchanged by hardening', () => {
  it('does not rewrite author or text for quote tweets (quoted path remains V2-deferred)', () => {
    const resp: XApiListResponse = {
      data: [
        {
          id: 'T1',
          text: 'My thoughts on this take',
          author_id: 'author_id',
          created_at: '2026-04-20T00:00:00Z',
          referenced_tweets: [{ type: 'quoted', id: 'T0' }],
        },
      ],
      includes: {
        users: [
          { id: 'author_id', name: 'The Author', username: 'author' },
          { id: 'quoted_id', name: 'The Quoted', username: 'quoted' },
        ],
        tweets: [
          { id: 'T0', text: 'The quoted text', author_id: 'quoted_id' },
        ],
      },
    };

    const posts = adaptListResponse(resp, 'test-tag', '2026-04-20T12:00:00Z');

    expect(posts).toHaveLength(1);
    const post = posts[0];
    expect(post.author.handle).toBe('author');
    expect(post.repostedBy).toBeNull();
    expect(post.isRepost).toBe(false);
    expect(post.text).toBe('My thoughts on this take');
    expect(post.quoted).toBeNull(); // V2-deferred
  });
});

describe('XH-04: plain tweet with no references is unchanged', () => {
  it('adapts identically whether or not retweet-attribution logic exists', () => {
    const resp: XApiListResponse = {
      data: [
        {
          id: 'T1',
          text: 'A plain tweet with no references',
          author_id: 'author_id',
          created_at: '2026-04-20T00:00:00Z',
          public_metrics: { like_count: 5, retweet_count: 1, reply_count: 0 },
        },
      ],
      includes: {
        users: [{ id: 'author_id', name: 'Author', username: 'author' }],
      },
    };

    const posts = adaptListResponse(resp, 'test-tag', '2026-04-20T12:00:00Z');

    expect(posts).toHaveLength(1);
    const post = posts[0];
    expect(post.author.handle).toBe('author');
    expect(post.repostedBy).toBeNull();
    expect(post.isRepost).toBe(false);
    expect(post.text).toBe('A plain tweet with no references');
    expect(post.metrics.likes).toBe(5);
    expect(post.metrics.reposts).toBe(1);
  });
});

// -------------------------------------------------------------------
// XH-05 through XH-07: serialized token refresh
// -------------------------------------------------------------------
//
// Strategy: mock the xRefresh module so we can count refresh calls and
// control resolution timing. Reset the xApiClient module between tests so
// the in-flight refresh cache starts clean each time.

describe('XH-05: parallel getValidToken calls issue exactly one refresh', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('coalesces 5 concurrent near-expiry refreshes into a single refreshAccessToken() call', async () => {
    // Mock env reading so the client thinks the token is near expiry.
    const nearExpiry = new Date(Date.now() + 30_000).toISOString(); // 30s from now — within 2m threshold
    const refreshedExpiry = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();

    const refreshMock = vi.fn(async () => {
      // Simulate non-trivial refresh latency so concurrent callers line up behind us.
      await new Promise((r) => setTimeout(r, 50));
      return {
        accessToken: 'new-access-token',
        refreshToken: 'new-refresh-token',
        expiresAt: refreshedExpiry,
        scope: 'tweet.read',
      };
    });

    vi.doMock('../../src/xRefresh.js', () => ({
      refreshAccessToken: refreshMock,
    }));

    // Mock .env.local read: need X_BEARER_TOKEN and X_TOKEN_EXPIRES_AT.
    vi.doMock('node:fs/promises', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs/promises')>();
      return {
        ...actual,
        readFile: vi.fn(async (filePath: any, enc: any) => {
          if (String(filePath).endsWith('.env.local')) {
            return `X_BEARER_TOKEN=old-token\nX_TOKEN_EXPIRES_AT=${nearExpiry}\n`;
          }
          return actual.readFile(filePath, enc);
        }),
      };
    });

    // Mock fetch so xGet doesn't actually hit the network.
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: { id: '1', name: 'u', username: 'u' } }), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);

    // Import AFTER mocks are in place.
    const { xGet, resetClient } = await import('../../src/sources/xApiClient.js');
    resetClient();

    // Fire 5 parallel xGet calls. Each internally calls getValidToken,
    // which should see near-expiry and refresh.
    await Promise.all(Array.from({ length: 5 }, () => xGet('/users/me')));

    expect(refreshMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });
});

describe('XH-06: reactive 401 refresh is also serialized', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('two concurrent 401s share a single reactive refresh', async () => {
    const farFutureExpiry = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();

    const refreshMock = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 50));
      return {
        accessToken: 'fresh-token',
        refreshToken: 'fresh-refresh',
        expiresAt: farFutureExpiry,
        scope: 'tweet.read',
      };
    });

    vi.doMock('../../src/xRefresh.js', () => ({
      refreshAccessToken: refreshMock,
    }));

    vi.doMock('node:fs/promises', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs/promises')>();
      return {
        ...actual,
        readFile: vi.fn(async (filePath: any, enc: any) => {
          if (String(filePath).endsWith('.env.local')) {
            return `X_BEARER_TOKEN=valid-cached-token\nX_TOKEN_EXPIRES_AT=${farFutureExpiry}\n`;
          }
          return actual.readFile(filePath, enc);
        }),
      };
    });

    // First call returns 401, all subsequent calls succeed.
    let callCount = 0;
    const fetchMock = vi.fn(async () => {
      callCount += 1;
      if (callCount <= 2) {
        return new Response('Unauthorized', { status: 401 });
      }
      return new Response(JSON.stringify({ data: { id: '1', name: 'u', username: 'u' } }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { xGet, resetClient } = await import('../../src/sources/xApiClient.js');
    resetClient();

    // Two concurrent calls. Both will 401 on first attempt. They should share one refresh.
    await Promise.all([xGet('/users/me'), xGet('/users/me')]);

    expect(refreshMock).toHaveBeenCalledTimes(1);
  });
});

describe('XH-07: refresh failure does not wedge the in-flight cache', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('clears inFlightRefresh on rejection so subsequent calls retry fresh', async () => {
    const nearExpiry = new Date(Date.now() + 30_000).toISOString();

    let callNum = 0;
    const refreshMock = vi.fn(async () => {
      callNum += 1;
      if (callNum === 1) {
        throw new Error('refresh failed (simulated)');
      }
      return {
        accessToken: 'recovered-token',
        refreshToken: 'recovered-refresh',
        expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
        scope: 'tweet.read',
      };
    });

    vi.doMock('../../src/xRefresh.js', () => ({
      refreshAccessToken: refreshMock,
    }));

    vi.doMock('node:fs/promises', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs/promises')>();
      return {
        ...actual,
        readFile: vi.fn(async (filePath: any, enc: any) => {
          if (String(filePath).endsWith('.env.local')) {
            return `X_BEARER_TOKEN=old-token\nX_TOKEN_EXPIRES_AT=${nearExpiry}\n`;
          }
          return actual.readFile(filePath, enc);
        }),
      };
    });

    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: { id: '1', name: 'u', username: 'u' } }), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);

    const { xGet, resetClient } = await import('../../src/sources/xApiClient.js');
    resetClient();

    // First call fails because refresh rejects.
    await expect(xGet('/users/me')).rejects.toThrow(/refresh failed/);

    // Second call must kick off a NEW refresh attempt (not await a dead promise).
    const result = await xGet('/users/me');
    expect(result).toBeDefined();

    // Two refresh attempts: one that failed, one that succeeded.
    expect(refreshMock).toHaveBeenCalledTimes(2);
  });
});

// -------------------------------------------------------------------
// XH-08, XH-09: repo-root-relative .env.local resolution
// -------------------------------------------------------------------

describe('XH-08: repoRoot helper resolves the repo root independent of cwd', () => {
  it('resolves to the package root without calling process.cwd()', async () => {
    // The stronger assertion is behavioral: the helper must not call
    // process.cwd() at all. If it doesn't, the result is definitionally
    // independent of cwd. (vitest workers don't support process.chdir(),
    // so we can't prove it by changing cwd at runtime.)
    const cwdSpy = vi.spyOn(process, 'cwd');

    const { repoRoot, envLocalPath } = await import('../../src/lib/repoRoot.js');
    const root = repoRoot();
    const envPath = envLocalPath();

    // Helper must not have reached for cwd.
    expect(cwdSpy).not.toHaveBeenCalled();

    // Resolved path should be absolute and end with the repo directory name.
    expect(path.isAbsolute(root)).toBe(true);
    expect(root).toMatch(/AutoScroller$/);

    // Should contain package.json with name 'scrollproxy'.
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    expect(pkg.name).toBe('scrollproxy');

    // envLocalPath should be root + .env.local.
    expect(envPath).toBe(path.join(root, '.env.local'));

    cwdSpy.mockRestore();
  });
});

describe('XH-09: all .env.local consumers use the shared helper, not process.cwd()', () => {
  const HELPER_IMPORT_RE = /from ['"]\.\.\/lib\/repoRoot(?:\.js)?['"]|from ['"]\.\.\/\.\.\/lib\/repoRoot(?:\.js)?['"]|from ['"]\.\/lib\/repoRoot(?:\.js)?['"]/;
  const CWD_ENV_RE = /path\.resolve\(\s*process\.cwd\(\)\s*,\s*['"]\.env\.local['"]/;

  const consumers = [
    'src/xAuth.ts',
    'src/xRefresh.ts',
    'src/sources/xApiClient.ts',
  ];

  for (const file of consumers) {
    it(`${file} imports from lib/repoRoot and does not resolve .env.local via process.cwd()`, () => {
      const thisFile = fileURLToPath(import.meta.url);
      // tests/expansion/{thisFile} → repo root is two levels up.
      const repoRootForTest = path.resolve(path.dirname(thisFile), '..', '..');
      const absPath = path.join(repoRootForTest, file);
      const content = readFileSync(absPath, 'utf8');

      expect(content, `${file} should not resolve .env.local via process.cwd()`).not.toMatch(CWD_ENV_RE);
      expect(content, `${file} should import from lib/repoRoot`).toMatch(HELPER_IMPORT_RE);
    });
  }
});
