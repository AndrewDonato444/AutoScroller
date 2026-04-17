/**
 * Default configuration values for ScrollProxy.
 *
 * Written to ~/scrollproxy/config.yaml on first run.
 */
export const defaultConfig = {
  scroll: {
    minutes: 10,
    jitterMs: [400, 1400],
    longPauseEvery: 25,
    longPauseMs: [3000, 8000],
  },

  browser: {
    userDataDir: '~/scrollproxy/chrome',
    headless: false,
    channel: 'chrome' as const,
    viewport: {
      width: 1280,
      height: 900,
    },
  },

  interests: [] as string[],

  output: {
    dir: '~/scrollproxy/runs',
    state: '~/scrollproxy/state',
    destinations: ['markdown'] as const,
  },

  claude: {
    model: 'claude-sonnet-4-6',
    apiKey: undefined,
  },

  extractor: {
    visionFallback: {
      enabled: true,
      minPosts: 20,
      maxSelectorFailureRatio: 0.3,
      screenshotEveryTicks: 5,
      maxScreenshotsPerRun: 24,
    },
  },
};

/**
 * Default config file content (YAML with comments).
 */
export const defaultConfigYaml = `# ScrollProxy Configuration
# Edit values below and re-run 'pnpm scroll'

# How long to scroll and how to simulate human-like behavior
scroll:
  minutes: 10              # Duration to scroll (1-120)
  jitterMs: [400, 1400]    # Min/max pause between scroll ticks
  longPauseEvery: 25       # Take a long pause every N ticks
  longPauseMs: [3000, 8000] # Duration of long pauses

# Browser settings for Playwright
browser:
  userDataDir: ~/scrollproxy/chrome  # Chrome profile directory
  headless: false          # Must be false for login run
  channel: chrome          # Use real Chrome binary (chrome|chrome-beta|msedge). Bypasses Google's "insecure browser" OAuth block.
  viewport:
    width: 1280
    height: 900

# Topics to nudge the Claude summarizer toward
interests:
  - AI product strategy
  - distribution and indie dev
  - sales enablement

# Where to write outputs
output:
  dir: ~/scrollproxy/runs   # Run outputs (JSON, markdown)
  state: ~/scrollproxy/state # State tracking
  destinations: [markdown]  # Output destinations: markdown, notion

# Notion integration (optional — only needed if 'notion' is in destinations)
# notion:
#   parentPageId: your-page-id-here  # Notion page UUID
#   # token: secret_...  # Optional; uses NOTION_TOKEN env var if not set

# Claude API settings
claude:
  model: claude-sonnet-4-6
  # apiKey: null  # Optional; uses ANTHROPIC_API_KEY env var if not set

# Extractor settings
extractor:
  visionFallback:
    enabled: true                 # Enable vision fallback rescue
    minPosts: 20                  # Trigger if post count < this
    maxSelectorFailureRatio: 0.3  # Trigger if failure ratio > this
    screenshotEveryTicks: 5       # Capture screenshot every N ticks
    maxScreenshotsPerRun: 24      # Max screenshots to send to vision API
`;
