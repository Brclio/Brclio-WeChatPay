import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, pbkdf2Sync } from 'node:crypto';
import test from 'node:test';
import { authenticate, checkoutToken } from '../src/auth.js';
import { bytesToBase64, encryptJson } from '../src/crypto.js';
import worker from '../src/index.js';
import { integrationSkill } from '../src/skill.js';
import { type Client, type Env, type Order } from '../src/types.js';

const origin = 'https://pay.bornforthis.cn';
const repo = 'test-owner/index-fixture';
const storageKey = bytesToBase64(new Uint8Array(32).fill(37));
const password = 'Fixture-index-admin-password!';
const salt = 'abcdef0123456789abcdef0123456789';
const adminHash = `pbkdf2-sha256$100000$${salt}$${pbkdf2Sync(password, Buffer.from(salt, 'hex'), 100000, 32, 'sha256').toString('hex')}`;
const keyPair = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const client: Client = { id: 'fixture-product', name: '单分钱测试产品', apiKey: 'fixture-api-key-'.repeat(5), webhookSecret: 'fixture-webhook-key-'.repeat(5), webhookUrl: 'https://api.brclio.com/webhook', returnOrigins: ['https://brclio.com'], channels: ['native'], products: { coin: { description: '零点零一元测试商品', amount: 1 } } };
function environment(live = false): Env {
  return {
    ASSETS: { fetch: async () => new Response('<html>Fixture asset</html>', { headers: { 'Content-Type': 'text/html' } }) } as unknown as Fetcher,
    ADMIN_EMAIL: 'owner@example.com', ADMIN_PASSWORD_HASH: adminHash, ADMIN_SESSION_SECRET: 'fixture-admin-session-'.repeat(4), AUTH_RATE_LIMITER: { limit: async () => ({ success: true }) },
    PAYMENT_MODE: live ? 'live' : 'demo', PAYMENT_ENABLED: live ? 'true' : 'false', PUBLIC_BASE_URL: origin, ALLOWED_ORIGINS: 'https://brclio.com,https://*.brclio.com',
    GITHUB_DATA_REPO: repo, GITHUB_DATA_BRANCH: 'main', GITHUB_TOKEN: 'fixture-index-github-secret', ENCRYPTION_KEY: storageKey, ORDER_ID_SECRET: 'o'.repeat(64), CHECKOUT_SECRET: 'c'.repeat(64),
    WECHAT_MCH_ID: '1751349372', WECHAT_APP_ID: 'wx59aa532fbf6fa540', WECHAT_SERIAL_NO: 'A'.repeat(40), WECHAT_PRIVATE_KEY: keyPair.privateKey, WECHAT_API_V3_KEY: 'v'.repeat(32),
    WECHAT_PUBLIC_KEYS_JSON: JSON.stringify({ PUB_KEY_ID_00000000000000000000000000000001: keyPair.publicKey }), ENABLED_CHANNELS: 'native', CLIENTS_JSON: JSON.stringify([client]),
  } as Env;
}
function context(): ExecutionContext { return { waitUntil() {} } as unknown as ExecutionContext; }
function request(path: string, init?: RequestInit): Request { return new Request(origin + path, init); }
function denyNetwork(t: { mock: { method: (object: object, method: string, implementation: (...args: never[]) => unknown) => unknown } }) {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('Live network is forbidden in this test'); });
  t.mock.method(console, 'error', () => {});
  return () => calls;
}

test('demo health and disabled scheduled work expose readiness without any GitHub request', async (t) => {
  const calls = denyNetwork(t);
  const response = await worker.fetch(request('/api/health'), environment(), context());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { service: 'brclio-pay', mode: 'demo', configured: false, channels: [] });
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  await worker.scheduled({ scheduledTime: Date.now() } as ScheduledController, environment(), context());
  assert.equal(calls(), 0);
});

test('disabled payment routes reject before registry or provider access', async (t) => {
  const calls = denyNetwork(t);
  for (const path of ['/api/v1/orders', '/api/checkout/' + 'a'.repeat(32), '/api/wechat/notify']) {
    const response = await worker.fetch(request(path, { method: 'POST' }), environment(), context());
    assert.equal(response.status, 503);
    assert.equal((await response.json() as { error: { code: string } }).error.code, 'PAYMENTS_DISABLED');
  }
  assert.equal(calls(), 0);
});

