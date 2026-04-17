#!/usr/bin/env node

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

interface PackageJson {
  name: string;
  version: string;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const STATUS_MESSAGE = 'feed not yet wired';

// Read package.json to get version
const packagePath = join(__dirname, '../package.json');
const packageJson = JSON.parse(readFileSync(packagePath, 'utf-8')) as PackageJson;

// Print version banner
console.log(`${packageJson.name} v${packageJson.version} — ${STATUS_MESSAGE}`);

// Exit cleanly
process.exit(0);
