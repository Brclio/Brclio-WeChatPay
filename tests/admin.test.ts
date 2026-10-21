import assert from 'node:assert/strict';
import { pbkdf2Sync } from 'node:crypto';
import test from 'node:test';
import { handleAdmin, session, verifyPassword } from '../src/admin.js';
import { bytesToBase64, encryptJson, hmac, sha256 } from '../src/crypto.js';
import worker from '../src/index.js';
import { HttpError, type Client, type Env } from '../src/types.js';

const origin = 'https://pay.bornforthis.cn';
const repo = 'test-owner/private-data';
const password = 'Fixture-admin-password-2026!';
const salt = '0123456789abcdef0123456789abcdef';
const passwordHash = `pbkdf2-sha256$100000$${salt}$${pbkdf2Sync(password, Buffer.from(salt, 'hex'), 100000, 32, 'sha256').toString('hex')}`;
const storageKey = bytesToBase64(new Uint8Array(32).fill(29));
const client: Client = { id: 'product-one', name: '测试产品', apiKey: 'fixture-api-key-'.repeat(5), webhookSecret: 'fixture-webhook-key-'.repeat(5), webhookUrl: 'https://api.brclio.com/webhook', returnOrigins: ['https://brclio.com'], channels: ['native'], products: { year: { description: '年度会员', amount: 12900 } } };
function environment(): Env {
  return {
    ASSETS: { fetch: async () => new Response('Fixture asset') } as unknown as Fetcher,
    ADMIN_EMAIL: 'owner@example.com', ADMIN_PASSWORD_HASH: passwordHash, ADMIN_SESSION_SECRET: 'fixture-admin-session-'.repeat(4),
    AUTH_RATE_LIMITER: { limit: async () => ({ success: true }) }, PUBLIC_BASE_URL: origin, CLIENTS_JSON: '[]', ENABLED_CHANNELS: 'native',
    GITHUB_DATA_REPO: repo, GITHUB_DATA_BRANCH: 'main', GITHUB_TOKEN: 'fixture-github-master-secret', ENCRYPTION_KEY: storageKey,
    WECHAT_PRIVATE_KEY: 'MASTER_PRIVATE_KEY_MUST_NEVER_APPEAR', WECHAT_API_V3_KEY: 'MASTER_API_V3_MUST_NEVER_APPEAR',
  } as Env;
}
function request(path: string, options: { method?: string; cookie?: string; csrf?: string; origin?: string } = {}): Request {
  const headers = new Headers();
  if (options.cookie) headers.set('Cookie', options.cookie);
  if (options.csrf) headers.set('X-Brclio-CSRF', options.csrf);
  if (options.origin) headers.set('Origin', options.origin);
  headers.set('CF-Connecting-IP', '203.0.113.10');
  return new Request(origin + path, { method: options.method ?? 'GET', headers });
}
async function login(env: Env) {
  const response = await handleAdmin(request('/api/admin/login', { method: 'POST', origin }), env, async () => JSON.stringify({ email: env.ADMIN_EMAIL, password }));
  const body = await response.json() as { email: string; csrfToken: string };
  return { response, body, cookie: response.headers.get('Set-Cookie')!.split(';')[0]! };
}
function rejectsWith(status: number, code?: string): (error: unknown) => boolean {
  return (error) => error instanceof HttpError && error.status === status && (!code || error.code === code);
}
async function registryFetcher() {
  const content = bytesToBase64(new TextEncoder().encode(JSON.stringify(await encryptJson(storageKey, { version: 1, clients: [client] }, `${repo}:config/clients.json`))));
  const calls: string[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://api.github.com');
    assert.equal(init?.method, 'GET');
    calls.push(url.pathname);
    if (url.pathname === `/repos/${repo}`) return Response.json({ private: true, default_branch: 'main' });
    assert.equal(url.pathname, `/repos/${repo}/contents/config/clients.json`);
    return Response.json({ type: 'file', encoding: 'base64', sha: 'a'.repeat(40), content });
  }) as typeof fetch;
  return { fetcher, calls };
}