test('unknown live API routes and missing product authentication reject without GitHub access', async (t) => {
  const calls = denyNetwork(t);
  const unknown = await worker.fetch(request('/api/not-a-payment-route'), environment(true), context());
  assert.equal(unknown.status, 404);
  const unsigned = await worker.fetch(request('/api/v1/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }), environment(true), context());
  assert.equal(unsigned.status, 401);
  assert.equal(calls(), 0);
});

test('invalid checkout bearer credentials reject before registry or order reads', async (t) => {
  const calls = denyNetwork(t);
  const id = 'a'.repeat(32);
  for (const [path, method] of [[`/api/checkout/${id}`, 'GET'], [`/api/checkout/${id}/refresh`, 'POST']]) {
    const response = await worker.fetch(request(path, { method, headers: { Authorization: 'Bearer ' + '0'.repeat(64) } }), environment(true), context());
    assert.equal(response.status, 401);
    assert.equal((await response.json() as { error: { code: string } }).error.code, 'CHECKOUT_UNAUTHORIZED');
  }
  assert.equal(calls(), 0);
});

test('unsigned WeChat callbacks reject before any registry, order, or fulfillment access', async (t) => {
  const calls = denyNetwork(t);
  const response = await worker.fetch(request('/api/wechat/notify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"event_type":"TRANSACTION.SUCCESS"}' }), environment(true), context());
  assert.equal(response.status, 401);
  assert.equal((await response.json() as { error: { code: string } }).error.code, 'WECHAT_SIGNATURE_INVALID');
  assert.equal(calls(), 0);
});

test('CORS preflight permits configured HTTPS product origins and blocks lookalikes without storage', async (t) => {
  const calls = denyNetwork(t);
  for (const allowed of ['https://brclio.com', 'https://app.brclio.com', 'https://nested.app.brclio.com']) {
    const response = await worker.fetch(request('/api/v1/orders', { method: 'OPTIONS', headers: { Origin: allowed, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'X-Brclio-Signature' } }), environment(true), context());
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), allowed);
    assert.equal(response.headers.get('Vary'), 'Origin');
    assert.ok(response.headers.get('Access-Control-Allow-Headers')!.includes('X-Brclio-Signature'));
    assert.equal(response.headers.has('Access-Control-Allow-Credentials'), false);
  }
  for (const denied of ['https://brclio.com.evil.example', 'https://evilbrclio.com', 'http://app.brclio.com', 'null']) {
    const response = await worker.fetch(request('/api/v1/orders', { method: 'OPTIONS', headers: { Origin: denied } }), environment(true), context());
    assert.equal(response.status, 403);
    assert.equal(response.headers.has('Access-Control-Allow-Origin'), false);
  }
  assert.equal(calls(), 0);
});

test('admin sessions work in demo mode while mutations still require same-origin CSRF', async (t) => {
  const calls = denyNetwork(t);
  const env = environment();
  const loggedIn = await worker.fetch(request('/api/admin/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: env.ADMIN_EMAIL, password }) }), env, context());
  assert.equal(loggedIn.status, 200);
  const data = await loggedIn.json() as { email: string; csrfToken: string };
  const cookie = loggedIn.headers.get('Set-Cookie')!.split(';')[0]!;
  const current = await worker.fetch(request('/api/admin/session', { headers: { Cookie: cookie } }), env, context());
  assert.equal(current.status, 200);
  assert.deepEqual(await current.json(), data);
  const missing = await worker.fetch(request('/api/admin/logout', { method: 'POST', headers: { Origin: origin, Cookie: cookie } }), env, context());
  assert.equal(missing.status, 403);
  const foreign = await worker.fetch(request('/api/admin/logout', { method: 'POST', headers: { Origin: 'https://app.brclio.com', Cookie: cookie, 'X-Brclio-CSRF': data.csrfToken } }), env, context());
  assert.equal(foreign.status, 403);
  assert.equal((await foreign.json() as { error: { code: string } }).error.code, 'ADMIN_ORIGIN_INVALID');
  const logout = await worker.fetch(request('/api/admin/logout', { method: 'POST', headers: { Origin: origin, Cookie: cookie, 'X-Brclio-CSRF': data.csrfToken } }), env, context());
  assert.equal(logout.status, 200);
  assert.ok(logout.headers.get('Set-Cookie')!.includes('Max-Age=0'));
  assert.equal(calls(), 0);
});

test('asset responses retain browser security headers and the origin referrer needed by H5 payment', async (t) => {
  const calls = denyNetwork(t);
  const response = await worker.fetch(request('/checkout/demo'), environment(), context());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Referrer-Policy'), 'strict-origin');
  assert.equal(response.headers.get('X-Frame-Options'), 'DENY');
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.ok(response.headers.get('Content-Security-Policy')!.includes("frame-ancestors 'none'"));
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(calls(), 0);
});

test('checkout polling cache expires from the original read instead of sliding on every poll', async (t) => {
  const env = environment(true);
  const id = 'd'.repeat(32);
  const now = Date.now();
  let clock = now, reads = 0;
  let order: Order = { version: 1, id, clientId: client.id, clientName: client.name, merchantOrderId: 'coin-1', sku: 'coin', quantity: 1, description: client.products.coin!.description, total: 1, currency: 'CNY', appId: env.WECHAT_APP_ID!, channel: 'native', status: 'PENDING', createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 900000).toISOString(), payment: { channel: 'native', codeUrl: 'weixin://wxpay/bizpayurl?pr=fixture' }, requestHash: 'a'.repeat(64), delivery: null };
  t.mock.method(Date, 'now', () => clock);
  t.mock.method(globalThis, 'fetch', (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://api.github.com');
    assert.equal(init?.method, 'GET');
    if (url.pathname === `/repos/${repo}/contents/config/clients.json`) return new Response(null, { status: 404 });
    assert.equal(url.pathname, `/repos/${repo}/contents/orders/dd/${id}.json`);
    reads++;
    const envelope = await encryptJson(storageKey, order, `${repo}:orders/dd/${id}.json`);
    return Response.json({ type: 'file', encoding: 'base64', sha: 'f'.repeat(40), content: bytesToBase64(new TextEncoder().encode(JSON.stringify(envelope))) });
  }) as typeof fetch);
  const headers = { Authorization: 'Bearer ' + await checkoutToken(id, env) };
  const load = async () => {
    const response = await worker.fetch(request(`/api/checkout/${id}`, { headers }), env, context());
    assert.equal(response.status, 200);
    return response.json() as Promise<{ status: string }>;
  };
  assert.equal((await load()).status, 'PENDING');
  order = { ...order, status: 'SUCCESS', transactionId: '420000000000000000000001', paidAt: new Date(now).toISOString(), delivery: { status: 'pending', attempts: 0, nextAt: new Date(now).toISOString() } };
  clock = now + 4000;
  assert.equal((await load()).status, 'PENDING');
  assert.equal(reads, 1);
  clock = now + 9000;
  assert.equal((await load()).status, 'SUCCESS');
  assert.equal(reads, 2);
});

