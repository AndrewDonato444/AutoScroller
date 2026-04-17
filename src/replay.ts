#!/usr/bin/env node

/**
 * Entry point for `pnpm replay` command.
 * Injects 'replay' verb and delegates to CLI dispatcher.
 */

// Inject 'replay' as the first argument
process.argv.splice(2, 0, 'replay');

// Import and run the CLI dispatcher
import('./cli/index.js');
