import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, randomBytes, randomUUID, sign, verify, X509Certificate } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { loadEnvironment } from './config-file.mjs';

const args = process.argv.slice(2);
let offline = false, writeCheck = false, envFile = '.dev.vars', certificateFile;
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === '--offline') offline = true;
  else if (arg === '--write-check') writeCheck = true;
  else if (arg === '--env-file' && args[index + 1]) envFile = args[++index];
  else if (arg === '--certificate' && args[index + 1]) certificateFile = args[++index];
  else if (arg === '--help') {
    process.stdout.write('Usage: npm run preflight -- [--env-file .dev.vars] [--offline] [--certificate secrets/apiclient_cert.pem] [--write-check]\nDefault: local validation and read-only private repository access check. --write-check explicitly creates and deletes an encrypted marker (two Git commits). Outputs names and status only.\n');
    process.exit(0);
  } else {
    process.stderr.write('Unknown or incomplete preflight argument. Use --help.\n'); process.exit(1);
  }
}
if (offline && writeCheck) { process.stderr.write('--offline cannot be combined with --write-check.\n'); process.exit(1); }

let failures = 0;
function report(name, passed, note = '') {
  process.stdout.write(`${passed ? 'PASS' : 'FAIL'} ${name}${note ? ` (${note})` : ''}\n`);
  if (!passed) failures += 1;
  return passed;
}
function check(name, action) { try { return report(name, Boolean(action())); } catch { return report(name, false); } }
function publicHttps(value, originOnly = false) {
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash && !/^\d+[.\d]*$/.test(url.hostname) && !url.hostname.includes(':') && url.hostname.includes('.') && !/(^|\.)(localhost|local|internal|test|invalid)$/.test(url.hostname) && (!originOnly || (url.pathname === '/' && !url.search));
}
function originPattern(value) {
  const substituted = value.replace('https://*.', 'https://wildcard.');
  return publicHttps(substituted, true) && new URL(substituted).origin === substituted;
}
function noPlaceholder(value) { return typeof value === 'string' && value && !/REPLACE_|YOUR_|CHANGEME|example\.com/i.test(value); }

let env;
try { env = await loadEnvironment(envFile); }
catch { process.stderr.write('FAIL LOCAL_CONFIGURATION (could not parse configuration; secret values withheld)\n'); process.exit(1); }