test('copied SKILL supplies only product configuration and its LF signing contract interoperates independently', async () => {
  const skill = integrationSkill(client, origin);
  const start = skill.indexOf('{\n  "BRCLIO_PAY_BASE_URL"');
  const end = skill.indexOf('\n}', start) + 2;
  assert.ok(start >= 0 && end > start);
  const copied = JSON.parse(skill.slice(start, end)) as Record<string, string>;
  assert.deepEqual(Object.keys(copied).sort(), ['BRCLIO_PAY_API_KEY', 'BRCLIO_PAY_BASE_URL', 'BRCLIO_PAY_CLIENT_ID', 'BRCLIO_PAY_WEBHOOK_SECRET'].sort());
  assert.equal(copied.BRCLIO_PAY_CLIENT_ID, client.id);
  assert.equal(copied.BRCLIO_PAY_API_KEY, client.apiKey);
  assert.equal(copied.BRCLIO_PAY_WEBHOOK_SECRET, client.webhookSecret);
  assert.ok(skill.includes('"amount": 1'));
  assert.ok(skill.includes('保留原渠道、路由和历史订单'));
  assert.ok(skill.includes('产品 API 密钥不能进入客户端'));
  assert.ok(skill.includes('事务成功后才返回2xx'));
  assert.ok(skill.includes('真实付款由用户完成'));
  const timestamp = String(Math.floor(Date.now() / 1000)), nonce = '0123456789abcdef0123456789abcdef';
  const path = '/api/v1/orders', body = JSON.stringify({ merchantOrderId: 'coin-one', sku: 'coin', quantity: 1, channel: 'native' });
  // Independent Node implementation follows the copied protocol, not the Worker's HMAC helper.
  const canonical = ['POST', path, timestamp, nonce, body, ''].join('\n');
  const signature = createHmac('sha256', copied.BRCLIO_PAY_API_KEY!).update(canonical, 'utf8').digest('hex');
  const signed = new Request(copied.BRCLIO_PAY_BASE_URL! + path, { method: 'POST', headers: { 'X-Brclio-Client': copied.BRCLIO_PAY_CLIENT_ID!, 'X-Brclio-Timestamp': timestamp, 'X-Brclio-Nonce': nonce, 'X-Brclio-Signature': signature }, body });
  assert.equal((await authenticate(signed, body, environment(true))).id, client.id);
  const wrongSignature = createHmac('sha256', copied.BRCLIO_PAY_API_KEY!).update(canonical.slice(0, -1), 'utf8').digest('hex');
  const badHeaders = new Headers(signed.headers);
  badHeaders.set('X-Brclio-Signature', wrongSignature);
  await assert.rejects(authenticate(new Request(signed.url, { method: 'POST', headers: badHeaders }), body, environment(true)));
});
