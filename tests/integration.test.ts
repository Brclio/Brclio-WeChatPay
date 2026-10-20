import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { authenticate } from '../src/auth.js';
import { bootstrapSkill } from '../src/bootstrap-skill.js';
import { base64ToBytes, bytesToBase64, decryptJson, encryptJson, hmac, sha256 } from '../src/crypto.js';
import worker from '../src/index.js';
import { handleIntegration, issueIntegration, verifyIntegration, type IntegrationClaims } from '../src/integration.js';
import { saveClient } from '../src/registry.js';
import { HttpError, type Client, type Env } from '../src/types.js';

const origin = 'https://pay.bornforthis.cn';
const repo = 'test-owner/integration-fixture';
const encryptionKey = bytesToBase64(new Uint8Array(32).fill(41));
const client: Client = { id: 'existing-product', name: '既有产品', apiKey: 'fixture-existing-api-'.repeat(5), webhookSecret: 'fixture-existing-webhook-'.repeat(5), webhookUrl: 'https://api.brclio.com/payment/webhook', returnOrigins: ['https://brclio.com'], channels: ['native'], products: { annual: { description: '既有年费产品', amount: 12900 } } };
const draft = { name: '自动接入测试产品', webhookUrl: 'https://product.brclio.com/api/payment/webhook', returnOrigins: ['https://product.brclio.com'], channels: ['native'], products: { coin: { description: '固定一分钱测试商品', amount: 1, maxQuantity: 1 } } };
const env = {
  PUBLIC_BASE_URL: origin, ALLOWED_ORIGINS: 'https://brclio.com,https://*.brclio.com', PAYMENT_MODE: 'demo', PAYMENT_ENABLED: 'false', ENABLED_CHANNELS: 'native',
  ADMIN_EMAIL: 'owner@example.com', ADMIN_PASSWORD_HASH: 'fixture-admin-password-hash', ADMIN_SESSION_SECRET: 'fixture-admin-integration-master-'.repeat(3),
  GITHUB_DATA_REPO: repo, GITHUB_DATA_BRANCH: 'main', GITHUB_TOKEN: 'fixture-github-master-secret', ENCRYPTION_KEY: encryptionKey, CLIENTS_JSON: '[]',
  WECHAT_PRIVATE_KEY: 'FIXTURE_MERCHANT_MASTER_PRIVATE_KEY', WECHAT_API_V3_KEY: 'FIXTURE_MERCHANT_MASTER_API_V3_KEY', ORDER_ID_SECRET: 'fixture-order-master-'.repeat(4), CHECKOUT_SECRET: 'fixture-checkout-master-'.repeat(4),
} as Env;
const context = { waitUntil() {} } as unknown as ExecutionContext;
function req(id: string, token: string, method = 'GET', suffix = '', body?: unknown): Request {
  return new Request(`${origin}/api/integration/clients/${id}${suffix}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function call(id: string, token: string, method = 'GET', body?: unknown, suffix = ''): Promise<Response> {
  return handleIntegration(req(id, token, method, suffix, body), env, async () => body === undefined ? '' : JSON.stringify(body));
}
function errorCode(expected: string) { return (error: unknown) => error instanceof HttpError && error.code === expected; }
function decodeClaims(token: string): IntegrationClaims {
  return JSON.parse(atob(token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'))) as IntegrationClaims;
}
function signClaims(claims: unknown): string {
  const payload = btoa(JSON.stringify(claims)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `bri1.${payload}.${createHmac('sha256', env.ADMIN_SESSION_SECRET!).update(`integration:v1:${payload}`).digest('hex')}`;
}
async function adminCookie(): Promise<string> {
  const payload = btoa(JSON.stringify({ email: env.ADMIN_EMAIL, exp: Math.floor(Date.now() / 1000) + 7200, nonce: 'a'.repeat(32), version: await sha256(env.ADMIN_PASSWORD_HASH!) })).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `__Host-brclio-admin=${payload}.${await hmac(env.ADMIN_SESSION_SECRET!, payload)}`;
}
function assertNoMasterSecrets(text: string): void {
  for (const name of ['ADMIN_PASSWORD_HASH', 'ADMIN_SESSION_SECRET', 'GITHUB_TOKEN', 'ENCRYPTION_KEY', 'WECHAT_PRIVATE_KEY', 'WECHAT_API_V3_KEY', 'ORDER_ID_SECRET', 'CHECKOUT_SECRET'] as const) assert.equal(text.includes(env[name]!), false, `${name} must not be exported`);
}

class FakeGithub {
  file: { sha: string; content: string } | null = null;
  sequence = 0;
  reads = 0;
  writes = 0;
  requests = 0;
  conflict?: () => Promise<void>;
  async seed(clients: Client[]): Promise<void> {
    const envelope = await encryptJson(encryptionKey, { version: 1, clients }, `${repo}:config/clients.json`);
    this.file = { sha: (++this.sequence).toString(16).padStart(40, '0'), content: bytesToBase64(new TextEncoder().encode(JSON.stringify(envelope))) };
  }
  async clients(): Promise<Client[]> {
    if (!this.file) return [];
    const envelope = JSON.parse(new TextDecoder().decode(base64ToBytes(this.file.content)));
    return (await decryptJson<{ clients: Client[] }>(encryptionKey, envelope, `${repo}:config/clients.json`)).clients;
  }
  fetcher = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    this.requests++;
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://api.github.com', 'Tests may only reach the in-process GitHub fake');
    assert.equal(init?.redirect, 'manual');
    if (url.pathname === `/repos/${repo}`) return Response.json({ private: true, default_branch: 'main' });
    assert.equal(url.pathname, `/repos/${repo}/contents/config/clients.json`);
    if (init?.method === 'GET') {
      this.reads++;
      return this.file ? Response.json({ ...this.file, type: 'file', encoding: 'base64' }) : new Response(null, { status: 404 });
    }
    assert.equal(init?.method, 'PUT');
    this.writes++;
    if (this.conflict) {
      const action = this.conflict;
      this.conflict = undefined;
      await action();
      return new Response(null, { status: 409 });
    }
    const body = JSON.parse(String(init?.body));
    if ((this.file?.sha ?? undefined) !== body.sha) return new Response(null, { status: 409 });
    this.file = { sha: (++this.sequence).toString(16).padStart(40, '0'), content: body.content };
    return Response.json({ content: { sha: this.file.sha } }, { status: 201 });
  }) as typeof fetch;
}

test('forged, wrong-product, expired, wrong-scope, and overlong capabilities fail before GitHub', async (t) => {
  const github = new FakeGithub();
  t.mock.method(globalThis, 'fetch', github.fetcher);
  const access = await issueIntegration(env);
  const claims = decodeClaims(access.token);
  const parts = access.token.split('.');
  const changed = parts[2]![0] === 'a' ? 'b' : 'a';
  const forged = `${parts[0]}.${parts[1]}.${changed}${parts[2]!.slice(1)}`;
  const invalid = [forged, signClaims({ ...claims, exp: Math.floor(Date.now() / 1000) - 1 }), signClaims({ ...claims, exp: Math.floor(Date.now() / 1000) + 86500 }), signClaims({ ...claims, scope: 'admin' }), signClaims({ ...claims, version: 2 }), signClaims({ ...claims, nonce: 'short' }), 'bri1.' + 'a'.repeat(2048)];
  for (const token of invalid) {
    const response = await worker.fetch(req(access.clientId, token), env, context);
    assert.equal(response.status, 401);
  }
  const wrongProduct = await worker.fetch(req('different-product', access.token), env, context);
  assert.equal(wrongProduct.status, 401);
  assert.equal(github.requests, 0);
});

test('bootstrap issuance is scoped to one random product and performs no repository mutation', async (t) => {
  const github = new FakeGithub();
  t.mock.method(globalThis, 'fetch', github.fetcher);
  const access = await issueIntegration(env);
  assert.match(access.clientId, /^p-[a-f0-9]{32}$/);
  const claims = await verifyIntegration(req(access.clientId, access.token), env, access.clientId);
  assert.equal(claims.scope, 'integration:configure');
  assert.equal(claims.credentialVersion, undefined);
  assert.match(claims.nonce, /^[a-f0-9]{32}$/);
  assert.ok(claims.exp <= Math.floor(Date.now() / 1000) + 86400);
  await assert.rejects(call(access.clientId, access.token), errorCode('INTEGRATION_CLIENT_PENDING'));
  assert.equal(github.writes, 0);
});

test('first bootstrap PUT stores only its nonce hash and returns only its own product credentials', async (t) => {
  const github = new FakeGithub();
  await github.seed([client]);
  t.mock.method(globalThis, 'fetch', github.fetcher);
  const access = await issueIntegration(env);
  const response = await worker.fetch(req(access.clientId, access.token, 'PUT', '', draft), env, context);
  assert.equal(response.status, 200, 'Onboarding must work while real payments are disabled');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const text = await response.text();
  assertNoMasterSecrets(text);
  assert.equal(text.includes(client.apiKey), false);
  assert.equal(text.includes(client.webhookSecret), false);
  const body = JSON.parse(text);
  assert.equal(body.client.id, access.clientId);
  assert.equal(Object.hasOwn(body.client, 'apiKey'), false);
  assert.equal(Object.hasOwn(body.client, 'webhookSecret'), false);
  assert.equal(Object.hasOwn(body.client, 'integrationBootstrapHash'), false);
  assert.match(body.credentials.apiKey, /^[a-f0-9]{64}$/);
  assert.match(body.credentials.webhookSecret, /^[a-f0-9]{64}$/);
  const saved = (await github.clients()).find((entry) => entry.id === access.clientId)!;
  assert.equal(saved.integrationBootstrapHash, await sha256(decodeClaims(access.token).nonce));
  assert.notEqual(saved.integrationBootstrapHash, decodeClaims(access.token).nonce);
  assert.deepEqual((await github.clients()).find((entry) => entry.id === client.id), client);
  assert.equal((await call(access.clientId, access.token)).status, 200);
});

test('scoped PUT rejects identifiers, credentials, disable flags, and global configuration injection', async (t) => {
  const github = new FakeGithub();
  await github.seed([client]);
  t.mock.method(globalThis, 'fetch', github.fetcher);
  const access = await issueIntegration(env, client);
  for (const injection of [{ id: 'different-product' }, { disabled: false }, { apiKey: 'injected' }, { webhookSecret: 'injected' }, { integrationBootstrapHash: 'injected' }, { GITHUB_TOKEN: 'injected' }, { ADMIN_SESSION_SECRET: 'injected' }, { WECHAT_MCH_ID: 'injected' }]) {
    await assert.rejects(call(client.id, access.token, 'PUT', { ...draft, ...injection }), errorCode('INTEGRATION_FIELDS_DENIED'));
  }
  await assert.rejects(handleIntegration(req(client.id, access.token, 'PUT'), env, async () => '{"__proto__":{"apiKey":"injected"}}'), errorCode('INTEGRATION_FIELDS_DENIED'));
  assert.equal(github.writes, 0);
  assert.deepEqual(await github.clients(), [client]);
});

test('capability cannot rotate credentials, access another endpoint, or become an administrator session', async (t) => {
  const github = new FakeGithub();
  t.mock.method(globalThis, 'fetch', github.fetcher);
  const access = await issueIntegration(env);
  await assert.rejects(call(access.clientId, access.token, 'POST'), errorCode('METHOD_NOT_ALLOWED'));
  await assert.rejects(call(access.clientId, access.token, 'PUT', {}, '/skill'), errorCode('METHOD_NOT_ALLOWED'));
  const rotate = await worker.fetch(req(access.clientId, access.token, 'POST', '/rotate'), env, context);
  assert.equal(rotate.status, 404);
  const admin = await worker.fetch(new Request(origin + '/api/admin/session', { headers: { Cookie: '__Host-brclio-admin=' + access.token } }), env, context);
  assert.equal(admin.status, 401);
  assert.equal(github.requests, 0);
});

test('business API keys do not authorize configuration and capability tokens do not sign business requests', async (t) => {
  const github = new FakeGithub();
  t.mock.method(globalThis, 'fetch', github.fetcher);
  await assert.rejects(call(client.id, client.apiKey), errorCode('INTEGRATION_UNAUTHORIZED'));
  const access = await issueIntegration(env, client);
  const timestamp = String(Math.floor(Date.now() / 1000)), nonce = '0123456789abcdef', path = '/api/v1/orders';
  const body = JSON.stringify({ merchantOrderId: 'fixture', sku: 'annual', channel: 'native' });
  const signature = createHmac('sha256', access.token).update(`POST\n${path}\n${timestamp}\n${nonce}\n${body}\n`).digest('hex');
  const request = new Request(origin + path, { method: 'POST', headers: { 'X-Brclio-Client': client.id, 'X-Brclio-Timestamp': timestamp, 'X-Brclio-Nonce': nonce, 'X-Brclio-Signature': signature } });
  await assert.rejects(authenticate(request, body, { ...env, CLIENTS_JSON: JSON.stringify([client]) }), (error: unknown) => error instanceof HttpError && error.status === 401);
  assert.equal(github.requests, 0);
});

test('unclaimed bootstrap tokens cannot take an existing product and mismatched stored nonce hashes revoke access', async (t) => {
  const github = new FakeGithub();
  t.mock.method(globalThis, 'fetch', github.fetcher);
  const access = await issueIntegration(env);
  await github.seed([{ ...client, id: access.clientId }]);
  await assert.rejects(call(access.clientId, access.token), errorCode('INTEGRATION_REVOKED'));
  await assert.rejects(call(access.clientId, access.token, 'PUT', draft), errorCode('INTEGRATION_REVOKED'));
  await github.seed([{ ...client, id: access.clientId, integrationBootstrapHash: 'f'.repeat(64) }]);
  await assert.rejects(call(access.clientId, access.token), errorCode('INTEGRATION_REVOKED'));
  assert.equal(github.writes, 0);
});

test('ordinary edits preserve bootstrap authorization while key rotation revokes both token modes', async (t) => {
  const github = new FakeGithub();
  t.mock.method(globalThis, 'fetch', github.fetcher);
  const bootstrap = await issueIntegration(env);
  await call(bootstrap.clientId, bootstrap.token, 'PUT', draft);
  const before = (await github.clients())[0]!;
  const existingAccess = await issueIntegration(env, before);
  await call(before.id, bootstrap.token, 'PUT', { name: '普通商品编辑后仍可接入' });
  const edited = (await github.clients())[0]!;
  assert.equal(edited.integrationBootstrapHash, before.integrationBootstrapHash);
  assert.equal(edited.apiKey, before.apiKey);
  assert.equal((await call(before.id, existingAccess.token)).status, 200);
  const rotated = await saveClient(env, { id: before.id }, true);
  assert.equal(rotated.integrationBootstrapHash, undefined);
  await assert.rejects(call(before.id, bootstrap.token), errorCode('INTEGRATION_REVOKED'));
  await assert.rejects(call(before.id, existingAccess.token), errorCode('INTEGRATION_REVOKED'));
  const currentAccess = await issueIntegration(env, rotated);
  assert.equal((await call(before.id, currentAccess.token)).status, 200);
});

test('scoped updates preserve administrator pause state and never alter other products', async (t) => {
  const github = new FakeGithub();
  const paused = { ...client, disabled: true };
  const other = { ...client, id: 'other-product', apiKey: 'other-api-'.repeat(8), webhookSecret: 'other-webhook-'.repeat(8) };
  await github.seed([paused, other]);
  t.mock.method(globalThis, 'fetch', github.fetcher);
  const access = await issueIntegration(env, paused);
  await call(paused.id, access.token, 'PUT', { name: '仅修改产品名称' });
  const updated = await github.clients();
  assert.equal(updated.find((entry) => entry.id === paused.id)!.disabled, true);
  assert.deepEqual(updated.find((entry) => entry.id === other.id), other);
});

test('credential rotation racing a scoped CAS update revokes that update', async (t) => {
  const github = new FakeGithub();
  await github.seed([client]);
  t.mock.method(globalThis, 'fetch', github.fetcher);
  const access = await issueIntegration(env, client);
  const rotated = { ...client, name: '管理员已轮换', apiKey: 'rotated-api-'.repeat(8), webhookSecret: 'rotated-webhook-'.repeat(8) };
  github.conflict = async () => { await github.seed([rotated]); };
  await assert.rejects(call(client.id, access.token, 'PUT', { name: '已撤销接入不应覆盖此名称' }), errorCode('INTEGRATION_REVOKED'));
  assert.deepEqual(await github.clients(), [rotated]);
});

test('a bootstrap claim collision during CAS cannot overwrite a different existing client', async (t) => {
  const github = new FakeGithub();
  t.mock.method(globalThis, 'fetch', github.fetcher);
  const access = await issueIntegration(env);
  const colliding = { ...client, id: access.clientId };
  github.conflict = async () => { await github.seed([colliding]); };
  await assert.rejects(call(access.clientId, access.token, 'PUT', draft), errorCode('INTEGRATION_REVOKED'));
  assert.deepEqual(await github.clients(), [colliding]);
});

test('administrator pause racing a scoped CAS update cannot be undone by stale input', async (t) => {
  const github = new FakeGithub();
  await github.seed([client]);
  t.mock.method(globalThis, 'fetch', github.fetcher);
  const access = await issueIntegration(env, client);
  github.conflict = async () => { await github.seed([{ ...client, disabled: true }]); };
  await call(client.id, access.token, 'PUT', { name: '保留暂停状态的名称更新' });
  const updated = (await github.clients())[0]!;
  assert.equal(updated.disabled, true);
  assert.equal(updated.name, '保留暂停状态的名称更新');
});

test('partial scoped PUT preserves an unrelated concurrent catalog change', async (t) => {
  const github = new FakeGithub();
  await github.seed([client]);
  t.mock.method(globalThis, 'fetch', github.fetcher);
  const access = await issueIntegration(env, client);
  const products = { ...client.products, added_by_admin: { description: '管理员并发新增商品', amount: 9900 } };
  github.conflict = async () => { await github.seed([{ ...client, products }]); };
  await call(client.id, access.token, 'PUT', { name: '只改名称' });
  const updated = (await github.clients())[0]!;
  assert.deepEqual(updated.products, products);
});

test('scoped SKU upsert preserves omitted SKUs and unrelated SKUs added during a CAS collision', async (t) => {
  const github = new FakeGithub();
  await github.seed([client]);
  t.mock.method(globalThis, 'fetch', github.fetcher);
  const access = await issueIntegration(env, client);
  const concurrentSku = { description: '管理员并发增加的季付商品', amount: 4900 };
  github.conflict = async () => { await github.seed([{ ...client, products: { ...client.products, quarterly: concurrentSku } }]); };
  await call(client.id, access.token, 'PUT', { products: draft.products });
  const updated = (await github.clients())[0]!;
  assert.deepEqual(updated.products.annual, client.products.annual);
  assert.deepEqual(updated.products.quarterly, concurrentSku);
  assert.deepEqual(updated.products.coin, draft.products.coin);
  await call(client.id, access.token, 'PUT', { products: {} });
  assert.deepEqual((await github.clients())[0]!.products, updated.products, 'An empty upsert must not delete the catalog');
});

test('an existing-product capability cannot recreate a missing product after removal', async (t) => {
  const github = new FakeGithub();
  t.mock.method(globalThis, 'fetch', github.fetcher);
  const access = await issueIntegration(env, client);
  await assert.rejects(call(client.id, access.token, 'PUT', draft), errorCode('INTEGRATION_REVOKED'));
  assert.equal(github.writes, 0);
});

test('capability authentication requires the complete Bearer header before any storage access', async (t) => {
  const github = new FakeGithub();
  t.mock.method(globalThis, 'fetch', github.fetcher);
  const access = await issueIntegration(env);
  for (const authorization of [access.token, `Basic ${access.token}`, `BearerBearer ${access.token}`]) {
    const request = new Request(`${origin}/api/integration/clients/${access.clientId}/skill`, { headers: { Authorization: authorization } });
    const response = await worker.fetch(request, env, context);
    assert.equal(response.status, 401);
  }
  assert.equal(github.requests, 0);
});

test('configuration rejects unsafe callback URLs and unopened channels without mutating the catalog', async (t) => {
  const github = new FakeGithub();
  t.mock.method(globalThis, 'fetch', github.fetcher);
  const access = await issueIntegration(env);
  for (const webhookUrl of ['https://127.0.0.1/webhook', 'https://user:pass@api.brclio.com/webhook', 'http://api.brclio.com/webhook']) await assert.rejects(call(access.clientId, access.token, 'PUT', { ...draft, webhookUrl }), errorCode('CLIENT_CONFIG_INVALID'));
  await assert.rejects(call(access.clientId, access.token, 'PUT', { ...draft, channels: ['h5'] }), errorCode('CHANNEL_DISABLED'));
  assert.equal(github.writes, 0);
});

test('new bootstrap products respect the global 100-product catalog limit', async (t) => {
  const github = new FakeGithub();
  const existing = Array.from({ length: 100 }, (_, index) => ({ ...client, id: `existing-${index}` }));
  await github.seed(existing);
  t.mock.method(globalThis, 'fetch', github.fetcher);
  const access = await issueIntegration(env);
  await assert.rejects(call(access.clientId, access.token, 'PUT', draft), errorCode('CATALOG_LIMIT'));
  assert.equal(github.writes, 0);
  assert.equal((await github.clients()).length, 100);
});

test('authenticated bootstrap SKILL needs no product registration and exports no master secrets', async (t) => {
  const github = new FakeGithub();
  t.mock.method(globalThis, 'fetch', github.fetcher);
  const unauthenticated = await worker.fetch(new Request(origin + '/api/admin/bootstrap-skill'), env, context);
  assert.equal(unauthenticated.status, 401);
  const response = await worker.fetch(new Request(origin + '/api/admin/bootstrap-skill', { headers: { Cookie: await adminCookie() } }), env, context);
  assert.equal(response.status, 200);
  const body = await response.json() as { filename: string; content: string; expiresAt: string };
  assert.equal(body.filename, 'SKILL.md');
  assertNoMasterSecrets(body.content);
  assert.ok(body.content.includes('BRCLIO_PAY_INTEGRATION_TOKEN'));
  assert.ok(body.content.includes('24 小时'));
  assert.ok(body.content.includes('真实付款由用户') || body.content.includes('交由用户扫码'));
  assert.equal(github.requests, 0);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
});

test('product SKILL contains only its credentials and correctly scoped temporary management access', async (t) => {
  const github = new FakeGithub();
  await github.seed([client]);
  t.mock.method(globalThis, 'fetch', github.fetcher);
  const access = await issueIntegration(env, client);
  const response = await call(client.id, access.token, 'GET', undefined, '/skill');
  const body = await response.json() as { content: string; expiresAt: string };
  assertNoMasterSecrets(body.content);
  assert.ok(body.content.includes(client.apiKey));
  assert.ok(body.content.includes(client.webhookSecret));
  assert.ok(body.content.includes(access.token));
  assert.ok(body.content.includes(`/api/integration/clients/${client.id}`));
  assert.equal(body.expiresAt, access.expiresAt);
  const genericText = bootstrapSkill(origin, access.clientId, access.token, access.expiresAt);
  assertNoMasterSecrets(genericText);
  assert.ok(genericText.includes('不能自行编造售价'));
  assert.ok(genericText.includes('不提供目标项目的 GitHub、Cloudflare'));
});
