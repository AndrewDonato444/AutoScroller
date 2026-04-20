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
  const tweetsById = new Map<string, XApiTweet>();
  for (const t of resp.includes?.tweets ?? []) tweetsById.set(t.id, t);

  return tweets.map((t, idx) => adaptTweet(t, usersById, mediaByKey, tweetsById, sourceTag, extractedAt, idx));
}

function adaptTweet(
  tweet: XApiTweet,
  usersById: Map<string, XApiUser>,
  mediaByKey: Map<string, XApiMedia>,
  tweetsById: Map<string, XApiTweet>,
  sourceTag: string,
  extractedAt: string,
  idx: number
): ExtractedPost {
  const currentUser = tweet.author_id ? usersById.get(tweet.author_id) : undefined;
  const currentHandle = currentUser?.username ?? 'unknown';

  const referencedRetweet = tweet.referenced_tweets?.find((r) => r.type === 'retweeted');

  // Retweet attribution: if this tweet is a retweet AND we can resolve the
  // referenced original in the expansions, swap author + text to the
  // original. This matches the Playwright extractor's historical semantics
  // (author = who said it; repostedBy = who amplified it).
  //
  // If the original can't be resolved (missing from includes.tweets or its
  // author isn't in usersById), fall back to the retweeter-as-author
  // behavior rather than throwing or dropping the post. Degrade gracefully.
  let author: { handle: string; displayName: string; verified: boolean };
  let text: string;
  let repostedBy: string | null;

  const originalTweet = referencedRetweet ? tweetsById.get(referencedRetweet.id) : undefined;
  const originalUser = originalTweet?.author_id ? usersById.get(originalTweet.author_id) : undefined;

  if (referencedRetweet && originalTweet && originalUser) {
    author = {
      handle: originalUser.username,
      displayName: originalUser.name,
      verified: false,
    };
    text = originalTweet.text;
    repostedBy = currentHandle;
  } else {
    // Non-retweet, or retweet with unresolvable reference: use current tweet.
    author = {
      handle: currentHandle,
      displayName: currentUser?.name ?? currentHandle,
      verified: false,
    };
    text = tweet.text;
    repostedBy = referencedRetweet ? currentHandle : null;
  }

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
    url: `https://x.com/${author.handle}/status/${tweet.id}`,
    author,
    text,
    postedAt: tweet.created_at ?? null,
    metrics: {
      replies: metrics.reply_count ?? null,
      reposts: metrics.retweet_count ?? null,
      likes: metrics.like_count ?? null,
      views: metrics.impression_count ?? null,
    },
    media,
    isRepost: Boolean(referencedRetweet),
    repostedBy,
    quoted: null, // V2: resolve from referenced_tweets[type=quoted] + includes.tweets
    extractedAt,
    tickIndex: idx, // API pages don't have ticks; use position-in-batch as a stand-in
    sourceTag,
  };
}
