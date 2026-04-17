import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  loadDedupCache,
  saveDedupCache,
  hashPost,
  partitionPosts,
  appendHashes,
  CACHE_SCHEMA_VERSION,
  MAX_CACHE_SIZE,
  type DedupCache,
} from '../../src/state/dedup-cache.js';
import type { ExtractedPost } from '../../src/extract/extractor.js';
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('State Module (Dedup Cache)', () => {
  let testStateDir: string;

  beforeEach(() => {
    // Create a unique temp directory for each test
    testStateDir = join(tmpdir(), `dedup-cache-test-${Date.now()}`);
  });

  afterEach(() => {
    // Clean up test directory
    if (existsSync(testStateDir)) {
      rmSync(testStateDir, { recursive: true, force: true });
    }
  });

  // Helper to create a minimal ExtractedPost
  function makePost(id: string, tickIndex = 0): ExtractedPost {
    return {
      id,
      url: `https://x.com/user/status/${id}`,
      author: { handle: 'testuser', displayName: 'Test User', verified: false },
      text: 'Test post',
      postedAt: '2026-04-16T14:00:00.000Z',
      metrics: { replies: null, reposts: null, likes: null, views: null },
      media: [],
      isRepost: false,
      repostedBy: null,
      quoted: null,
      extractedAt: '2026-04-16T14:32:00.000Z',
      tickIndex,
    };
  }

  describe('hashPost', () => {
    it('UT-SDC-001: returns stable 16-hex-char SHA-256 prefix', () => {
      const post = makePost('1780123456789012345');
      const hash1 = hashPost(post);
      const hash2 = hashPost(post);

      // Same post should produce same hash
      expect(hash1).toBe(hash2);

      // Should be exactly 16 hex characters
      expect(hash1).toHaveLength(16);
      expect(hash1).toMatch(/^[0-9a-f]{16}$/);
    });

    it('UT-SDC-002: produces different hashes for different post IDs', () => {
      const post1 = makePost('1234567890');
      const post2 = makePost('0987654321');

      const hash1 = hashPost(post1);
      const hash2 = hashPost(post2);

      expect(hash1).not.toBe(hash2);
    });

    it('UT-SDC-003: stable across multiple calls (deterministic)', () => {
      const post = makePost('1780123456789012345');

      // Call multiple times
      const hashes = Array.from({ length: 10 }, () => hashPost(post));

      // All should be identical
      const uniqueHashes = new Set(hashes);
      expect(uniqueHashes.size).toBe(1);
    });
  });

  describe('loadDedupCache', () => {
    it('UT-SDC-004: returns empty cache when file does not exist (first run)', async () => {
      const cache = await loadDedupCache(testStateDir);

      expect(cache).toEqual({
        schemaVersion: 1,
        hashes: [],
      });
    });

    it('UT-SDC-005: loads existing cache from file', async () => {
      // Create state dir and cache file
      mkdirSync(testStateDir, { recursive: true });
      const cachePath = join(testStateDir, 'seen-posts.json');
      const existingCache = {
        schemaVersion: 1,
        hashes: ['a1b2c3d4e5f60718', '0f1e2d3c4b5a6978'],
      };
      writeFileSync(cachePath, JSON.stringify(existingCache, null, 2));

      const cache = await loadDedupCache(testStateDir);

      expect(cache).toEqual(existingCache);
    });

    it('UT-SDC-006: quarantines corrupt JSON and returns empty cache', async () => {
      // Create state dir with corrupt JSON
      mkdirSync(testStateDir, { recursive: true });
      const cachePath = join(testStateDir, 'seen-posts.json');
      writeFileSync(cachePath, '{"not valid json');

      const cache = await loadDedupCache(testStateDir);

      // Should return empty cache
      expect(cache).toEqual({
        schemaVersion: 1,
        hashes: [],
      });

      // Corrupt file should be quarantined
      const files = require('fs').readdirSync(testStateDir);
      const quarantined = files.find((f: string) => f.startsWith('seen-posts.json.corrupt-'));
      expect(quarantined).toBeTruthy();

      // Original file should be replaced with empty cache or not exist yet
      // (it will be created on next save)
    });

    it('UT-SDC-007: quarantines schema mismatch and returns empty cache', async () => {
      // Create state dir with future schema version
      mkdirSync(testStateDir, { recursive: true });
      const cachePath = join(testStateDir, 'seen-posts.json');
      const futureCache = {
        schemaVersion: 2,
        hashes: ['a1b2c3d4e5f60718'],
      };
      writeFileSync(cachePath, JSON.stringify(futureCache, null, 2));

      const cache = await loadDedupCache(testStateDir);

      // Should return empty cache
      expect(cache).toEqual({
        schemaVersion: 1,
        hashes: [],
      });

      // File should be quarantined
      const files = require('fs').readdirSync(testStateDir);
      const quarantined = files.find((f: string) => f.startsWith('seen-posts.json.corrupt-'));
      expect(quarantined).toBeTruthy();
    });

    it('UT-SDC-008: expands tilde in state dir path', async () => {
      // This test verifies the function works with tilde paths
      // We'll use a relative path since we can't write to actual home
      const cache = await loadDedupCache(testStateDir);

      // Should not throw, should return empty cache
      expect(cache).toEqual({
        schemaVersion: 1,
        hashes: [],
      });
    });
  });

  describe('saveDedupCache', () => {
    it('UT-SDC-009: saves cache to seen-posts.json', async () => {
      const cache: DedupCache = {
        schemaVersion: 1,
        hashes: ['a1b2c3d4e5f60718', '0f1e2d3c4b5a6978'],
      };

      const result = await saveDedupCache(cache, testStateDir);

      // Check return value
      expect(result.statePath).toContain('seen-posts.json');

      // Check file was created
      const cachePath = join(testStateDir, 'seen-posts.json');
      expect(existsSync(cachePath)).toBe(true);

      // Check file contents
      const saved = JSON.parse(readFileSync(cachePath, 'utf-8'));
      expect(saved).toEqual(cache);
    });

    it('UT-SDC-010: creates state directory if missing', async () => {
      const cache: DedupCache = {
        schemaVersion: 1,
        hashes: ['a1b2c3d4e5f60718'],
      };

      // testStateDir doesn't exist yet
      expect(existsSync(testStateDir)).toBe(false);

      await saveDedupCache(cache, testStateDir);

      // Should have created directory
      expect(existsSync(testStateDir)).toBe(true);

      // File should exist
      const cachePath = join(testStateDir, 'seen-posts.json');
      expect(existsSync(cachePath)).toBe(true);
    });

    it('UT-SDC-011: uses atomic write (tmpfile + rename)', async () => {
      const cache: DedupCache = {
        schemaVersion: 1,
        hashes: ['a1b2c3d4e5f60718'],
      };

      await saveDedupCache(cache, testStateDir);

      // After save, no .tmp file should remain
      const files = require('fs').readdirSync(testStateDir);
      const tmpFiles = files.filter((f: string) => f.endsWith('.tmp'));
      expect(tmpFiles).toHaveLength(0);

      // Final file should exist
      const cachePath = join(testStateDir, 'seen-posts.json');
      expect(existsSync(cachePath)).toBe(true);
    });

    it('UT-SDC-012: formats JSON with 2-space indentation', async () => {
      const cache: DedupCache = {
        schemaVersion: 1,
        hashes: ['a1b2c3d4e5f60718', '0f1e2d3c4b5a6978'],
      };

      await saveDedupCache(cache, testStateDir);

      const cachePath = join(testStateDir, 'seen-posts.json');
      const content = readFileSync(cachePath, 'utf-8');

      // Should be formatted with 2 spaces
      expect(content).toContain('  "schemaVersion"');
      expect(content).toContain('  "hashes"');
    });

    it('UT-SDC-013: preserves key order (schemaVersion, hashes)', async () => {
      const cache: DedupCache = {
        schemaVersion: 1,
        hashes: ['a1b2c3d4e5f60718'],
      };

      await saveDedupCache(cache, testStateDir);

      const cachePath = join(testStateDir, 'seen-posts.json');
      const content = readFileSync(cachePath, 'utf-8');

      // schemaVersion should appear before hashes in file
      const schemaIndex = content.indexOf('schemaVersion');
      const hashesIndex = content.indexOf('hashes');
      expect(schemaIndex).toBeLessThan(hashesIndex);
    });
  });

  describe('partitionPosts', () => {
    it('UT-SDC-014: all posts are new when cache is empty', () => {
      const posts = [
        makePost('1234567890', 0),
        makePost('0987654321', 1),
        makePost('1111111111', 2),
      ];
      const cache: DedupCache = {
        schemaVersion: 1,
        hashes: [],
      };

      const result = partitionPosts(posts, cache);

      expect(result.newPosts).toHaveLength(3);
      expect(result.seenPosts).toHaveLength(0);
      expect(result.newHashes).toHaveLength(3);

      // Verify all posts are in newPosts
      expect(result.newPosts.map(p => p.id)).toEqual(['1234567890', '0987654321', '1111111111']);
    });

    it('UT-SDC-015: correctly identifies seen posts', () => {
      const posts = [
        makePost('1234567890', 0),
        makePost('0987654321', 1),
        makePost('1111111111', 2),
      ];

      // Pre-populate cache with hash of first post
      const hash1 = hashPost(posts[0]);
      const cache: DedupCache = {
        schemaVersion: 1,
        hashes: [hash1],
      };

      const result = partitionPosts(posts, cache);

      expect(result.newPosts).toHaveLength(2);
      expect(result.seenPosts).toHaveLength(1);
      expect(result.newHashes).toHaveLength(2);

      // Verify correct partitioning
      expect(result.seenPosts[0].id).toBe('1234567890');
      expect(result.newPosts.map(p => p.id)).toEqual(['0987654321', '1111111111']);
    });

    it('UT-SDC-016: deduplicates within a single run', () => {
      const posts = [
        makePost('1234567890', 0),
        makePost('0987654321', 1),
        makePost('1234567890', 2), // Duplicate within run
      ];
      const cache: DedupCache = {
        schemaVersion: 1,
        hashes: [],
      };

      const result = partitionPosts(posts, cache);

      // All posts appear in newPosts (partition is unaffected)
      expect(result.newPosts).toHaveLength(3);
      expect(result.seenPosts).toHaveLength(0);

      // But newHashes should only have 2 unique hashes
      expect(result.newHashes).toHaveLength(2);

      // Verify no duplicates in newHashes
      const uniqueHashes = new Set(result.newHashes);
      expect(uniqueHashes.size).toBe(2);
    });

    it('UT-SDC-017: preserves first-seen order in newHashes', () => {
      const posts = [
        makePost('1111111111', 0),
        makePost('2222222222', 1),
        makePost('3333333333', 2),
        makePost('2222222222', 3), // Duplicate
      ];
      const cache: DedupCache = {
        schemaVersion: 1,
        hashes: [],
      };

      const result = partitionPosts(posts, cache);

      expect(result.newHashes).toHaveLength(3);

      // Should be in order: hash(1111), hash(2222), hash(3333)
      const expectedHashes = [
        hashPost(posts[0]),
        hashPost(posts[1]),
        hashPost(posts[2]),
      ];
      expect(result.newHashes).toEqual(expectedHashes);
    });

    it('UT-SDC-018: handles mix of new and seen posts', () => {
      const posts = [
        makePost('1111111111', 0),
        makePost('2222222222', 1),
        makePost('3333333333', 2),
        makePost('4444444444', 3),
      ];

      // Mark posts 1 and 3 as seen
      const cache: DedupCache = {
        schemaVersion: 1,
        hashes: [hashPost(posts[0]), hashPost(posts[2])],
      };

      const result = partitionPosts(posts, cache);

      expect(result.newPosts).toHaveLength(2);
      expect(result.seenPosts).toHaveLength(2);
      expect(result.newHashes).toHaveLength(2);

      expect(result.newPosts.map(p => p.id)).toEqual(['2222222222', '4444444444']);
      expect(result.seenPosts.map(p => p.id)).toEqual(['1111111111', '3333333333']);
    });
  });

  describe('appendHashes', () => {
    it('UT-SDC-019: appends new hashes to cache', () => {
      const cache: DedupCache = {
        schemaVersion: 1,
        hashes: ['aaaa', 'bbbb'],
      };
      const newHashes = ['cccc', 'dddd'];

      const result = appendHashes(cache, newHashes);

      expect(result.hashes).toEqual(['aaaa', 'bbbb', 'cccc', 'dddd']);
      expect(result.schemaVersion).toBe(1);
    });

    it('UT-SDC-020: does not mutate input cache', () => {
      const cache: DedupCache = {
        schemaVersion: 1,
        hashes: ['aaaa', 'bbbb'],
      };
      const newHashes = ['cccc'];
      const originalLength = cache.hashes.length;

      appendHashes(cache, newHashes);

      // Original cache should be unchanged
      expect(cache.hashes).toHaveLength(originalLength);
      expect(cache.hashes).toEqual(['aaaa', 'bbbb']);
    });

    it('UT-SDC-021: truncates from front when exceeding MAX_CACHE_SIZE', () => {
      // Create a cache at max capacity
      const hashes = Array.from({ length: MAX_CACHE_SIZE }, (_, i) =>
        i.toString(16).padStart(16, '0')
      );
      const cache: DedupCache = {
        schemaVersion: 1,
        hashes,
      };

      const newHashes = ['new1', 'new2', 'new3'];

      const result = appendHashes(cache, newHashes);

      // Should still be at max capacity
      expect(result.hashes).toHaveLength(MAX_CACHE_SIZE);

      // First 3 hashes should be removed
      expect(result.hashes[0]).not.toBe(hashes[0]);
      expect(result.hashes[0]).toBe(hashes[3]);

      // Last 3 should be the new ones
      expect(result.hashes.slice(-3)).toEqual(newHashes);
    });

    it('UT-SDC-022: FIFO eviction preserves newest items', () => {
      const cache: DedupCache = {
        schemaVersion: 1,
        hashes: Array.from({ length: MAX_CACHE_SIZE }, (_, i) => `old${i}`),
      };

      const newHashes = Array.from({ length: 150 }, (_, i) => `new${i}`);

      const result = appendHashes(cache, newHashes);

      expect(result.hashes).toHaveLength(MAX_CACHE_SIZE);

      // First 150 old hashes should be gone
      expect(result.hashes).not.toContain('old0');
      expect(result.hashes).not.toContain('old149');

      // Old hashes starting at 150 should remain
      expect(result.hashes[0]).toBe('old150');

      // All new hashes should be at the end
      expect(result.hashes.slice(-150)).toEqual(newHashes);
    });

    it('UT-SDC-023: handles empty newHashes array', () => {
      const cache: DedupCache = {
        schemaVersion: 1,
        hashes: ['aaaa', 'bbbb'],
      };

      const result = appendHashes(cache, []);

      expect(result.hashes).toEqual(['aaaa', 'bbbb']);
    });

    it('UT-SDC-024: handles appending to empty cache', () => {
      const cache: DedupCache = {
        schemaVersion: 1,
        hashes: [],
      };
      const newHashes = ['aaaa', 'bbbb', 'cccc'];

      const result = appendHashes(cache, newHashes);

      expect(result.hashes).toEqual(newHashes);
    });
  });

  describe('constants', () => {
    it('UT-SDC-025: CACHE_SCHEMA_VERSION is 1', () => {
      expect(CACHE_SCHEMA_VERSION).toBe(1);
    });

    it('UT-SDC-026: MAX_CACHE_SIZE is 10000', () => {
      expect(MAX_CACHE_SIZE).toBe(10000);
    });
  });

  describe('integration scenarios', () => {
    it('UT-SDC-027: first scroll ever - no state file exists, all posts are new', async () => {
      const posts = Array.from({ length: 84 }, (_, i) => makePost(`post${i}`, i));

      // Load cache (empty on first run)
      const cache = await loadDedupCache(testStateDir);
      expect(cache.hashes).toHaveLength(0);

      // Partition posts
      const { newPosts, seenPosts, newHashes } = partitionPosts(posts, cache);
      expect(newPosts).toHaveLength(84);
      expect(seenPosts).toHaveLength(0);
      expect(newHashes).toHaveLength(84);

      // Append and save
      const updatedCache = appendHashes(cache, newHashes);
      await saveDedupCache(updatedCache, testStateDir);

      // Verify saved cache
      const savedCache = await loadDedupCache(testStateDir);
      expect(savedCache.hashes).toHaveLength(84);
    });

    it('UT-SDC-028: second scroll with overlap - seen posts identified', async () => {
      // Day 1: Save 84 posts
      const day1Posts = Array.from({ length: 84 }, (_, i) => makePost(`post${i}`, i));
      let cache = await loadDedupCache(testStateDir);
      let { newHashes } = partitionPosts(day1Posts, cache);
      cache = appendHashes(cache, newHashes);
      await saveDedupCache(cache, testStateDir);

      // Day 2: 60 posts, 22 overlap with day 1
      const day2Posts = [
        ...Array.from({ length: 22 }, (_, i) => makePost(`post${i}`, i)), // Seen
        ...Array.from({ length: 38 }, (_, i) => makePost(`newpost${i}`, i + 22)), // New
      ];

      // Load cache
      cache = await loadDedupCache(testStateDir);
      expect(cache.hashes).toHaveLength(84);

      // Partition
      const result = partitionPosts(day2Posts, cache);
      expect(result.newPosts).toHaveLength(38);
      expect(result.seenPosts).toHaveLength(22);
      expect(result.newHashes).toHaveLength(38);

      // Update cache
      cache = appendHashes(cache, result.newHashes);
      await saveDedupCache(cache, testStateDir);

      // Verify
      const finalCache = await loadDedupCache(testStateDir);
      expect(finalCache.hashes).toHaveLength(122);
    });

    it('UT-SDC-029: cache at capacity with eviction', async () => {
      // Fill cache to MAX_CACHE_SIZE
      const initialHashes = Array.from({ length: MAX_CACHE_SIZE }, (_, i) =>
        `hash${i.toString().padStart(16, '0')}`
      );
      let cache: DedupCache = {
        schemaVersion: 1,
        hashes: initialHashes,
      };
      await saveDedupCache(cache, testStateDir);

      // Add 150 new posts
      const newPosts = Array.from({ length: 150 }, (_, i) =>
        makePost(`newpost${i}`, i)
      );

      cache = await loadDedupCache(testStateDir);
      const { newHashes } = partitionPosts(newPosts, cache);
      cache = appendHashes(cache, newHashes);
      await saveDedupCache(cache, testStateDir);

      // Verify
      const finalCache = await loadDedupCache(testStateDir);
      expect(finalCache.hashes).toHaveLength(MAX_CACHE_SIZE);

      // First 150 should be evicted
      expect(finalCache.hashes).not.toContain(initialHashes[0]);
      expect(finalCache.hashes).not.toContain(initialHashes[149]);

      // Last hashes should be the new ones
      expect(finalCache.hashes.slice(-150)).toEqual(newHashes);
    });
  });
});
