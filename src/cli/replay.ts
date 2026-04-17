import type { Config } from '../config/schema.js';

/**
 * Handle the replay command.
 *
 * This is a stub that will be wired up in feature 14.
 */
export async function handleReplay(_config: Config, runId: string): Promise<void> {
  console.log(`scrollproxy replay ${runId} — not yet wired (feature 14)`);
}
