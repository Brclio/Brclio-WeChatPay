import { readFile } from 'node:fs/promises';

/** Small, deliberately non-evaluating parser for generated Wrangler .dev.vars. */
export function parseDevVars(source) {
  const result = {};
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
    if (!match) throw new Error('Environment file format is invalid');
    let value = match[2];
    if (value.startsWith('"')) {
      try { value = JSON.parse(value); } catch { throw new Error('Environment file quoted value is invalid'); }
      if (typeof value !== 'string') throw new Error('Environment file values must be strings');
    } else if (value.startsWith("'")) {
      if (!value.endsWith("'")) throw new Error('Environment file quoted value is invalid');
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    if (Object.hasOwn(result, match[1])) throw new Error('Environment file contains duplicate names');
    result[match[1]] = value;
  }
  return result;
}

export async function loadEnvironment(path = '.dev.vars') {
  let defaults = {};
  try {
    // Repository config is JSON-compatible JSONC. No code or shell evaluation.
    const config = JSON.parse(await readFile('wrangler.jsonc', 'utf8'));
    defaults = Object.fromEntries(Object.entries(config.vars || {}).map(([name, value]) => [name, String(value)]));
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Could not read wrangler.jsonc defaults');
  }
  let file = {};
  try { file = parseDevVars(await readFile(path, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { ...defaults, ...file, ...process.env };
}
