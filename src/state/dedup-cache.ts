import { createHash } from 'node:crypto';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExtractedPost } from '../types/post.js';
import { expandHomeDir } from '../lib/expandHomeDir.js';

/**
 * Schema version for the dedup cache file.
 * Bump this when the file format changes.
 */
export const CACHE_SCHEMA_VERSION = 1;

/**
 * Maximum number of hashes to keep in the cache.
 * FIFO eviction when this limit is reached.
 */
export const MAX_CACHE_SIZE = 10000;

/**
 * Dedup cache structure.
 * Stored as JSON at <stateDir>/seen-posts.json.
 */
export interface DedupCache {
  schemaVersion: number;
  hashes: string[];
}

/**
 * Hash a post ID to a stable 16-hex-char SHA-256 prefix.
 *
 * Returns the same hash for the same post.id across runs, machines, and Node versions.
 * 16 hex chars = 64 bits of entropy (collision probability ~2.7×10⁻¹² at 10k items).
 */
export function hashPost(post: ExtractedPost): string {
  const hash = createHash('sha256');
  hash.update(post.id);
  return hash.digest('hex').slice(0, 16);
}

/**
 * Quarantine a corrupt cache file and log the action.
 * Returns the path to the quarantined file.
 */
async function quarantineCorruptCache(
  cachePath: string,
  resolvedStateDir: string,
  logMessage: string
): Promise<void> {
  const epochMs = Date.now();
  const corruptPath = join(resolvedStateDir, `seen-posts.json.corrupt-${epochMs}`);
  await rename(cachePath, corruptPath);
  console.log(logMessage);
}

/**
 * Load the dedup cache from <stateDir>/seen-posts.json.
 *
 * Returns an empty cache if:
 * - The file does not exist (first run)
 * - The file is corrupt (invalid JSON, wrong schemaVersion)
 *
 * Corrupt files are quarantined to seen-posts.json.corrupt-<timestamp>.
 */
export async function loadDedupCache(stateDir: string): Promise<DedupCache> {
  const resolvedStateDir = expandHomeDir(stateDir);
  const cachePath = join(resolvedStateDir, 'seen-posts.json');

  try {
    const content = await readFile(cachePath, 'utf-8');
    const parsed = JSON.parse(content);

    // Validate schema version
    if (parsed.schemaVersion !== CACHE_SCHEMA_VERSION) {
      await quarantineCorruptCache(
        cachePath,
        resolvedStateDir,
        `dedup cache schema ${parsed.schemaVersion} not supported by this build; quarantined and started fresh`
      );
      return { schemaVersion: CACHE_SCHEMA_VERSION, hashes: [] };
    }

    // Validate structure
    if (!Array.isArray(parsed.hashes)) {
      throw new Error('hashes field is not an array');
    }

    return parsed as DedupCache;
  } catch (error: any) {
    // File doesn't exist - first run
    if (error.code === 'ENOENT') {
      return { schemaVersion: CACHE_SCHEMA_VERSION, hashes: [] };
    }

    // Corrupt file - quarantine and start fresh
    try {
      const epochMs = Date.now();
      await quarantineCorruptCache(
        cachePath,
        resolvedStateDir,
        `dedup cache corrupt; quarantined to seen-posts.json.corrupt-${epochMs}, starting fresh`
      );
    } catch {
      // If rename fails, just log and continue
      console.log('dedup cache corrupt; starting fresh');
    }

    return { schemaVersion: CACHE_SCHEMA_VERSION, hashes: [] };
  }
}

/**
 * Save the dedup cache to <stateDir>/seen-posts.json atomically.
 *
 * Uses tmpfile + rename to ensure the cache is never partially written.
 * Creates the state directory recursively if it doesn't exist.
 */
export async function saveDedupCache(
  cache: DedupCache,
  stateDir: string
): Promise<{ statePath: string }> {
  const resolvedStateDir = expandHomeDir(stateDir);
  const cachePath = join(resolvedStateDir, 'seen-posts.json');
  const tmpPath = join(resolvedStateDir, 'seen-posts.json.tmp');

  // Create state directory if it doesn't exist
  await mkdir(resolvedStateDir, { recursive: true });

  // Serialize with fixed key order and 2-space indentation
  const payload = {
    schemaVersion: cache.schemaVersion,
    hashes: cache.hashes,
  };
  const content = JSON.stringify(payload, null, 2);

  // Write to tmpfile
  await writeFile(tmpPath, content, 'utf-8');

  // Atomic rename
  await rename(tmpPath, cachePath);

  return { statePath: cachePath };
}

/**
 * Partition posts into new vs. seen based on the cache.
 *
 * Returns:
 * - newPosts: posts not in cache (ALL posts if not in cache, including duplicates within run)
 * - seenPosts: posts already in cache
 * - newHashes: deduped hashes of new posts in first-seen order
 *
 * newHashes deduplicates within the run (same post.id appearing twice contributes one hash).
 */
export function partitionPosts(
  posts: ExtractedPost[],
  cache: DedupCache
): { newPosts: ExtractedPost[]; seenPosts: ExtractedPost[]; newHashes: string[] } {
  const cacheSet = new Set(cache.hashes);
  const newPosts: ExtractedPost[] = [];
  const seenPosts: ExtractedPost[] = [];
  const newHashesSet = new Set<string>();
  const newHashes: string[] = [];

  for (const post of posts) {
    const hash = hashPost(post);

    if (cacheSet.has(hash)) {
      seenPosts.push(post);
    } else {
      newPosts.push(post);

      // Only add to newHashes if we haven't seen this hash in this run yet
      if (!newHashesSet.has(hash)) {
        newHashesSet.add(hash);
        newHashes.push(hash);
      }
    }
  }

  return { newPosts, seenPosts, newHashes };
}

/**
 * Append new hashes to the cache and enforce FIFO eviction at MAX_CACHE_SIZE.
 *
 * Returns a new cache (does not mutate the input).
 * Oldest hashes are evicted from the front when the limit is reached.
 */
export function appendHashes(cache: DedupCache, newHashes: string[]): DedupCache {
  const combined = [...cache.hashes, ...newHashes];

  // FIFO eviction: keep the newest MAX_CACHE_SIZE hashes
  const hashes =
    combined.length > MAX_CACHE_SIZE
      ? combined.slice(combined.length - MAX_CACHE_SIZE)
      : combined;

  return {
    schemaVersion: cache.schemaVersion,
    hashes,
  };
}
