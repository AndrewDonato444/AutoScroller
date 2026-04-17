import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { parse as parseYaml } from 'yaml';
import { ZodError } from 'zod';
import { configSchema, type Config } from './schema.js';
import { defaultConfigYaml } from './defaults.js';

const CONFIG_DIR_NAME = 'scrollproxy';
const CONFIG_FILE_NAME = 'config.yaml';
const DEBUG_ENV_VAR = 'scrollproxy';

interface LoadConfigOptions {
  path?: string;
  homeDir?: string;
  repoRoot?: string;
}

/**
 * Handle YAML parsing errors with operator-friendly messages.
 */
function handleYamlParseError(error: any, configPath: string): never {
  console.error(`config error: failed to parse YAML`);
  console.error(`file: ${configPath}`);
  if (error.linePos) {
    console.error(`line ${error.linePos[0].line}, column ${error.linePos[0].col}`);
  }
  if (process.env.DEBUG === DEBUG_ENV_VAR) {
    console.error(error);
  } else {
    console.error('(set DEBUG=scrollproxy for full trace)');
  }
  throw error;
}

/**
 * Handle Zod validation errors with operator-friendly messages.
 */
function handleZodValidationError(error: ZodError, rawConfig: any, configPath: string): never {
  const firstIssue = error.issues[0];
  const fieldPath = firstIssue.path.join('.');
  const message = firstIssue.message;

  let errorMessage: string;

  // Check for unknown field error
  if (firstIssue.code === 'unrecognized_keys') {
    const keys = (firstIssue as any).keys.join(', ');
    errorMessage = `config error: unknown field "${keys}" at top level`;
    console.error(errorMessage);
    console.error(`file: ${configPath}`);
    console.error('(remove the field, or check the schema in src/config/schema.ts)');
  } else if (firstIssue.code === 'invalid_type') {
    // Handle type errors specially
    const expectedType = (firstIssue as any).expected;
    const receivedType = (firstIssue as any).received;

    // Get the actual value from the raw config
    let actualValue: any = rawConfig;
    for (const key of firstIssue.path) {
      actualValue = actualValue?.[key];
    }
    const valueStr = actualValue !== undefined ? ` "${actualValue}"` : '';

    errorMessage = `config error: ${fieldPath} — expected ${expectedType}, got ${receivedType}${valueStr}`;
    console.error(errorMessage);
    console.error(`file: ${configPath}`);
  } else {
    // Generic error
    errorMessage = `config error: ${fieldPath} — ${message}`;
    console.error(errorMessage);
    console.error(`file: ${configPath}`);
  }

  if (process.env.DEBUG !== DEBUG_ENV_VAR) {
    console.error(`(set DEBUG=${DEBUG_ENV_VAR} for full trace)`);
  }

  // Throw a new error with a clear message for testing
  throw new Error(errorMessage);
}

/**
 * Load and validate ScrollProxy configuration.
 *
 * Search order:
 * 1. Explicit path (if provided)
 * 2. ./config.yaml (repo root)
 * 3. ~/scrollproxy/config.yaml (home dir)
 *
 * If no config is found, writes default to ~/scrollproxy/config.yaml.
 */
export async function loadConfig(options: LoadConfigOptions = {}): Promise<Config> {
  const home = options.homeDir ?? homedir();
  const repoRoot = options.repoRoot ?? process.cwd();
  const defaultConfigPath = join(home, CONFIG_DIR_NAME, CONFIG_FILE_NAME);

  let configPath: string | null = null;

  // Determine which config to load
  if (options.path) {
    // Explicit path takes precedence
    configPath = options.path;
  } else if (existsSync(join(repoRoot, CONFIG_FILE_NAME))) {
    // Repo root config
    configPath = join(repoRoot, CONFIG_FILE_NAME);
  } else if (existsSync(defaultConfigPath)) {
    // Home dir config
    configPath = defaultConfigPath;
  } else {
    // No config exists - write default
    const configDir = join(home, CONFIG_DIR_NAME);
    if (!existsSync(configDir)) {
      mkdirSync(configDir, { recursive: true });
    }
    writeFileSync(defaultConfigPath, defaultConfigYaml, 'utf-8');
    configPath = defaultConfigPath;
    console.log(`wrote default config to ~/${CONFIG_DIR_NAME}/${CONFIG_FILE_NAME} — edit and re-run`);
  }

  // Read and parse YAML
  let rawConfig: any;
  try {
    const yamlContent = readFileSync(configPath, 'utf-8');
    rawConfig = parseYaml(yamlContent);
  } catch (error: any) {
    handleYamlParseError(error, configPath);
  }

  // Validate with Zod
  let config: Config;
  try {
    config = configSchema.parse(rawConfig);
  } catch (error) {
    if (error instanceof ZodError) {
      handleZodValidationError(error, rawConfig, configPath);
    }
    throw error;
  }

  // Post-process config
  config = postProcessConfig(config, home);

  // Validate Notion configuration if needed
  validateNotionConfig(config, configPath);

  return config;
}

/**
 * Validate Notion configuration if destination includes 'notion'.
 */
function validateNotionConfig(config: Config, configPath: string): void {
  // Check if destinations includes 'notion'
  if (!config.output.destinations.includes('notion')) {
    return; // Notion not enabled, validation not needed
  }

  // Check if notion config exists
  if (!config.notion) {
    console.error(`config: destinations includes 'notion' but notion.parentPageId is not configured`);
    console.error(`file: ${configPath}`);
    throw new Error(`config: destinations includes 'notion' but notion.parentPageId is not configured`);
  }

  // Check if parentPageId is set
  if (!config.notion.parentPageId) {
    console.error(`config: destinations includes 'notion' but notion.parentPageId is not configured`);
    console.error(`file: ${configPath}`);
    throw new Error(`config: destinations includes 'notion' but notion.parentPageId is not configured`);
  }

  // Check if token is set (either in config or env)
  const hasToken = config.notion.token || process.env.NOTION_TOKEN;
  if (!hasToken) {
    console.error(`config: destinations includes 'notion' but neither config.notion.token nor NOTION_TOKEN env is set`);
    console.error(`file: ${configPath}`);
    throw new Error(`config: destinations includes 'notion' but neither config.notion.token nor NOTION_TOKEN env is set`);
  }

  // Check if destinations array is not empty
  if (config.output.destinations.length === 0) {
    console.error(`config: output.destinations must have at least one writer`);
    console.error(`file: ${configPath}`);
    throw new Error(`config: output.destinations must have at least one writer`);
  }
}

/**
 * Deduplicate interests list (case-insensitive, preserve order).
 */
function deduplicateInterests(interests: string[]): string[] {
  const seen = new Set<string>();
  const deduplicated: string[] = [];

  for (const interest of interests) {
    const trimmed = interest.trim();
    const normalized = trimmed.toLowerCase();

    if (!seen.has(normalized)) {
      seen.add(normalized);
      deduplicated.push(trimmed);
    }
  }

  return deduplicated;
}

/**
 * Post-process config after validation:
 * - Expand tilde paths
 * - Deduplicate interests (case-insensitive, preserve order)
 */
function postProcessConfig(config: Config, homeDir: string): Config {
  // Expand tilde in paths
  const expandTilde = (path: string): string => {
    if (path.startsWith('~/')) {
      return join(homeDir, path.slice(2));
    }
    return path;
  };

  config.browser.userDataDir = expandTilde(config.browser.userDataDir);
  config.output.dir = expandTilde(config.output.dir);
  config.output.state = expandTilde(config.output.state);

  // Deduplicate interests
  config.interests = deduplicateInterests(config.interests);

  return config;
}
