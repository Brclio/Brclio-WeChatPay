import assert from 'node:assert/strict';
import test from 'node:test';
import { authenticate } from '../src/auth.js';
import { base64ToBytes, bytesToBase64, decryptJson, encryptJson, hmac } from '../src/crypto.js';
import { loadClients, maskedClient, runtimeEnv, saveClient } from '../src/registry.js';
import { PaymentService } from '../src/service.js';
import { StoreError } from '../src/store.js';
import { HttpError, type Client, type Env } from '../src/types.js';

const repo = 'test-owner/private-data';
const encryptionKey = bytesToBase64(new Uint8Array(32).fill(31));
const path = 'config/clients.json';
const client: Client = { id: 'product-one', name: '产品一', apiKey: 'api-key-fixture-'.repeat(5), webhookSecret: 'webhook-key-fixture-'.repeat(5), webhookUrl: 'https://api.brclio.com/webhook', returnOrigins: ['https://brclio.com', 'https://*.brclio.com'], channels: ['native'], products: { member: { description: '年度会员', amount: 12900 } } };
const env = { PUBLIC_BASE_URL: 'https://pay.bornforthis.cn', GITHUB_DATA_REPO: repo, GITHUB_DATA_BRANCH: 'main', GITHUB_TOKEN: 'test-github-credential', ENCRYPTION_KEY: encryptionKey, CLIENTS_JSON: '[]', ENABLED_CHANNELS: 'native', WECHAT_APP_ID: 'wx59aa532fbf6fa540', CHECKOUT_SECRET: 'c'.repeat(64), ORDER_ID_SECRET: 'o'.repeat(64) } as Env;
function editable(c: Client): Record<string, unknown> {
  const { apiKey: _apiKey, webhookSecret: _hookSecret, ...rest } = c;
  return rest;
}

class FakeGithub {
  file: { sha: string; content: string } | null = null;
  sequence = 0;
  isPrivate = true;
  writes = 0;
  beforeConflict?: () => Promise<void>;
  requests: Array<{ url: string; body?: Record<string, unknown> }> = [];
  async seed(clients: Client[]): Promise<void> {
    const value = { version: 1, clients };
    const encrypted = await encryptJson(encryptionKey, value, `${repo}:${path}`);
    this.file = { sha: (++this.sequence).toString(16).padStart(40, '0'), content: bytesToBase64(new TextEncoder().encode(JSON.stringify(encrypted))) };
  }
  async stored(): Promise<{ version: 1; clients: Client[] }> {
    const envelope = JSON.parse(new TextDecoder().decode(base64ToBytes(this.file!.content)));
    return decryptJson(encryptionKey, envelope, `${repo}:${path}`);
  }
  fetcher = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://api.github.com');
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    this.requests.push({ url: url.href, body });
    if (url.pathname === `/repos/${repo}`) return Response.json({ private: this.isPrivate, default_branch: 'main' });
    if (init?.method==='GET' && (url.pathname.startsWith(`/repos/${repo}/contents/orders/`) || url.pathname.startsWith(`/repos/${repo}/contents/work/`))) return new Response(null,{status:404});
    assert.equal(url.pathname, `/repos/${repo}/contents/${path}`);
    if (init?.method === 'GET') return this.file ? Response.json({ ...this.file, encoding: 'base64', type: 'file' }) : new Response(null, { status: 404 });
    assert.equal(init?.method, 'PUT');
    this.writes++;
    if (this.beforeConflict) {
      const action = this.beforeConflict;
      this.beforeConflict = undefined;
      await action();
      return new Response(null, { status: 409 });
    }
    if ((this.file?.sha ?? undefined) !== body.sha) return new Response(null, { status: 409 });
    this.file = { sha: (++this.sequence).toString(16).padStart(40, '0'), content: body.content };
    return Response.json({ content: { sha: this.file.sha } }, { status: 201 });
  }) as typeof fetch;
}

