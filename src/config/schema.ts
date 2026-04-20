import { z } from 'zod';

/**
 * Zod schema for ScrollProxy configuration.
 *
 * Strict mode: unknown fields are rejected to prevent anti-persona creep
 * (analytics, OAuth, telemetry, etc.).
 */
export const configSchema = z.object({
  scroll: z.object({
    minutes: z.number().min(1, 'scroll.minutes must be >= 1').max(120, 'scroll.minutes must be <= 120'),
    jitterMs: z.tuple([z.number(), z.number()]).default([400, 1400]),
    longPauseEvery: z.number().default(25),
    longPauseMs: z.tuple([z.number(), z.number()]).default([3000, 8000]),
  }),

  browser: z.object({
    userDataDir: z.string(),
    headless: z.boolean(),
    // Use installed Chrome/Edge instead of Playwright's bundled Chromium.
    channel: z.enum(['chrome', 'chrome-beta', 'msedge']).optional(),
    // CDP endpoint of a user-launched Chrome (e.g. http://localhost:9222).
    // When set, ScrollProxy ATTACHES to that Chrome instead of launching its own.
    // This is the only reliable way past Google's bot detection — Chrome doesn't
    // know it's being automated because YOU launched it, not Playwright.
    // Launch Chrome with: --remote-debugging-port=9222 --user-data-dir=<path>
    cdpEndpoint: z.string().url().optional(),
    viewport: z.object({
      width: z.number(),
      height: z.number(),
    }),
  }),

  interests: z.array(z.string()).default([]),

  output: z.object({
    dir: z.string(),
    state: z.string(),
    destinations: z.array(z.enum(['markdown', 'notion'])).default(['markdown']),
  }),

  notion: z.object({
    token: z.string().optional(),
    parentPageId: z.string(),
  }).optional(),

  claude: z.object({
    model: z.string(),
    apiKey: z.string().optional(),
  }),

  extractor: z.object({
    visionFallback: z.object({
      enabled: z.boolean().default(true),
      minPosts: z.number().min(0).default(20),
      maxSelectorFailureRatio: z.number().min(0).max(1).default(0.3),
      screenshotEveryTicks: z.number().min(1).default(5),
      maxScreenshotsPerRun: z.number().min(1).default(24),
    }).default({
      enabled: true,
      minPosts: 20,
      maxSelectorFailureRatio: 0.3,
      screenshotEveryTicks: 5,
      maxScreenshotsPerRun: 24,
    }),
  }).default({
    visionFallback: {
      enabled: true,
      minPosts: 20,
      maxSelectorFailureRatio: 0.3,
      screenshotEveryTicks: 5,
      maxScreenshotsPerRun: 24,
    },
  }),

  // X API source layer (April 2026 migration to Owned Reads). Optional so
  // existing Playwright-only configs continue to validate. When present,
  // enables `--source x-api` mode in the CLI.
  x: z.object({
    baseUrl: z.string().url().default('https://api.x.com/2'),
    lists: z.array(z.object({
      id: z.string(),
      name: z.string(),
      tag: z.string(),
      postsPerRun: z.number().min(1).default(50),
      note: z.string().optional(),
    })).default([]),
    bookmarks: z.object({
      enabled: z.boolean().default(false),
      postsPerRun: z.number().min(1).default(25),
    }).default({
      enabled: false,
      postsPerRun: 25,
    }),
  }).optional(),
}).strict(); // Reject unknown fields

export type Config = z.infer<typeof configSchema>;
