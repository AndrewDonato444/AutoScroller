/**
 * Hand-rolled argument parser for ScrollProxy CLI.
 *
 * Deliberately simple: no heavy frameworks, no colors, no plugin ecosystems.
 * Parses flags and positionals for verb-based commands.
 */

export interface ParsedArgs {
  verb: string;
  flags: Record<string, string | boolean>;
  positionals: string[];
}

/**
 * Parse command-line arguments into verb, flags, and positionals.
 *
 * Format: <verb> [--flag value] [--flag] [positional...]
 */
export function parseArgs(argv: string[]): ParsedArgs {
  if (argv.length === 0) {
    throw new Error('unknown command: (expected one of: scroll, login, replay)');
  }

  const verb = argv[0];
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];

  let i = 1;
  while (i < argv.length) {
    const arg = argv[i];

    if (arg.startsWith('--')) {
      const flagName = arg.slice(2);

      // Check if next arg is a value or another flag
      const nextArg = argv[i + 1];
      if (nextArg && !nextArg.startsWith('--')) {
        // Flag with value
        flags[flagName] = nextArg;
        i += 2;
      } else {
        // Boolean flag
        flags[flagName] = true;
        i += 1;
      }
    } else if (arg.startsWith('-')) {
      // Short flags
      const flagName = arg.slice(1);
      flags[flagName] = true;
      i += 1;
    } else {
      // Positional argument
      positionals.push(arg);
      i += 1;
    }
  }

  return { verb, flags, positionals };
}

/**
 * Validate flags against allowed list for a command.
 */
export function validateFlags(
  flags: Record<string, string | boolean>,
  allowed: string[],
  verb?: string
): void {
  const allowedSet = new Set(allowed);

  for (const flag of Object.keys(flags)) {
    if (!allowedSet.has(flag)) {
      const helpHint = verb ? `\`pnpm ${verb} --help\`` : '`--help`';
      throw new Error(`unknown flag: --${flag} (run ${helpHint} for usage)`);
    }
  }
}

/**
 * Print help text to stdout.
 */
export function printHelp(version: string): void {
  console.log(`scrollproxy v${version} — pull signal from your curated X lists

usage:
  pnpm scroll   [--dry-run] [--config <path>]
  pnpm replay   <run-id> [--config <path>]

flags:
  --dry-run        pull from the X API and print per-list counts, skip
                   write + summarize + writers
  --config <path>  load config from an explicit path
  --help, -h       show this message
  --version, -v    print version

env:
  ANTHROPIC_API_KEY  used by the summarizer
  X_BEARER_TOKEN     user access token for the X API (bootstrap with 'pnpm x:auth',
                     rotate with 'pnpm x:refresh')`);
}

/**
 * Print version to stdout.
 */
export function printVersion(version: string): void {
  console.log(`scrollproxy v${version}`);
}