test('new products receive independent random credentials encrypted in the private repository', async (t) => {
  const github = new FakeGithub();
  t.mock.method(globalThis, 'fetch', github.fetcher);
  const saved = await saveClient(env, { ...editable(client), apiKey: 'attacker-provided-key', webhookSecret: 'attacker-provided-webhook-key' });
  assert.match(saved.apiKey, /^[a-f0-9]{64}$/);
  assert.match(saved.webhookSecret, /^[a-f0-9]{64}$/);
  assert.notEqual(saved.apiKey, saved.webhookSecret);
  assert.deepEqual((await github.stored()).clients, [saved]);
  const storedText = new TextDecoder().decode(base64ToBytes(github.file!.content));
  assert.equal(storedText.includes(saved.apiKey), false);
  assert.equal(storedText.includes(saved.webhookSecret), false);
  assert.equal(storedText.includes(client.webhookUrl), false);
});

test('catalog edits preserve existing credentials and credential rotation preserves catalog fields', async (t) => {
  const github = new FakeGithub();
  await github.seed([client]);
  t.mock.method(globalThis, 'fetch', github.fetcher);
  const edited = await saveClient(env, { ...editable(client), name: '新名称', products: { member: { description: '会员更新', amount: 19900 } }, apiKey: 'ignored', webhookSecret: 'ignored' });
  assert.equal(edited.apiKey, client.apiKey);
  assert.equal(edited.webhookSecret, client.webhookSecret);
  const rotated = await saveClient(env, { id: client.id }, true);
  assert.notEqual(rotated.apiKey, client.apiKey);
  assert.notEqual(rotated.webhookSecret, client.webhookSecret);
  assert.equal(rotated.name, edited.name);
  assert.deepEqual(rotated.products, edited.products);
  assert.equal(rotated.webhookUrl, client.webhookUrl);
  assert.deepEqual((await loadClients(env))[0], rotated);
});

test('public repositories reject catalog writes before any credential material is committed', async (t) => {
  const github = new FakeGithub();
  github.isPrivate = false;
  t.mock.method(globalThis, 'fetch', github.fetcher);
  await assert.rejects(saveClient(env, editable(client)), (error: unknown) => error instanceof StoreError && error.code === 'REPOSITORY_NOT_PRIVATE');
  assert.equal(github.writes, 0);
});

test('callback validation rejects unsafe schemes, IP literals, local domains, ports, and credentials', async (t) => {
  const github = new FakeGithub();
  t.mock.method(globalThis, 'fetch', github.fetcher);
  for (const webhookUrl of ['http://api.brclio.com/webhook', 'https://127.0.0.1/webhook', 'https://[::1]/webhook', 'https://localhost/webhook', 'https://service.internal/webhook', 'https://api.brclio.com:8443/webhook', 'https://user:password@api.brclio.com/webhook', 'file:///tmp/webhook']) {
    await assert.rejects(saveClient(env, { ...editable(client), webhookUrl }), (error: unknown) => error instanceof HttpError && error.code === 'CLIENT_CONFIG_INVALID');
  }
  assert.equal(github.writes, 0);
});

test('catalog validation rejects noninteger amounts, unregistered origins, and invalid product IDs', async (t) => {
  const github = new FakeGithub();
  t.mock.method(globalThis, 'fetch', github.fetcher);
  for (const invalid of [{ id: '../another' }, { returnOrigins: ['http://brclio.com'] }, { products: { member: { description: '会员', amount: 1.5 } } }, { products: { member: { description: '会员', amount: -1 } } }]) {
    await assert.rejects(saveClient(env, { ...editable(client), ...invalid }), (error: unknown) => error instanceof HttpError && error.status === 400);
  }
  assert.equal(github.writes, 0);
});

