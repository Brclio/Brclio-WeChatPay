import { mkdir, writeFile } from 'node:fs/promises';
import { loadEnvironment } from './config-file.mjs';

const args = process.argv.slice(2);
if (args.length !== 1 || args[0] !== '--write') {
  process.stdout.write('Usage: node scripts/export-cloudflare-secrets.mjs --write\nReads local configuration and creates ignored secrets/cloudflare.json for wrangler secret bulk. No upload, no overwrite, no secret output.\n');
  process.exitCode = args.includes('--help') ? 0 : 1;
} else {
  try {
    const env = await loadEnvironment();
    // Public settings remain in wrangler.jsonc. Do not bulk-upload bootstrap.json:
    // it contains public vars which must not collide with Worker secret bindings.
    const names = ['GITHUB_TOKEN', 'ENCRYPTION_KEY', 'ORDER_ID_SECRET', 'CHECKOUT_SECRET', 'ADMIN_EMAIL', 'ADMIN_PASSWORD_HASH', 'ADMIN_SESSION_SECRET', 'WECHAT_SERIAL_NO', 'WECHAT_PRIVATE_KEY', 'WECHAT_API_V3_KEY', 'WECHAT_PUBLIC_KEYS_JSON'];
    if (env.CLIENTS_JSON && env.CLIENTS_JSON.trim() !== '[]') names.push('CLIENTS_JSON');
    const missing = names.filter((name) => !env[name] || ['CLIENTS_JSON', 'WECHAT_PUBLIC_KEYS_JSON'].includes(name) && ['[]', '{}'].includes(env[name].trim()));
    if (missing.length) {
      process.stderr.write(`Missing credential names: ${missing.join(', ')}\n`);
      process.exitCode = 1;
    } else {
      await mkdir('secrets', { recursive: true, mode: 0o700 });
      await writeFile('secrets/cloudflare.json', JSON.stringify(Object.fromEntries(names.map((name) => [name, env[name]])), null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      process.stdout.write('Created secrets/cloudflare.json (0600). No credentials were uploaded. This file never overwrites an existing export.\n');
    }
  } catch {
    process.stderr.write('Secret export failed. Check configuration format, permissions, and whether secrets/cloudflare.json already exists. Values withheld.\n');
    process.exitCode = 1;
  }
}