test('PBKDF2 password checks match the configured algorithm and reject malformed hashes', async () => {
  assert.equal(await verifyPassword(password, passwordHash), true);
  assert.equal(await verifyPassword('wrong password', passwordHash), false);
  for (const hash of ['', 'plaintext', passwordHash.replace('$100000$', '$99999$'), passwordHash.replace(salt, 'xyz'), passwordHash.slice(0, -1)]) assert.equal(await verifyPassword(password, hash), false);
});

test('login issues a two-hour secure HttpOnly host cookie and excludes master secrets from the response', async () => {
  const env = environment();
  const { response, body, cookie } = await login(env);
  assert.equal(response.status, 200);
  const setCookie = response.headers.get('Set-Cookie')!;
  for (const part of ['__Host-brclio-admin=', 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=7200', 'Secure']) assert.ok(setCookie.includes(part));
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(body.email, env.ADMIN_EMAIL);
  assert.match(body.csrfToken, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(body).includes(env.ADMIN_PASSWORD_HASH!), false);
  assert.equal(JSON.stringify(body).includes(env.ADMIN_SESSION_SECRET!), false);
  assert.deepEqual(await session(request('/api/admin/session', { cookie }), env), body);
});

test('wrong email and wrong password return the same authentication failure', async () => {
  const env = environment();
  for (const credentials of [{ email: env.ADMIN_EMAIL, password: 'wrong' }, { email: 'other@example.com', password }]) {
    await assert.rejects(handleAdmin(request('/api/admin/login', { method: 'POST', origin }), env, async () => JSON.stringify(credentials)), rejectsWith(401, 'LOGIN_INVALID'));
  }
});

test('valid JSON login scalars and arrays return generic authentication failures while malformed JSON remains a bad request', async () => {
  const env = environment();
  for (const input of [null, true, false, 42, 'credentials', [], [{ email: env.ADMIN_EMAIL, password }], {}, { email: env.ADMIN_EMAIL, password: null }]) {
    await assert.rejects(handleAdmin(request('/api/admin/login', { method: 'POST', origin }), env, async () => JSON.stringify(input)), rejectsWith(401, 'LOGIN_INVALID'));
  }
  await assert.rejects(handleAdmin(request('/api/admin/login', { method: 'POST', origin }), env, async () => '{'), rejectsWith(400, 'JSON_INVALID'));
});

test('login requires same-origin requests and both IP and shared rate-limit checks', async () => {
  const env = environment();
  const keys: string[] = [];
  env.AUTH_RATE_LIMITER = { limit: async ({ key }: { key: string }) => { keys.push(key); return { success: key !== 'admin:global' }; } } as RateLimit;
  await assert.rejects(handleAdmin(request('/api/admin/login', { method: 'POST', origin: 'https://brclio.com' }), env, async () => '{}'), rejectsWith(403, 'ADMIN_ORIGIN_INVALID'));
  assert.equal(keys.length, 0);
  await assert.rejects(handleAdmin(request('/api/admin/login', { method: 'POST', origin }), env, async () => JSON.stringify({ email: env.ADMIN_EMAIL, password })), rejectsWith(429, 'LOGIN_RATE_LIMITED'));
  assert.deepEqual(keys.sort(), ['admin:global', `admin:ip:${await sha256('203.0.113.10')}`].sort());
  assert.equal(keys.some((key) => key.includes('203.0.113.10')), false);
  await assert.rejects(handleAdmin(request('/api/admin/login', { method: 'POST', origin }), { ...env, AUTH_RATE_LIMITER: undefined }, async () => '{}'), rejectsWith(503, 'LOGIN_RATE_LIMIT_NOT_CONFIGURED'));
});

test('tampered sessions and password or session-secret changes invalidate existing cookies', async () => {
  const env = environment();
  const { cookie } = await login(env);
  const prefix = '__Host-brclio-admin=';
  const token = cookie.slice(prefix.length);
  const [payload, signature] = token.split('.');
  const changedSignature = (signature![0] === 'a' ? 'b' : 'a') + signature!.slice(1);
  await assert.rejects(session(request('/api/admin/session', { cookie: `${prefix}${payload}.${changedSignature}` }), env), rejectsWith(401));
  await assert.rejects(session(request('/api/admin/session', { cookie }), { ...env, ADMIN_PASSWORD_HASH: passwordHash.replace(salt, '1123456789abcdef0123456789abcdef') }), rejectsWith(401));
  await assert.rejects(session(request('/api/admin/session', { cookie }), { ...env, ADMIN_SESSION_SECRET: 'rotated-session-secret-'.repeat(4) }), rejectsWith(401));
});

test('expired and excessively long-lived signed sessions are rejected', async () => {
  const env = environment();
  for (const exp of [Math.floor(Date.now() / 1000) - 5, Math.floor(Date.now() / 1000) + 7300]) {
    const payload = btoa(JSON.stringify({ email: env.ADMIN_EMAIL, exp, version: await sha256(env.ADMIN_PASSWORD_HASH!) })).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    const token = `${payload}.${await hmac(env.ADMIN_SESSION_SECRET!, payload)}`;
    await assert.rejects(session(request('/api/admin/session', { cookie: '__Host-brclio-admin=' + token }), env), rejectsWith(401));
  }
});

test('mutations require both same-origin and per-session CSRF tokens; logout clears the cookie', async () => {
  const env = environment();
  const { cookie, body } = await login(env);
  for (const options of [{ origin }, { origin, csrf: 'bad' }, { origin: 'https://evil.example', csrf: body.csrfToken }]) {
    await assert.rejects(handleAdmin(request('/api/admin/logout', { method: 'POST', cookie, ...options }), env, async () => ''), rejectsWith(403));
  }
  const logout = await handleAdmin(request('/api/admin/logout', { method: 'POST', cookie, origin, csrf: body.csrfToken }), env, async () => '');
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('Set-Cookie')!, /__Host-brclio-admin=;.*Max-Age=0/);
  await assert.rejects(session(request('/api/admin/session'), env), rejectsWith(401));
});

test('unauthenticated SKILL and credential requests stop before storage access', async (t) => {
  let reads = 0;
  t.mock.method(globalThis, 'fetch', async () => { reads++; throw new Error('Unexpected external access'); });
  for (const action of ['skill', 'credentials']) {
    await assert.rejects(handleAdmin(request(`/api/admin/clients/${client.id}/${action}`), environment(), async () => ''), rejectsWith(401));
  }
  assert.equal(reads, 0);
  const response = await worker.fetch(request(`/api/admin/clients/${client.id}/skill`), environment(), { waitUntil() {} } as unknown as ExecutionContext);
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal((await response.text()).includes(client.apiKey), false);
});

test('authenticated listing masks keys while SKILL exposes only the selected product credentials', async (t) => {
  const github = await registryFetcher();
  t.mock.method(globalThis, 'fetch', github.fetcher);
  const env = environment();
  const { cookie } = await login(env);
  const listing = await handleAdmin(request('/api/admin/clients', { cookie }), env, async () => '');
  const listText = await listing.text();
  assert.equal(listText.includes(client.apiKey), false);
  assert.equal(listText.includes(client.webhookSecret), false);
  const listed = JSON.parse(listText).clients[0];
  assert.equal(Object.hasOwn(listed, 'apiKey'), false);
  assert.equal(Object.hasOwn(listed, 'webhookSecret'), false);
  assert.equal(listed.maskedKey, `${client.apiKey.slice(0, 4)}••••••••${client.apiKey.slice(-4)}`);
  const skill = await handleAdmin(request(`/api/admin/clients/${client.id}/skill`, { cookie }), env, async () => '');
  const skillBody = await skill.json() as { filename: string; content: string };
  assert.equal(skillBody.filename, 'SKILL.md');
  assert.ok(skillBody.content.includes(client.apiKey));
  assert.ok(skillBody.content.includes(client.webhookSecret));
  for (const secret of [env.GITHUB_TOKEN!, env.ENCRYPTION_KEY!, env.ADMIN_PASSWORD_HASH!, env.ADMIN_SESSION_SECRET!, env.WECHAT_PRIVATE_KEY!, env.WECHAT_API_V3_KEY!]) assert.equal(skillBody.content.includes(secret), false);
  assert.equal(skill.headers.get('Cache-Control'), 'no-store');
  const credentials = await handleAdmin(request(`/api/admin/clients/${client.id}/credentials`, { cookie }), env, async () => '');
  assert.deepEqual(await credentials.json(), { clientId: client.id, apiKey: client.apiKey, webhookSecret: client.webhookSecret });
});
