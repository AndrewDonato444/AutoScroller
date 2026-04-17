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
      process.exit(2);
    }

    const { verb, flags, positionals } = parsed;

    // Handle global flags first
    if (flags.help || flags.h) {
      printHelp(version);
      process.exit(0);
    }

    if (flags.version || flags.v) {
      printVersion(version);
      process.exit(0);
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
        process.exit(2);
    }

  } catch (error: any) {
    // Config loader errors and other errors surface unchanged
    if (error.message && error.message.startsWith('config error:')) {
      // Config loader already printed the error
      process.exit(1);
    } else if (error.message) {
      console.error(error.message);
      process.exit(1);
    } else {
      console.error(error);
      process.exit(1);
    }
  }
}

/**
 * Handle the scroll command.
 */
async function handleScrollCommand(flags: Record<string, string | boolean>) {
  // Validate flags
  const allowedFlags = ['help', 'h', 'version', 'v', 'minutes', 'dry-run', 'config'];
  try {
    validateFlags(flags, allowedFlags);
  } catch (error: any) {
    console.error(error.message);
    process.exit(2);
  }

  // Parse --minutes flag
  let minutes: number | undefined;
  try {
    minutes = parseMinutesFlag(flags.minutes);
  } catch (error: any) {
    console.error(error.message);
    process.exit(2);
  }

  // Load config
  const configPath = typeof flags.config === 'string' ? flags.config : undefined;
  const config = await loadConfig({ path: configPath });

  // Invoke handler
  const dryRun = flags['dry-run'] === true;
  await handleScroll(config, { minutes, dryRun });
}

/**
 * Handle the login command.
 */
async function handleLoginCommand(flags: Record<string, string | boolean>) {
  // Validate flags
  const allowedFlags = ['help', 'h', 'version', 'v', 'config'];
  try {
    validateFlags(flags, allowedFlags);
  } catch (error: any) {
    console.error(error.message);
    process.exit(2);
  }

  // Load config
  const configPath = typeof flags.config === 'string' ? flags.config : undefined;
  const config = await loadConfig({ path: configPath });

  // Invoke handler
  await handleLogin(config);
}

/**
 * Handle the replay command.
 */
async function handleReplayCommand(flags: Record<string, string | boolean>, positionals: string[]) {
  // Validate flags
  const allowedFlags = ['help', 'h', 'version', 'v', 'config'];
  try {
    validateFlags(flags, allowedFlags);
  } catch (error: any) {
    console.error(error.message);
    process.exit(2);
  }

  // Check for required run-id positional
  if (positionals.length === 0) {
    console.error('replay requires a run-id: pnpm replay <run-id>');
    process.exit(2);
  }

  const runId = positionals[0];

  // Load config
  const configPath = typeof flags.config === 'string' ? flags.config : undefined;
  const config = await loadConfig({ path: configPath });

  // Invoke handler
  await handleReplay(config, runId);
}

// Run main
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