check('PAYMENT_MODE', () => env.PAYMENT_MODE === 'live');
check('PAYMENT_ENABLED', () => env.PAYMENT_ENABLED === 'true');
check('PUBLIC_BASE_URL', () => noPlaceholder(env.PUBLIC_BASE_URL) && publicHttps(env.PUBLIC_BASE_URL, true));
check('GITHUB_DATA_REPO', () => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.GITHUB_DATA_REPO));
check('GITHUB_DATA_BRANCH', () => noPlaceholder(env.GITHUB_DATA_BRANCH || 'main') && !/[\x00-\x20~^:?*[\\]/.test(env.GITHUB_DATA_BRANCH || 'main'));
check('GITHUB_TOKEN', () => noPlaceholder(env.GITHUB_TOKEN) && env.GITHUB_TOKEN.length >= 20);
const storageKeyValid = check('ENCRYPTION_KEY', () => {
  const bytes = Buffer.from(env.ENCRYPTION_KEY || '', 'base64');
  return bytes.length === 32 && bytes.toString('base64') === env.ENCRYPTION_KEY;
});
for (const name of ['ORDER_ID_SECRET', 'CHECKOUT_SECRET']) check(name, () => noPlaceholder(env[name]) && Buffer.byteLength(env[name]) >= 32);
check('ADMIN_EMAIL', () => typeof env.ADMIN_EMAIL === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(env.ADMIN_EMAIL));
check('ADMIN_PASSWORD_HASH', () => /^pbkdf2-sha256\$100000\$[a-f0-9]{32}\$[a-f0-9]{64}$/.test(env.ADMIN_PASSWORD_HASH));
check('ADMIN_SESSION_SECRET', () => noPlaceholder(env.ADMIN_SESSION_SECRET) && Buffer.byteLength(env.ADMIN_SESSION_SECRET) >= 32);
check('WECHAT_MCH_ID', () => /^\d{6,20}$/.test(env.WECHAT_MCH_ID));
check('WECHAT_APP_ID', () => /^wx[a-zA-Z0-9]{16}$/.test(env.WECHAT_APP_ID));
check('WECHAT_SERIAL_NO', () => /^[0-9A-Fa-f]{16,64}$/.test(env.WECHAT_SERIAL_NO));
check('WECHAT_API_V3_KEY', () => noPlaceholder(env.WECHAT_API_V3_KEY) && Buffer.byteLength(env.WECHAT_API_V3_KEY, 'utf8') === 32);
let merchantPrivateKey;
check('WECHAT_PRIVATE_KEY', () => {
  if (!/^-----BEGIN PRIVATE KEY-----/.test(env.WECHAT_PRIVATE_KEY || '')) return false;
  merchantPrivateKey = createPrivateKey(env.WECHAT_PRIVATE_KEY);
  if (merchantPrivateKey.asymmetricKeyType !== 'rsa' || merchantPrivateKey.asymmetricKeyDetails.modulusLength !== 2048) return false;
  const probe = Buffer.from('Brclio-WeChatPay local key validation');
  return verify('RSA-SHA256', probe, createPublicKey(merchantPrivateKey), sign('RSA-SHA256', probe, merchantPrivateKey));
});
check('WECHAT_PUBLIC_KEYS_JSON', () => {
  const keys = JSON.parse(env.WECHAT_PUBLIC_KEYS_JSON || '{}');
  if (!keys || typeof keys !== 'object' || Array.isArray(keys) || !Object.keys(keys).length) return false;
  return Object.entries(keys).every(([id, pem]) => {
    if (!/^PUB_KEY_ID_[A-Za-z0-9_]+$/.test(id) || typeof pem !== 'string' || !/^-----BEGIN PUBLIC KEY-----/.test(pem)) return false;
    const key = createPublicKey(pem);
    return key.asymmetricKeyType === 'rsa' && key.asymmetricKeyDetails.modulusLength >= 2048;
  });
});
if (env.WECHAT_PUBLIC_KEY_ID) check('WECHAT_PUBLIC_KEY_ID', () => {
  const keys = JSON.parse(env.WECHAT_PUBLIC_KEYS_JSON || '{}');
  return /^PUB_KEY_ID_\d+$/.test(env.WECHAT_PUBLIC_KEY_ID) && Object.hasOwn(keys, env.WECHAT_PUBLIC_KEY_ID);
});
else process.stdout.write('SKIP WECHAT_PUBLIC_KEY_ID (first configured key is active; explicitly pin the public key ID for production)\n');
const knownChannels = ['native', 'h5', 'jsapi', 'app'];
const channels = (env.ENABLED_CHANNELS || 'native').split(',').map((value) => value.trim());
check('ENABLED_CHANNELS', () => channels.length > 0 && new Set(channels).size === channels.length && channels.every((value) => knownChannels.includes(value)));
if (channels.includes('jsapi')) {
  check('WECHAT_JSAPI_APP_ID', () => /^wx[a-zA-Z0-9]{16}$/.test(env.WECHAT_JSAPI_APP_ID));
  check('WECHAT_JSAPI_CONTEXT', () => ['web', 'miniprogram'].includes(env.WECHAT_JSAPI_CONTEXT));
}
if (channels.includes('app')) check('WECHAT_APP_APP_ID', () => /^wx[a-zA-Z0-9]{16}$/.test(env.WECHAT_APP_APP_ID));
check('ALLOWED_ORIGINS', () => (env.ALLOWED_ORIGINS || '').split(',').map((value) => value.trim()).every(originPattern));
check('ORDER_TTL_MINUTES', () => /^\d+$/.test(env.ORDER_TTL_MINUTES || '15') && Number(env.ORDER_TTL_MINUTES || '15') >= 5 && Number(env.ORDER_TTL_MINUTES || '15') <= 120);
let configuredClients = [];
function validClients(clients) {
  if (!Array.isArray(clients)) return false;
  const ids = new Set();
  const allSecrets = new Set([env.ORDER_ID_SECRET, env.CHECKOUT_SECRET]);
  for (const client of clients) {
    if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(client.id) || ids.has(client.id) || !noPlaceholder(client.name)) return false;
    ids.add(client.id);
    for (const value of [client.apiKey, client.webhookSecret]) {
      if (!noPlaceholder(value) || Buffer.byteLength(value) < 32 || allSecrets.has(value)) return false;
      allSecrets.add(value);
    }
    if (!publicHttps(client.webhookUrl) || !Array.isArray(client.returnOrigins) || !client.returnOrigins.length || !client.returnOrigins.every(originPattern) || !Array.isArray(client.channels) || !client.channels.length || !client.channels.every((channel) => channels.includes(channel))) return false;
    if (!client.products || typeof client.products !== 'object' || !Object.keys(client.products).length) return false;
    for (const [sku, product] of Object.entries(client.products)) {
      if (!/^[a-zA-Z0-9_-]{1,80}$/.test(sku) || !noPlaceholder(sku) || !noPlaceholder(product.description) || Buffer.byteLength(product.description) > 100 || !Number.isSafeInteger(product.amount) || product.amount < 1 || product.amount > 100000000 || (product.maxQuantity !== undefined && (!Number.isSafeInteger(product.maxQuantity) || product.maxQuantity < 1 || product.maxQuantity > 100))) return false;
    }
  }
  return true;
}
if (env.CLIENTS_JSON && env.CLIENTS_JSON.trim() !== '[]') check('CLIENTS_JSON', () => {
  const list = JSON.parse(env.CLIENTS_JSON);
  if (!validClients(list)) return false;
  configuredClients = list;
  return true;
});
else process.stdout.write('SKIP CLIENTS_JSON (optional fallback; products may be registered in encrypted admin registry)\n');

