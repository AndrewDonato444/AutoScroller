/**
 * Resolves paths relative to the AutoScroller repo root, independent of
 * `process.cwd()`.
 *
 * Scheduled tasks (launchd, cron, scheduled-tasks MCP) routinely invoke
 * node processes from working directories that aren't the package root.
 * Anything that needs to find `.env.local`, `config.yaml`, or other
 * repo-relative files should resolve them via this helper — not via
 * `path.resolve(process.cwd(), …)`.
 *
 * Implementation: walks up from this file's location (src/lib/repoRoot.ts)
 * to the package root. If you move this file, update the `..` count.
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';

const THIS_FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(THIS_FILE), '..', '..');

/** Absolute path to the AutoScroller repo root. */
export function repoRoot(): string {
  return REPO_ROOT;
}

/**
 * Absolute path to `.env.local` at the repo root. Use this wherever code
 * previously did `path.resolve(process.cwd(), '.env.local')`.
 */
export function envLocalPath(): string {
  return path.join(REPO_ROOT, '.env.local');
}
