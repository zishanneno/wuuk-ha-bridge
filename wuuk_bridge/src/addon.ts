import { readFile } from 'node:fs/promises';
import { addonEnvironment } from './addon-options.js';

let config: unknown;
try {
  config = JSON.parse(await readFile('/data/options.json', 'utf8'));
} catch {
  console.error('Could not read /data/options.json. Save the app Configuration and try again.');
  process.exit(1);
}

try {
  for (const [key, value] of Object.entries(addonEnvironment(config))) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Invalid app configuration');
  process.exit(1);
}

await import('./index.js');
