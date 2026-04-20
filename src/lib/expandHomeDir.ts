/**
 * Tilde-expansion helper. Converts `~` or `~/…` paths to absolute paths
 * rooted at the user's home directory. Anything else passes through
 * unchanged.
 *
 * Previously lived alongside the Playwright scroller in `src/scroll/
 * scroller.ts`. Relocated here so state/writer/replay consumers don't
 * reach into a module that no longer exists.
 */

import { join } from 'node:path';
import { homedir } from 'node:os';

export function expandHomeDir(path: string): string {
  if (path.startsWith('~/')) {
    return join(homedir(), path.slice(2));
  }
  if (path === '~') {
    return homedir();
  }
  return path;
}
