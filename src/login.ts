#!/usr/bin/env node

/**
 * Entry point for `pnpm login` command.
 * Injects 'login' verb and delegates to CLI dispatcher.
 */

// Inject 'login' as the first argument
process.argv.splice(2, 0, 'login');

// Import and run the CLI dispatcher
import('./cli/index.js');
