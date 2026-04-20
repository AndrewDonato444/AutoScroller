import { z } from 'zod';

/**
 * Zod schema for ScrollProxy configuration.
 *
 * Strict mode: unknown fields are rejected to prevent anti-persona creep
 * (analytics, OAuth, telemetry, etc.).
 */
export const configSchema = z.object({
  // scroll + browser sections are vestigial from the pre-April-2026 Playwright
  // era. They are accepted but unused; operator configs that still contain them
  // continue to validate. New configs should omit them.
  scroll: z.object({
    minutes: z.number().optional(),
    jitterMs: z.tuple([z.number(), z.number()]).optional(),
    longPauseEvery: z.number().optional(),
    longPauseMs: z.tuple([z.number(), z.number()]).optional(),
  }).optional(),

  browser: z.object({
    userDataDir: z.string().optional(),
    headless: z.boolean().optional(),
    channel: z.enum(['chrome', 'chrome-beta', 'msedge']).optional(),
    cdpEndpoint: z.string().url().optional(),
    viewport: z.object({
      width: z.number(),
      height: z.number(),
    }).optional(),
  }).optional(),

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

  // extractor section is vestigial from the Playwright era (vision fallback
  // used Chrome screenshots). Accepted but unused.
  extractor: z.object({
    visionFallback: z.object({
      enabled: z.boolean().optional(),
      minPosts: z.number().optional(),
      maxSelectorFailureRatio: z.number().optional(),
      screenshotEveryTicks: z.number().optional(),
      maxScreenshotsPerRun: z.number().optional(),
    }).optional(),
  }).optional(),

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
