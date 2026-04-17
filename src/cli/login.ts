import { existsSync, mkdirSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { chromium } from 'playwright';
import type { BrowserContext } from 'playwright';
import type { Config } from '../config/schema.js';

// Exit codes
const EXIT_SUCCESS = 0;
const EXIT_ERROR = 1;
const EXIT_USAGE_ERROR = 2;

// Constants
const X_LOGIN_URL = 'https://x.com/login';

/**
 * Expand ~ in a path to the user's home directory.
 */
function expandHomeDir(path: string): string {
  if (path.startsWith('~/')) {
    return join(homedir(), path.slice(2));
  }
  if (path === '~') {
    return homedir();
  }
  return path;
}

/**
 * Validate and prepare user data directory.
 * Creates the directory if it doesn't exist.
 * Exits with error if path exists but is not a directory.
 */
function ensureUserDataDir(userDataDir: string): void {
  if (existsSync(userDataDir)) {
    const stats = statSync(userDataDir);
    if (!stats.isDirectory()) {
      console.error(`browser.userDataDir must be a directory: ${userDataDir}`);
      process.exit(EXIT_USAGE_ERROR);
    }
  } else {
    mkdirSync(userDataDir, { recursive: true });
  }
}

/**
 * Handle the login command.
 *
 * Opens a persistent Chromium browser for manual login to X.
 * Waits for the operator to complete login and close the window.
 * Detects success based on final URL.
 */
export async function handleLogin(config: Config): Promise<void> {

  // Refuse to run headless
  if (config.browser.headless) {
    const configPath = join(homedir(), 'scrollproxy', 'config.yaml');
    console.error(`login requires browser.headless: false — edit ${configPath} and re-run`);
    process.exit(EXIT_USAGE_ERROR);
  }

  // Expand ~ in userDataDir
  const userDataDir = expandHomeDir(config.browser.userDataDir);

  // Validate and create userDataDir if needed
  ensureUserDataDir(userDataDir);

  // Print instruction
  console.log('log in to X in the open window, then close the window when done');

  let context: BrowserContext | null = null;

  try {
    // Launch persistent context.
    // Using `channel: 'chrome'` switches from Playwright's bundled Chromium
    // to the real installed Google Chrome binary, which bypasses Google's
    // OAuth bot detection ("Couldn't sign you in — this browser may not be secure").
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      channel: config.browser.channel,
      viewport: config.browser.viewport,
    });

    // Get the first page or create one
    const pages = context.pages();
    const page = pages.length > 0 ? pages[0] : await context.newPage();

    // Navigate to X login page
    await page.goto(X_LOGIN_URL);

    // Wait for context to close (operator closes the window)
    await new Promise<void>((resolve) => {
      context!.on('close', () => {
        resolve();
      });
    });

    // Get final URL from the last active page before close
    const finalUrl = page.url();

    // Detect if login was successful
    const isLoggedIn = isLoginSuccessful(finalUrl);

    if (isLoggedIn) {
      console.log(`login saved to ${userDataDir} — you can now run pnpm scroll`);
      process.exit(EXIT_SUCCESS);
    } else {
      const urlPath = new URL(finalUrl).pathname;
      console.log(`login not completed — final URL was x.com${urlPath}. Run pnpm login again.`);
      process.exit(EXIT_ERROR);
    }

  } catch (error: any) {
    // Handle Playwright errors
    if (error.message && error.message.includes('Executable doesn\'t exist')) {
      console.error('playwright chromium not installed — run: pnpm exec playwright install chromium');
      process.exit(EXIT_ERROR);
    }

    // Re-throw other errors
    throw error;
  } finally {
    // Clean up context if it wasn't already closed
    if (context) {
      try {
        await context.close();
      } catch {
        // Context may already be closed
      }
    }
  }
}

/**
 * Determine if the final URL indicates a successful login.
 *
 * Success: x.com/home, x.com/{handle}, or any x.com/* except login pages
 * Failure: x.com/login, x.com/i/flow/*, x.com/ (root)
 */
function isLoginSuccessful(url: string): boolean {
  try {
    const parsedUrl = new URL(url);
    const path = parsedUrl.pathname;

    // Failure cases
    if (path === '/login' || path === '/' || path.startsWith('/i/flow')) {
      return false;
    }

    // Success: any other x.com path
    return parsedUrl.hostname.includes('x.com');
  } catch {
    return false;
  }
}