test('runtime registry overlays baseline clients and masks both complete secrets from listing records', async (t) => {
  const github = new FakeGithub();
  await github.seed([{ ...client, name: '来自加密目录的更新名称' }]);
  t.mock.method(globalThis, 'fetch', github.fetcher);
  const runtime = await runtimeEnv({ ...env, CLIENTS_JSON: JSON.stringify([client]) });
  const active = JSON.parse(runtime.CLIENTS_JSON!) as Client[];
  assert.equal(active.length, 1);
  assert.equal(active[0]!.name, '来自加密目录的更新名称');
  const masked = maskedClient(active[0]!);
  assert.equal(Object.hasOwn(masked, 'apiKey'), false);
  assert.equal(Object.hasOwn(masked, 'webhookSecret'), false);
  assert.equal(JSON.stringify(masked).includes(client.apiKey), false);
  assert.equal(JSON.stringify(masked).includes(client.webhookSecret), false);
});

test('disabled runtime clients still authenticate signed queries but cannot create new orders', async (t) => {
  const github = new FakeGithub();
  await github.seed([{ ...client, disabled: true }]);
  t.mock.method(globalThis, 'fetch', github.fetcher);
  const runtime = await runtimeEnv(env);
  const timestamp = String(Math.floor(Date.now() / 1000)), nonce = '0123456789abcdef';
  const requestPath = '/api/v1/orders/' + 'a'.repeat(32);
  const signature = await hmac(client.apiKey, `GET\n${requestPath}\n${timestamp}\n${nonce}\n\n`);
  const authenticated = await authenticate(new Request(runtime.PUBLIC_BASE_URL + requestPath, { headers: { 'X-Brclio-Client': client.id, 'X-Brclio-Timestamp': timestamp, 'X-Brclio-Nonce': nonce, 'X-Brclio-Signature': signature } }), '', runtime);
  assert.equal(authenticated.disabled, true);
  let providerCreates = 0;
  const service = new PaymentService(runtime, { provider: { async create() { providerCreates++; throw new Error('Must not create'); }, async query() { throw new Error('Not used'); }, async close() {} } });
  await assert.rejects(service.create(authenticated, { merchantOrderId: 'new-order', sku: 'member', channel: 'native' }), (error: unknown) => error instanceof HttpError && error.code === 'CLIENT_DISABLED');
  assert.equal(providerCreates, 0);
  assert.equal(github.writes,0);
});

test('CAS retry preserves another administrator catalog update and stable generated keys', async (t) => {
  const github = new FakeGithub();
  await github.seed([client]);
  const concurrentlyAdded = { ...client, id: 'product-two', apiKey: 'second-api-'.repeat(8), webhookSecret: 'second-hook-'.repeat(8) };
  github.beforeConflict = async () => { await github.seed([client, concurrentlyAdded]); };
  t.mock.method(globalThis, 'fetch', github.fetcher);
  const added = await saveClient(env, { ...editable(client), id: 'product-three' });
  const stored = (await github.stored()).clients;
  assert.deepEqual(stored.map((entry) => entry.id).sort(), ['product-one', 'product-three', 'product-two']);
  assert.equal(stored.find((entry) => entry.id === 'product-one')!.apiKey, client.apiKey);
  assert.equal(stored.find((entry) => entry.id === 'product-three')!.apiKey, added.apiKey);
  assert.equal(github.writes, 2);
});

test('an env baseline client added after registry creation remains rotatable', async (t) => {
  const github = new FakeGithub();
  await github.seed([client]);
  t.mock.method(globalThis, 'fetch', github.fetcher);
  const addedBaseline = { ...client, id: 'new-baseline-product', apiKey: 'new-baseline-api-'.repeat(5), webhookSecret: 'new-baseline-hook-'.repeat(5) };
  const withBaseline = { ...env, CLIENTS_JSON: JSON.stringify([client, addedBaseline]) };
  assert.ok((await loadClients(withBaseline)).some((entry) => entry.id === addedBaseline.id));
  const rotated = await saveClient(withBaseline, { id: addedBaseline.id }, true);
  assert.notEqual(rotated.apiKey, addedBaseline.apiKey);
  assert.ok((await loadClients(withBaseline)).some((entry) => entry.id === client.id));
});
