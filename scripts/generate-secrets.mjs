import { randomBytes } from 'node:crypto';
import { access, mkdir, writeFile } from 'node:fs/promises';

const args = new Set(process.argv.slice(2));
if ([...args].some((arg) => !['--write', '--write-dev-vars', '--help'].includes(arg)) || args.has('--help') || !args.has('--write')) {
  process.stdout.write('Usage: npm run secrets:generate -- --write [--write-dev-vars]\nCreates ignored secrets/bootstrap.json. Optional --write-dev-vars also creates .dev.vars. Existing files are never overwritten. No secret values are printed.\n');
  if (!args.has('--help')) process.exitCode = 1;
} else {
  try {
    const destinations = ['secrets/bootstrap.json', ...(args.has('--write-dev-vars') ? ['.dev.vars'] : [])];
    for (const destination of destinations) {
      try { await access(destination); throw new Error('EXISTS'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const values = {
      PAYMENT_MODE: 'demo',
      PAYMENT_ENABLED: 'false',
      PUBLIC_BASE_URL: 'https://paywc.bornforthis.cn',
      GITHUB_DATA_REPO: 'BrclioData/Brclio-WeChatPay-Data',
      GITHUB_DATA_BRANCH: 'main',
      GITHUB_TOKEN: '',
      ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      ORDER_ID_SECRET: randomBytes(32).toString('hex'),
      CHECKOUT_SECRET: randomBytes(32).toString('hex'),
      ADMIN_EMAIL: '',
      ADMIN_PASSWORD_HASH: '',
      ADMIN_SESSION_SECRET: randomBytes(32).toString('hex'),
      CLIENTS_JSON: '[]',
      WECHAT_MCH_ID: '1751349372',
      WECHAT_APP_ID: 'wx59aa532fbf6fa540',
      WECHAT_JSAPI_APP_ID: '',
      WECHAT_JSAPI_CONTEXT: 'web',
      WECHAT_APP_APP_ID: '',
      WECHAT_SERIAL_NO: '',
      WECHAT_PRIVATE_KEY: '',
      WECHAT_API_V3_KEY: '',
      WECHAT_PUBLIC_KEYS_JSON: '{}',
      WECHAT_PUBLIC_KEY_ID: '',
      ENABLED_CHANNELS: 'native',
      ALLOWED_ORIGINS: 'https://brclio.com,https://*.brclio.com',
    };
    await mkdir('secrets', { recursive: true, mode: 0o700 });
    await writeFile('secrets/bootstrap.json', JSON.stringify(values, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    if (args.has('--write-dev-vars')) {
      const text = '# Local development secrets. Never commit or print this file.\n' + Object.entries(values).map(([name, value]) => `${name}=${JSON.stringify(value)}`).join('\n') + '\n';
      await writeFile('.dev.vars', text, { flag: 'wx', mode: 0o600 });
    }
    process.stdout.write('Created secrets/bootstrap.json' + (args.has('--write-dev-vars') ? ' and .dev.vars' : '') + '. Payment remains disabled. Complete merchant/admin credentials, then register real products in the admin console before preflight.\n');
  } catch {
    process.stderr.write('No existing secret file was overwritten. Generation failed; check existing destination files and filesystem permissions.\n');
    process.exitCode = 1;
  }
}