if (certificateFile) {
  try {
    const cert = new X509Certificate(await readFile(certificateFile));
    const now = Date.now();
    report('MERCHANT_CERTIFICATE', Boolean(merchantPrivateKey) && cert.checkPrivateKey(merchantPrivateKey) && cert.serialNumber.replace(/:/g, '').toUpperCase() === (env.WECHAT_SERIAL_NO || '').replace(/:/g, '').toUpperCase() && Date.parse(cert.validFrom) <= now && Date.parse(cert.validTo) > now);
  } catch { report('MERCHANT_CERTIFICATE', false); }
} else process.stdout.write('SKIP MERCHANT_CERTIFICATE (supply --certificate to check private-key/serial/expiry match)\n');

async function github(path, method = 'GET', body, allowMissing = false) {
  const response = await fetch(`https://api.github.com/repos/${env.GITHUB_DATA_REPO}${path}`, {
    method,
    headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Brclio-WeChatPay-Preflight', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined, redirect: 'error', signal: AbortSignal.timeout(10_000),
  });
  if (allowMissing && response.status === 404) return null;
  if (!response.ok) throw new Error('GitHub request failed');
  return response.json();
}

if (offline) process.stdout.write('SKIP GITHUB_PRIVATE_ACCESS (offline; repository read/write access and admin product registry unverified)\n');
else if (env.GITHUB_TOKEN && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.GITHUB_DATA_REPO)) {
  let repoValid = false;
  try {
    const repo = await github('');
    repoValid = report('GITHUB_REPOSITORY_PRIVATE', repo.private === true && repo.full_name?.toLowerCase() === env.GITHUB_DATA_REPO.toLowerCase());
    if (repoValid) {
      await github(`/branches/${encodeURIComponent(env.GITHUB_DATA_BRANCH || 'main')}`);
      report('GITHUB_BRANCH_READ', true);
      if (storageKeyValid) {
        const record = await github(`/contents/config/clients.json?ref=${encodeURIComponent(env.GITHUB_DATA_BRANCH || 'main')}`, 'GET', undefined, true);
        if (record) {
          const envelope = JSON.parse(Buffer.from(record.content.replace(/\s/g, ''), 'base64').toString('utf8'));
          if (envelope.version !== 1 || envelope.algorithm !== 'AES-256-GCM') throw new Error('Invalid registry envelope');
          const iv = Buffer.from(envelope.iv, 'base64'), encrypted = Buffer.from(envelope.ciphertext, 'base64');
          if (iv.length !== 12 || encrypted.length < 16) throw new Error('Invalid registry envelope');
          const decipher = createDecipheriv('aes-256-gcm', Buffer.from(env.ENCRYPTION_KEY, 'base64'), iv);
          decipher.setAAD(Buffer.from(`Brclio-WeChatPay:encrypted-json:v1\n${env.GITHUB_DATA_REPO}:config/clients.json`));
          decipher.setAuthTag(encrypted.subarray(-16));
          const registry = JSON.parse(Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]).toString('utf8'));
          if (registry.version !== 1 || !validClients(registry.clients)) throw new Error('Invalid registry');
          const combined = new Map(configuredClients.map((client) => [client.id, client]));
          for (const client of registry.clients) combined.set(client.id, client);
          configuredClients = [...combined.values()];
          report('GITHUB_ENCRYPTED_CLIENT_REGISTRY', validClients(configuredClients));
        } else process.stdout.write('SKIP GITHUB_ENCRYPTED_CLIENT_REGISTRY (not registered yet; use the protected admin console)\n');
        report('REGISTERED_PRODUCTS', configuredClients.some((client) => !client.disabled));
      }
    }
  } catch { report('GITHUB_PRIVATE_ACCESS', false); }
  if (writeCheck && repoValid && storageKeyValid && failures === 0) {
    const path = `checks/preflight-${randomUUID()}.json.enc`;
    try {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', Buffer.from(env.ENCRYPTION_KEY, 'base64'), iv);
      cipher.setAAD(Buffer.from(`Brclio-WeChatPay:encrypted-json:v1\n${env.GITHUB_DATA_REPO}:${path}`));
      const content = Buffer.concat([cipher.update(JSON.stringify({ type: 'preflight', createdAt: new Date().toISOString() }), 'utf8'), cipher.final(), cipher.getAuthTag()]);
      const envelope = { version: 1, algorithm: 'AES-256-GCM', iv: iv.toString('base64'), ciphertext: content.toString('base64') };
      const result = await github(`/contents/${path}`, 'PUT', { message: 'Verify encrypted payment storage write', branch: env.GITHUB_DATA_BRANCH || 'main', content: Buffer.from(JSON.stringify(envelope)).toString('base64') });
      report('GITHUB_ENCRYPTED_WRITE', Boolean(result.content?.sha));
      if (!result.content?.sha) throw new Error('Missing SHA');
      // A deliberate pause follows GitHub's mutation pacing guidance.
      await new Promise((resolve) => setTimeout(resolve, 1100));
      await github(`/contents/${path}`, 'DELETE', { message: 'Remove payment storage preflight marker', branch: env.GITHUB_DATA_BRANCH || 'main', sha: result.content.sha });
      report('GITHUB_MARKER_CLEANUP', true);
    } catch { report('GITHUB_WRITE_CHECK', false, 'inspect encrypted checks/preflight marker if cleanup failed'); }
  } else if (writeCheck) process.stdout.write('SKIP GITHUB_WRITE_CHECK (local validation must pass before mutation)\n');
  else process.stdout.write('SKIP GITHUB_WRITE_CHECK (read-only run; Contents write permission unverified)\n');
} else report('GITHUB_PRIVATE_ACCESS', false);

process.stdout.write(failures ? `Preflight blocked: ${failures} check(s) failed. No deployment or payment was performed.\n` : 'Preflight passed for checked configuration. Domain routing, WeChat product permissions, webhook fulfillment, deployment, and a real payment still require end-to-end verification.\n');
if (failures) process.exitCode = 1;
