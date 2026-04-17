import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { chromium } from 'playwright';
import type { BrowserContext, Page } from 'playwright';

/**
 * Scroll operation result.
 */
export interface ScrollResult {
  status: 'completed' | 'session_expired' | 'browser_closed' | 'error';
  tickCount: number;
  elapsedMs: number;
  finalUrl?: string;
  error?: string;
}

/**
 * Context passed to tick hook callback.
 */
export interface TickHookContext {
  page: Page;
  tickIndex: number;
  elapsedMs: number;
}

/**
 * Options for runScroll().
 */
export interface ScrollOptions {
  userDataDir: string;
  headless: boolean;
  viewport: { width: number; height: number };
  budgetMinutes: number;
  jitterMs: [number, number];
  longPauseEvery: number;
  longPauseMs: [number, number];
  dryRun: boolean;
  onTick?: (ctx: TickHookContext) => Promise<void>;
  rng?: () => number; // For testing - seedable RNG
}

// Constants
const X_HOME_URL = 'https://x.com/home';
const SCROLL_DELTA_MIN = 400;
const SCROLL_DELTA_MAX = 1200;

/**
 * Expand ~ in a path to the user's home directory.
 */
export function expandHomeDir(path: string): string {
  if (path.startsWith('~/')) {
    return join(homedir(), path.slice(2));
  }
  if (path === '~') {
    return homedir();
  }
  return path;
}

/**
 * Generate a random integer in range [min, max].
 */
function randomInRange(min: number, max: number, rng: () => number = Math.random): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}

/**
 * Sleep for a given number of milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Check if the page URL indicates a logged-in session.
 */
function isLoggedIn(url: string): boolean {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname;

    // Not logged in if redirected to login pages
    if (path === '/login' || path.startsWith('/i/flow/login')) {
      return false;
    }

    // Logged in if we stayed on /home or any other x.com page
    return parsed.hostname.includes('x.com') && path !== '/';
  } catch {
    return false;
  }
}

/**
 * Run the scroll operation.
 *
 * Launches a persistent Chromium context, navigates to x.com/home,
 * and scrolls with jittered mouse wheel ticks for the budgeted time.
 *
 * Returns a ScrollResult describing what happened.
 */
export async function runScroll(options: ScrollOptions): Promise<ScrollResult> {
  const {
    userDataDir,
    headless,
    viewport,
    budgetMinutes,
    jitterMs,
    longPauseEvery,
    longPauseMs,
    dryRun,
    onTick,
    rng = Math.random,
  } = options;

  // Expand tilde in path
  const resolvedUserDataDir = expandHomeDir(userDataDir);

  // Check if user-data dir exists
  if (!existsSync(resolvedUserDataDir)) {
    return {
      status: 'error',
      tickCount: 0,
      elapsedMs: 0,
      error: `no Chromium profile found at ${resolvedUserDataDir} — run pnpm login first`,
    };
  }

  let context: BrowserContext | null = null;
  let page: Page | null = null;
  let tickCount = 0;
  const startTime = Date.now();
  let browserClosed = false;

  try {
    // Launch persistent context
    context = await chromium.launchPersistentContext(resolvedUserDataDir, {
      headless,
      viewport,
    });

    // Set up close handler
    context.on('close', () => {
      browserClosed = true;
    });

    // Get or create the first page
    const pages = context.pages();
    page = pages.length > 0 ? pages[0] : await context.newPage();

    // Navigate to X home
    await page.goto(X_HOME_URL);

    // Check if logged in
    const currentUrl = page.url();
    if (!isLoggedIn(currentUrl)) {
      await context.close();
      return {
        status: 'session_expired',
        tickCount: 0,
        elapsedMs: Date.now() - startTime,
        finalUrl: currentUrl,
      };
    }

    // Calculate budget in milliseconds
    const budgetMs = budgetMinutes * 60 * 1000;

    // Scroll loop
    while (true) {
      const elapsed = Date.now() - startTime;

      // Check if budget expired
      if (elapsed >= budgetMs) {
        break;
      }

      // Check if browser closed
      if (browserClosed || page.isClosed()) {
        return {
          status: 'browser_closed',
          tickCount,
          elapsedMs: Date.now() - startTime,
          finalUrl: page.url(),
        };
      }

      // Generate jittered scroll delta
      const scrollDelta = randomInRange(SCROLL_DELTA_MIN, SCROLL_DELTA_MAX, rng);

      // Perform mouse wheel scroll
      await page.mouse.wheel(0, scrollDelta);
      tickCount++;

      // Call tick hook if provided
      if (onTick) {
        try {
          await onTick({
            page,
            tickIndex: tickCount - 1, // 0-indexed
            elapsedMs: Date.now() - startTime,
          });
        } catch (error: any) {
          // Log error but continue scrolling
          console.log(`tick ${tickCount - 1} hook error: ${error.message}`);
        }
      }

      // Determine pause duration
      let pauseMs: number;
      if (tickCount % longPauseEvery === 0) {
        // Long pause (simulating reading)
        pauseMs = randomInRange(longPauseMs[0], longPauseMs[1], rng);
      } else {
        // Normal jitter pause
        pauseMs = randomInRange(jitterMs[0], jitterMs[1], rng);
      }

      // Sleep before next tick
      await sleep(pauseMs);
    }

    // Close context
    await context.close();

    return {
      status: 'completed',
      tickCount,
      elapsedMs: Date.now() - startTime,
      finalUrl: page.url(),
    };

  } catch (error: any) {
    // Handle Playwright errors
    if (error.message && error.message.includes("Executable doesn't exist")) {
      return {
        status: 'error',
        tickCount,
        elapsedMs: Date.now() - startTime,
        error: 'playwright chromium not installed — run: pnpm exec playwright install chromium',
      };
    }

    // Re-throw unexpected errors
    throw error;

  } finally {
    // Clean up context if not already closed
    if (context && !browserClosed) {
      try {
        await context.close();
      } catch {
        // Context may already be closed
      }
    }
  }
}
