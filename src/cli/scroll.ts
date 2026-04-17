import type { Config } from '../config/schema.js';
import { runScroll, expandHomeDir, type ScrollResult } from '../scroll/scroller.js';
import { createExtractor } from '../extract/extractor.js';

export interface ScrollFlags {
  minutes?: number;
  dryRun?: boolean;
}

// Exit codes
const EXIT_SUCCESS = 0;
const EXIT_ERROR = 1;

/**
 * Handle the scroll command.
 *
 * Launches the persistent Chromium context and scrolls x.com/home
 * with jittered mouse wheel ticks for the budgeted time.
 */
export async function handleScroll(config: Config, flags: ScrollFlags): Promise<void> {
  const effectiveMinutes = flags.minutes ?? config.scroll.minutes;
  const resolvedUserDataDir = expandHomeDir(config.browser.userDataDir);

  // Print startup line
  console.log(`scrolling x.com for ${effectiveMinutes}m (persistent context: ${resolvedUserDataDir})`);

  // Create extractor instance
  const extractor = createExtractor();

  // Run the scroll
  const result: ScrollResult = await runScroll({
    userDataDir: config.browser.userDataDir,
    headless: config.browser.headless,
    viewport: config.browser.viewport,
    budgetMinutes: effectiveMinutes,
    jitterMs: config.scroll.jitterMs,
    longPauseEvery: config.scroll.longPauseEvery,
    longPauseMs: config.scroll.longPauseMs,
    dryRun: flags.dryRun ?? false,
    onTick: extractor.onTick,
  });

  // Handle result
  if (result.status === 'session_expired') {
    console.log('session expired — run pnpm login to refresh, then pnpm scroll');
    process.exit(EXIT_ERROR);
  }

  if (result.status === 'error') {
    console.error(result.error);
    process.exit(EXIT_ERROR);
  }

  if (result.status === 'browser_closed') {
    console.log(`scroll ended early after ${result.tickCount} ticks (browser closed)`);
    process.exit(EXIT_ERROR);
  }

  // Completed successfully - get extraction stats
  const stats = extractor.getStats();
  const postsExtracted = stats.postsExtracted;
  const adsSkipped = stats.adsSkipped;
  const elapsedSec = Math.round(result.elapsedMs / 1000);

  if (flags.dryRun) {
    console.log(
      `dry-run complete: ${result.tickCount} ticks over ${elapsedSec}s — ${postsExtracted} posts extracted (${adsSkipped} ads skipped), writer skipped`
    );
  } else {
    console.log(
      `scroll complete: ${result.tickCount} ticks over ${elapsedSec}s — ${postsExtracted} posts extracted (${adsSkipped} ads skipped)`
    );
  }

  process.exit(EXIT_SUCCESS);
}
