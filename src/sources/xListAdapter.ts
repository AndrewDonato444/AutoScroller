/**
 * Map X API v2 list/bookmark responses → the existing `ExtractedPost` shape.
 *
 * This keeps the summarizer, state layer, and writer identical regardless of
 * whether posts came from Playwright DOM extraction or the X API. The adapter
 * is the only place the API response shape is concerned with; downstream
 * pipeline code stays oblivious.
 *
 * V1 scope: text, author, metrics, media, isRepost. Quoted tweets set to null
 * for now — can be added in V2 without touching callers.
 */

import type { ExtractedPost } from '../extract/extractor.js';

/** Raw shape of a single tweet object from the X API v2. */
export interface XApiTweet {
  id: string;
  text: string;
  author_id?: string;
  created_at?: string;
  public_metrics?: {
    retweet_count?: number;
    reply_count?: number;
    like_count?: number;
    quote_count?: number;
    bookmark_count?: number;
    impression_count?: number;
  };
  attachments?: {
    media_keys?: string[];
  };
  referenced_tweets?: Array<{
    type: 'retweeted' | 'quoted' | 'replied_to';
    id: string;
  }>;
}

export interface XApiUser {
  id: string;
  name: string;
  username: string;
  profile_image_url?: string;
}

export interface XApiMedia {
  media_key: string;
  type: 'photo' | 'video' | 'animated_gif';
  url?: string;
  preview_image_url?: string;
  alt_text?: string;
}

/** The full v2 response envelope for list/bookmark endpoints. */
export interface XApiListResponse {
  data?: XApiTweet[];
  includes?: {
    users?: XApiUser[];
    media?: XApiMedia[];
    tweets?: XApiTweet[]; // referenced tweets
  };
  meta?: {
    result_count?: number;
    next_token?: string;
    newest_id?: string;
    oldest_id?: string;
  };
}

/**
 * Adapt one list/bookmark response batch into ExtractedPost[].
 *
 * @param resp - The raw API response (single page).
 * @param sourceTag - The source-lane tag to attach to every post (e.g. "ai-frontier").
 * @param extractedAt - ISO timestamp marking when this batch was fetched.
 */
export function adaptListResponse(
  resp: XApiListResponse,
  sourceTag: string,
  extractedAt: string
): ExtractedPost[] {
  const tweets = resp.data ?? [];
  const usersById = new Map<string, XApiUser>();
  for (const u of resp.includes?.users ?? []) usersById.set(u.id, u);
  const mediaByKey = new Map<string, XApiMedia>();
  for (const m of resp.includes?.media ?? []) mediaByKey.set(m.media_key, m);

  return tweets.map((t, idx) => adaptTweet(t, usersById, mediaByKey, sourceTag, extractedAt, idx));
}

function adaptTweet(
  tweet: XApiTweet,
  usersById: Map<string, XApiUser>,
  mediaByKey: Map<string, XApiMedia>,
  sourceTag: string,
  extractedAt: string,
  idx: number
): ExtractedPost {
  const user = tweet.author_id ? usersById.get(tweet.author_id) : undefined;
  const handle = user?.username ?? 'unknown';

  const referencedRetweet = tweet.referenced_tweets?.find((r) => r.type === 'retweeted');

  const metrics = tweet.public_metrics ?? {};

  const media = (tweet.attachments?.media_keys ?? [])
    .map((key) => mediaByKey.get(key))
    .filter((m): m is XApiMedia => Boolean(m))
    .map((m) => ({
      type: m.type === 'photo' ? ('image' as const) : m.type === 'video' ? ('video' as const) : ('gif' as const),
      url: m.url ?? m.preview_image_url ?? '',
    }));

  return {
    id: tweet.id,
    url: `https://x.com/${handle}/status/${tweet.id}`,
    author: {
      handle,
      displayName: user?.name ?? handle,
      // X API v2 basic user.fields doesn't return verified status reliably at
      // this tier. Defaulting to false; can be plumbed in later if needed.
      verified: false,
    },
    text: tweet.text,
    postedAt: tweet.created_at ?? null,
    metrics: {
      replies: metrics.reply_count ?? null,
      reposts: metrics.retweet_count ?? null,
      likes: metrics.like_count ?? null,
      views: metrics.impression_count ?? null,
    },
    media,
    isRepost: Boolean(referencedRetweet),
    repostedBy: referencedRetweet ? handle : null,
    quoted: null, // V2: resolve from referenced_tweets[type=quoted] + includes.tweets
    extractedAt,
    tickIndex: idx, // API pages don't have ticks; use position-in-batch as a stand-in
    sourceTag,
  };
}
