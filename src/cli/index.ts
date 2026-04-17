#!/usr/bin/env node

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseArgs, validateFlags, parseMinutesFlag, printHelp, printVersion } from './args.js';
import { loadConfig } from '../config/load.js';
import { handleScroll } from './scroll.js';
import { handleLogin } from './login.js';
import { handleReplay } from './replay.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const EXIT_SUCCESS = 0;
const EXIT_ERROR = 1;
const EXIT_USAGE_ERROR = 2;

interface PackageJson {
  name: string;
  version: string;
}

/**
 * Main CLI entry point.
 */
async function main() {
  try {
    // Read package.json for version
    const packagePath = join(__dirname, '../../package.json');
    const packageJson = JSON.parse(readFileSync(packagePath, 'utf-8')) as PackageJson;
    const version = packageJson.version;

    // Parse command-line arguments
    const args = process.argv.slice(2);
    let parsed;

    try {
      parsed = parseArgs(args);
    } catch (error: any) {
      console.error(error.message);
      process.exit(EXIT_USAGE_ERROR);
    }

    const { verb, flags, positionals } = parsed;

    // Handle global flags first
    if (flags.help || flags.h) {
      printHelp(version);
      process.exit(EXIT_SUCCESS);
    }

    if (flags.version || flags.v) {
      printVersion(version);
      process.exit(EXIT_SUCCESS);
    }

    // Route by verb
    switch (verb) {
      case 'scroll':
        await handleScrollCommand(flags);
        break;

      case 'login':
        await handleLoginCommand(flags);
        break;

      case 'replay':
        await handleReplayCommand(flags, positionals);
        break;

      default:
        console.error(`unknown command: ${verb} (expected one of: scroll, login, replay)`);
        process.exit(EXIT_USAGE_ERROR);
    }

  } catch (error: any) {
    // Config loader errors and other errors surface unchanged
    if (error.message && error.message.startsWith('config error:')) {
      // Config loader already printed the error
      process.exit(EXIT_ERROR);
    } else if (error.message) {
      console.error(error.message);
      process.exit(EXIT_ERROR);
    } else {
      console.error(error);
      process.exit(EXIT_ERROR);
    }
  }
}

/**
 * Validate flags against allowed list, exit on error.
 */
function validateFlagsOrExit(flags: Record<string, string | boolean>, allowed: string[]): void {
  try {
    validateFlags(flags, allowed);
  } catch (error: any) {
    console.error(error.message);
    process.exit(EXIT_USAGE_ERROR);
  }
}

/**
 * Load config from --config flag if present.
 */
async function loadConfigFromFlags(flags: Record<string, string | boolean>) {
  const configPath = typeof flags.config === 'string' ? flags.config : undefined;
  return await loadConfig({ path: configPath });
}

/**
 * Handle the scroll command.
 */
async function handleScrollCommand(flags: Record<string, string | boolean>) {
  const allowedFlags = ['help', 'h', 'version', 'v', 'minutes', 'dry-run', 'config'];
  validateFlagsOrExit(flags, allowedFlags);

  // Parse --minutes flag
  let minutes: number | undefined;
  try {
    minutes = parseMinutesFlag(flags.minutes);
  } catch (error: any) {
    console.error(error.message);
    process.exit(EXIT_USAGE_ERROR);
  }

  const config = await loadConfigFromFlags(flags);
  const dryRun = flags['dry-run'] === true;
  await handleScroll(config, { minutes, dryRun });
}

/**
 * Handle the login command.
 */
async function handleLoginCommand(flags: Record<string, string | boolean>) {
  const allowedFlags = ['help', 'h', 'version', 'v', 'config'];
  validateFlagsOrExit(flags, allowedFlags);

  const config = await loadConfigFromFlags(flags);
  await handleLogin(config);
}

/**
 * Handle the replay command.
 */
async function handleReplayCommand(flags: Record<string, string | boolean>, positionals: string[]) {
  const allowedFlags = ['help', 'h', 'version', 'v', 'config'];
  validateFlagsOrExit(flags, allowedFlags);

  // Check for required run-id positional
  if (positionals.length === 0) {
    console.error('replay requires a run-id: pnpm replay <run-id>');
    process.exit(EXIT_USAGE_ERROR);
  }

  const runId = positionals[0];
  const config = await loadConfigFromFlags(flags);
  await handleReplay(config, runId);
}

// Run main
main().catch((error) => {
  console.error(error);
  process.exit(EXIT_ERROR);
});
