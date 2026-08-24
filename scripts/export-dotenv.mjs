import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) throw new Error('dotenv path is required');

const source = readFileSync(file, 'utf8');
process.loadEnvFile(file);

const keys = new Set();
for (const line of source.split(/\r?\n/)) {
  const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
  if (match) keys.add(match[1]);
}

for (const key of keys) {
  process.stdout.write(`${key}=${process.env[key] ?? ''}\0`);
}
