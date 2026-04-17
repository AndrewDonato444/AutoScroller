import type { Config } from '../config/schema.js';

export interface ScrollFlags {
  minutes?: number;
  dryRun?: boolean;
}

/**
 * Handle the scroll command.
 *
 * This is a stub that will be wired up in features 4-7.
 * For now, it just prints what it would do.
 */
export async function handleScroll(config: Config, flags: ScrollFlags): Promise<void> {
  const effectiveMinutes = flags.minutes ?? config.scroll.minutes;

  if (flags.dryRun) {
    console.log(`scrollproxy v0.0.1 — dry-run: scroll + extract only, summarizer and writer skipped — not yet wired`);
  } else {
    // Show effective minutes to help verify config loading
    console.log(`scrollproxy v0.0.1 — scroll handler not yet wired (effective minutes: ${effectiveMinutes})`);
  }
}
