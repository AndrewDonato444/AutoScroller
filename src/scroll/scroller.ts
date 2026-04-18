import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { mkdir, writeFile } from 'fs/promises';
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
  channel?: 'chrome' | 'chrome-beta' | 'msedge';
  cdpEndpoint?: string;
  viewport: { width: number; height: number };
  budgetMinutes: number;
  jitterMs: [number, number];
  longPauseEvery: number;
  longPauseMs: [number, number];
  dryRun: boolean;
  onTick?: (ctx: TickHookContext) => Promise<void>;
  rng?: () => number; // For testing - seedable RNG
  screenshotDir?: string; // Directory to save screenshots
  screenshotEveryTicks?: number; // Capture screenshot every N ticks (0 to disable)
}

// Constants
const X_HOME_URL = 'https://x.com/home';
const SCROLL_DELTA_MIN = 400;
const SCROLL_DELTA_MAX = 1200;
const MS_PER_MINUTE = 60 * 1000;

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
 * Calculate pause duration based on tick count (normal vs long pause).
 */
function calculatePauseDuration(
  tickCount: number,
  longPauseEvery: number,
  jitterMs: [number, number],
  longPauseMs: [number, number],
  rng: () => number
): number {
  if (tickCount % longPauseEvery === 0) {
    // Long pause (simulating reading)
    return randomInRange(longPauseMs[0], longPauseMs[1], rng);
  }
  // Normal jitter pause
  return randomInRange(jitterMs[0], jitterMs[1], rng);
}

/**
 * Invoke the tick hook callback with error handling.
 */
async function invokeTickHook(
  onTick: ((ctx: TickHookContext) => Promise<void>) | undefined,
  context: TickHookContext
): Promise<void> {
  if (!onTick) {
    return;
  }

  try {
    await onTick(context);
  } catch (error: any) {
    // Log error but continue scrolling
    console.log(`tick ${context.tickIndex} hook error: ${error.message}`);
  }
}

/**
 * Capture a screenshot of the page and save to disk.
 * Runs in background with error handling.
 */
async function captureScreenshot(
  page: Page,
  screenshotDir: string,
  tickIndex: number
): Promise<void> {
  try {
    // Ensure screenshot directory exists
    await mkdir(screenshotDir, { recursive: true });

    // Generate filename with zero-padded tick index
    const filename = `tick-${tickIndex.toString().padStart(5, '0')}.png`;
    const screenshotPath = join(screenshotDir, filename);

    // Take full-page screenshot
    const screenshot = await page.screenshot({ fullPage: true });

    // Write to disk (fire-and-forget, no await to avoid blocking scroll)
    writeFile(screenshotPath, screenshot).catch(() => {
      // Silently ignore screenshot write errors
    });
  } catch {
    // Silently ignore screenshot capture errors
  }
}

/**
 * Initialize browser context and validate logged-in session.
 * Returns null if session is valid, or a ScrollResult error if not.
 */
async function initializeBrowserSession(
  userDataDir: string,
  headless: boolean,
  viewport: { width: number; height: number },
  startTime: number,
  channel?: 'chrome' | 'chrome-beta' | 'msedge',
  cdpEndpoint?: string
): Promise<{ context: BrowserContext; page: Page; browserClosed: boolean } | ScrollResult> {
  // Initialize browser context. Two modes:
  //   1. cdpEndpoint set: ATTACH to a user-launched Chrome (bypasses all bot detection)
  //   2. otherwise: LAUNCH our own persistent context (works for most sites, blocked by Google OAuth)
  let context: BrowserContext;
  if (cdpEndpoint) {
    const browser = await chromium.connectOverCDP(cdpEndpoint);
    const contexts = browser.contexts();
    context = contexts.length > 0 ? contexts[0] : await browser.newContext({ viewport });
  } else {
    context = await chromium.launchPersistentContext(userDataDir, {
      headless,
      channel,
      viewport,
    });
  }

  let browserClosed = false;

  // Set up close handler
  context.on('close', () => {
    browserClosed = true;
  });

  // Pick a page to scroll. Prefer an existing x.com tab if one's already open
  // (avoids the "new tab in collapsed headless-ish state" problem where CDP
  // tabs render at 0x0 and match no DOM selectors). Fall back to the first
  // tab, then to creating a new one.
  const pages = context.pages();
  let page: Page;
  const xTab = pages.find((p) => p.url().includes('x.com'));
  if (xTab) {
    page = xTab;
  } else if (pages.length > 0) {
    page = pages[0];
  } else {
    page = await context.newPage();
  }

  // Force a real viewport on the page BEFORE navigating. CDP-attached Chrome
  // sometimes gives new tabs a 0x0 or tiny viewport depending on window state,
  // which causes X's timeline to never render. setViewportSize is a no-op in
  // persistent-context mode but necessary for CDP.
  try {
    await page.setViewportSize(viewport);
  } catch {
    // setViewportSize can fail if the page is in a weird state; not fatal.
  }

  // Navigate to X home (or reload if we're already there — forces a fresh feed).
  if (page.url().includes('x.com/home')) {
    await page.reload({ waitUntil: 'domcontentloaded' });
  } else {
    await page.goto(X_HOME_URL, { waitUntil: 'domcontentloaded' });
  }

  // Give X a moment to render the timeline after DOMContentLoaded.
  // Without this, early scroll ticks can miss posts that are lazy-hydrated.
  await page.waitForTimeout(3000);

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

  return { context, page, browserClosed };
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
    channel,
    cdpEndpoint,
    viewport,
    budgetMinutes,
    jitterMs,
    longPauseEvery,
    longPauseMs,
    onTick,
    rng = Math.random,
    screenshotDir,
    screenshotEveryTicks = 0,
  } = options;

  // Expand tilde in path
  const resolvedUserDataDir = expandHomeDir(userDataDir);

  // Check if user-data dir exists (skipped when attaching over CDP)
  if (!cdpEndpoint && !existsSync(resolvedUserDataDir)) {
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
    // Initialize browser session and validate login
    const sessionResult = await initializeBrowserSession(
      resolvedUserDataDir,
      headless,
      viewport,
      startTime,
      channel,
      cdpEndpoint
    );

    // If session is invalid, return the error result
    if ('status' in sessionResult) {
      return sessionResult;
    }

    // Extract initialized session
    ({ context, page, browserClosed } = sessionResult);

    // Calculate budget in milliseconds
    const budgetMs = budgetMinutes * MS_PER_MINUTE;

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

      const currentTickIndex = tickCount - 1; // 0-indexed

      // Capture screenshot if enabled and on the right cadence
      if (screenshotDir && screenshotEveryTicks > 0 && currentTickIndex % screenshotEveryTicks === 0) {
        captureScreenshot(page, screenshotDir, currentTickIndex); // Fire-and-forget
      }

      // Call tick hook if provided
      await invokeTickHook(onTick, {
        page,
        tickIndex: currentTickIndex,
        elapsedMs: Date.now() - startTime,
      });

      // Determine pause duration and sleep
      const pauseMs = calculatePauseDuration(tickCount, longPauseEvery, jitterMs, longPauseMs, rng);
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
