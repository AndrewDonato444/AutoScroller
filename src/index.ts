#!/usr/bin/env node

/**
 * Entry point for `pnpm scroll` command.
 * Injects 'scroll' verb and delegates to CLI dispatcher.
 */

// Inject 'scroll' as the first argument
process.argv.splice(2, 0, 'scroll');

// Import and run the CLI dispatcher
import('./cli/index.js');
