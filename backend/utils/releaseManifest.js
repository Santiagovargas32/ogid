import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const sha = value => createHash('sha256').update(value).digest('hex');
const readJson = file => JSON.parse(readFileSync(file, 'utf8'));
const version = value => typeof value === 'string' && /^[\w.+-]{1,100}$/.test(value) ? value : null;

// Only package names/versions and hashes are exported. Never inspect .env or
// package script/config values, which may contain credentials or local paths.
export function dependencyManifest(root, directory) {
  try {
    const bytes = readFileSync(join(root, directory, 'package-lock.json'));
    const lock = JSON.parse(bytes);
    const installed = [], mismatches = [];
    let missingOptional = 0;
    for (const [key, item] of Object.entries(lock.packages || {}).sort(([a], [b]) => a.localeCompare(b))) {
      if (!key || item.dev || !key.startsWith('node_modules/') || key.split('/').includes('..')) continue;
      const expected = version(item.version);
      let actual = null;
      try { actual = version(readJson(join(root, directory, key, 'package.json')).version); } catch { /* Missing is explicit. */ }
      if (!actual && item.optional) { missingOptional++; continue; }
      installed.push([key, actual]);
      if (!expected || actual !== expected) mismatches.push({ package: key.replaceAll('node_modules/', ''), expected, installed: actual });
    }
    return { lockHash: sha(bytes), installedHash: sha(JSON.stringify(installed)), packages: installed.length,
      missingOptional, state: mismatches.length ? 'mismatch' : installed.length ? 'matched' : 'unknown',
      mismatchCount: mismatches.length, mismatches: mismatches.slice(0, 16), truncated: mismatches.length > 16 };
  } catch { return { lockHash: null, installedHash: null, state: 'unknown' }; }
}

export function releaseManifest(root, component, { nodeVersion = process.version, contractHash = null } = {}) {
  let schema = { latest: null, filesHash: null };
  try {
    const directory = join(root, 'backend/storage/migrations');
    const files = readdirSync(directory).filter(name => /^\d+_.*\.sql$/.test(name)).sort();
    schema = { latest: Math.max(...files.map(name => Number.parseInt(name, 10))),
      filesHash: sha(JSON.stringify(files.map(name => [name, sha(readFileSync(join(directory, name)))]))) };
  } catch { /* An unavailable schema is not verified. */ }
  return { version: 'release-manifest-v1', nodeVersion, contractHash, expectedSchema: schema,
    dependencies: dependencyManifest(root, component === 'backend' ? 'backend' : 'integrations/ogid-mcp'),
    verification: 'local-files-and-installed-versions; not cryptographic attestation' };
}
