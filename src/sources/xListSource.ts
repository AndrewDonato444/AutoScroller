/**
 * X API source — fetches posts from the configured X lists (and optionally
 * the authenticated user's bookmarks) and adapts them into ExtractedPost[].
 *
 * This is the drop-in replacement for the Playwright scroller's extraction
 * stage. Everything downstream of here (summarizer, state, writer) is
 * source-agnostic.
 *
 * V1 limitations (noted for later):
 *   - No `since_id` cursor tracking — we pull max_results per run and rely
 *     on the state layer to dedupe by post ID. That wastes ~70% of API
 *     spend on dupes. Phase 3 TODO.
 *   - Quoted tweets set to null in the adapter (see xListAdapter.ts).
 *   - No pagination — one page per list per run is plenty for ScrollProxy
 *     cadence (~6h between runs).
 */

import { xGet, getAuthenticatedUser } from './xApiClient.js';
import { adaptListResponse, type XApiListResponse } from './xListAdapter.js';
import type { ExtractedPost } from '../types/post.js';

/** Shape of the x.lists[] entries in config.yaml. Mirrors configSchema.x.lists. */
export interface XListConfig {
  id: string;
  name: string;
  tag: string;
  postsPerRun: number;
  note?: string;
}

export interface XSourceConfig {
  baseUrl: string;
  lists: XListConfig[];
  bookmarks: {
    enabled: boolean;
    postsPerRun: number;
  };
}

/** One list's fetch result, with diagnostics. */
export interface ListPull {
  tag: string;
  listId: string;
  listName: string;
  posts: ExtractedPost[];
  fetched: number;
  error?: string;
}

/** Full run output: one ListPull per configured list + optional bookmarks. */
export interface XSourceResult {
  pulls: ListPull[];
  totalPosts: number;
  startedAt: string;
  finishedAt: string;
}

/**
 * Common query params for list/bookmark tweet fetches. Includes the expansions
 * and field selections needed to populate the full ExtractedPost shape.
 */
function tweetFetchParams(maxResults: number): Record<string, string> {
  return {
    max_results: String(maxResults),
    expansions: 'author_id,attachments.media_keys,referenced_tweets.id',
    'tweet.fields': 'created_at,public_metrics,author_id,attachments,referenced_tweets',
    'user.fields': 'name,username,profile_image_url',
    'media.fields': 'type,url,preview_image_url,alt_text',
  };
}

/**
 * Pull posts from one configured list and adapt them.
 * Errors on one list don't kill the whole run — they're captured on the pull.
 */
async function fetchList(list: XListConfig, extractedAt: string): Promise<ListPull> {
  const base: ListPull = {
    tag: list.tag,
    listId: list.id,
    listName: list.name,
    posts: [],
    fetched: 0,
  };
  try {
    const resp = await xGet<XApiListResponse>(
      `/lists/${list.id}/tweets`,
      tweetFetchParams(list.postsPerRun)
    );
    const posts = adaptListResponse(resp, list.tag, extractedAt);
    return { ...base, posts, fetched: posts.length };
  } catch (err) {
    return {
      ...base,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Pull the authenticated user's bookmarks and adapt them. Uses sourceTag
 * "bookmarks" so the summarizer can weight these as a higher-trust signal.
 */
async function fetchBookmarks(
  userId: string,
  maxResults: number,
  extractedAt: string
): Promise<ListPull> {
  const base: ListPull = {
    tag: 'bookmarks',
    listId: `bookmarks:${userId}`,
    listName: 'Bookmarks',
    posts: [],
    fetched: 0,
  };
  try {
    const resp = await xGet<XApiListResponse>(
      `/users/${userId}/bookmarks`,
      tweetFetchParams(maxResults)
    );
    const posts = adaptListResponse(resp, 'bookmarks', extractedAt);
    return { ...base, posts, fetched: posts.length };
  } catch (err) {
    return {
      ...base,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * The main entry point. Fetches all configured lists (and optionally
 * bookmarks) and returns a structured result.
 */
export async function pullFromXApi(config: XSourceConfig): Promise<XSourceResult> {
  const startedAt = new Date().toISOString();

  // Run list pulls in parallel — each hits a different endpoint/list so
  // rate limits won't stack, and total wall-time shrinks to the slowest call.
  const listPromises = config.lists.map((list) => fetchList(list, startedAt));

  let bookmarksPromise: Promise<ListPull> | null = null;
  if (config.bookmarks.enabled) {
    // Need user ID for the bookmarks endpoint. Fetch it once up front —
    // the client caches the token so this is ~1 extra cheap request per run.
    const me = await getAuthenticatedUser();
    bookmarksPromise = fetchBookmarks(
      me.data.id,
      config.bookmarks.postsPerRun,
      startedAt
    );
  }

  const pulls = await Promise.all([...listPromises, ...(bookmarksPromise ? [bookmarksPromise] : [])]);
  const finishedAt = new Date().toISOString();

  const totalPosts = pulls.reduce((sum, p) => sum + p.fetched, 0);

  return { pulls, totalPosts, startedAt, finishedAt };
}

/**
 * Flatten the result to a single ExtractedPost[] (for callers that don't
 * care about per-list grouping). Posts retain their sourceTag.
 */
export function flattenPulls(result: XSourceResult): ExtractedPost[] {
  return result.pulls.flatMap((p) => p.posts);
}
