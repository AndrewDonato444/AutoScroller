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
    viewport: z.object({
      width: z.number(),
      height: z.number(),
    }),
  }),

  interests: z.array(z.string()).default([]),

  output: z.object({
    dir: z.string(),
    state: z.string(),
    format: z.literal('markdown'),
  }),

  claude: z.object({
    model: z.string(),
    apiKey: z.string().optional(),
  }),
}).strict(); // Reject unknown fields

export type Config = z.infer<typeof configSchema>;
