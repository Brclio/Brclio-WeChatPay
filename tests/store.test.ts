import assert from 'node:assert/strict';
import test from 'node:test';
import { base64ToBytes, bytesToBase64, encryptJson } from '../src/crypto.js';
import { GithubStore, StoreError } from '../src/store.js';

const repo = 'test-owner/private-data';
const encryptionKey = bytesToBase64(new Uint8Array(32).fill(19));
const encoder = new TextEncoder();
const decoder = new TextDecoder();
type DataFile = { sha: string; content: string };

class FakeGithub {
  files = new Map<string, DataFile>();
  calls: Array<{ url: URL; method: string; body: Record<string, unknown> | null }> = [];
  isPrivate = true;
  branch = 'main';
  nextSha = 1;
  conflict?: (path: string) => Promise<void>;
  listing?: unknown[];

  async seed(path: string, value: unknown): Promise<void> {
    this.files.set(path, { sha: (this.nextSha++).toString(16).padStart(40, '0'), content: bytesToBase64(encoder.encode(JSON.stringify(await encryptJson(encryptionKey, value, `${repo}:${path}`)))) });
  }

  fetcher = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    this.calls.push({ url, method, body });
    const prefix = `/repos/${repo}/contents/`;
    if (!url.pathname.startsWith(prefix)) return Response.json({ private: this.isPrivate, default_branch: this.branch });
    const path = decodeURIComponent(url.pathname.slice(prefix.length));
    if (method === 'GET') {
      if (this.listing) return Response.json(this.listing);
      const file = this.files.get(path);
      return file ? Response.json({ ...file, type: 'file', encoding: 'base64' }) : new Response('missing', { status: 404 });
    }
    if (method === 'PUT') {
      if (this.conflict) {
        const hook = this.conflict;
        this.conflict = undefined;
        await hook(path);
        return new Response('conflict', { status: 409 });
      }
      const current = this.files.get(path);
      if ((current?.sha ?? undefined) !== body?.sha) return new Response('conflict', { status: current && !body?.sha ? 422 : 409 });
      this.files.set(path, { sha: (this.nextSha++).toString(16).padStart(40, '0'), content: String(body?.content) });
      return Response.json({ content: { sha: this.files.get(path)!.sha } }, { status: current ? 200 : 201 });
    }
    if (method === 'DELETE') {
      const current = this.files.get(path);
      if (!current) return new Response('missing', { status: 404 });
      if (body?.sha !== current.sha) return new Response('conflict', { status: 409 });
      this.files.delete(path);
      return Response.json({ content: null });
    }
    throw new Error('Unexpected test request');
  }) as typeof fetch;

  store(options: { requestTimeoutMs?: number; branch?: string } = {}): GithubStore {
    return new GithubStore({ token: 'test-credential-never-log', repo, encryptionKey, fetcher: this.fetcher, ...options });
  }
}

function code(expected: string): (error: unknown) => boolean {
  return (error) => error instanceof StoreError && error.code === expected;
}

test('empty private repositories accept first encrypted creation on their default branch', async () => {
  const fake = new FakeGithub();
  fake.branch = 'payments/main';
  const store = fake.store();
  const value = { orderId: 'order1', customerEmail: 'customer@example.test', total: 123 };
  assert.equal(await store.create('orders/ab/order1.json', value), true);
  assert.deepEqual((await store.read('orders/ab/order1.json'))?.value, value);
  const put = fake.calls.find((call) => call.method === 'PUT')!;
  assert.equal(put.body?.branch, 'payments/main');
  assert.equal(put.body?.sha, undefined);
  const stored = decoder.decode(base64ToBytes(String(put.body?.content)));
  assert.equal(stored.includes('customer@example.test'), false);
  assert.equal(JSON.parse(stored).algorithm, 'AES-256-GCM');
  assert.equal(fake.calls.at(-1)!.url.search, '?ref=payments%2Fmain');
});

test('public repositories are never written and inspection state can revoke a cached private check', async () => {
  const fake = new FakeGithub();
  fake.isPrivate = false;
  const store = fake.store();
  await assert.rejects(store.create('orders/a.json', {}), code('REPOSITORY_NOT_PRIVATE'));
  assert.equal(fake.calls.some((call) => call.method === 'PUT'), false);
  fake.isPrivate = true;
  await store.create('orders/a.json', {});
  fake.isPrivate = false;
  assert.equal((await store.inspect()).private, false);
  await assert.rejects(store.update('orders/a.json', () => ({})), code('REPOSITORY_NOT_PRIVATE'));
});

test('CAS retry re-reads the winning update before recomputing the next state', async () => {
  const fake = new FakeGithub();
  await fake.seed('orders/a.json', { count: 1 });
  fake.conflict = async (path) => { await fake.seed(path, { count: 5 }); };
  let mutations = 0;
  const store = fake.store();
  const result = await store.update<{ count: number }>('orders/a.json', (current) => {
    mutations += 1;
    return { count: current!.count + 1 };
  });
  assert.deepEqual(result, { count: 6 });
  assert.equal(mutations, 2);
  assert.deepEqual((await store.read('orders/a.json'))?.value, { count: 6 });
  const puts = fake.calls.filter((call) => call.method === 'PUT');
  assert.notEqual(puts[0]!.body?.sha, puts[1]!.body?.sha);
});

test('create conflicts preserve existing data; a null update performs no mutation', async () => {
  const fake = new FakeGithub();
  await fake.seed('orders/a.json', { amount: 100 });
  const store = fake.store();
  assert.equal(await store.create('orders/a.json', { amount: 1 }), false);
  const before = fake.calls.length;
  assert.equal(await store.update('orders/a.json', () => null), null);
  assert.equal(fake.calls.slice(before).some((call) => call.method === 'PUT'), false);
  assert.deepEqual((await store.read('orders/a.json'))?.value, { amount: 100 });
});

test('only active work entries can be removed, with SHA protection and idempotent absence', async () => {
  const fake = new FakeGithub();
  await fake.seed('work/order1.json', { orderId: 'order1' });
  const sha = fake.files.get('work/order1.json')!.sha;
  const store = fake.store();
  await assert.rejects(store.remove('orders/aa/order1.json'), code('STORAGE_DELETE_FORBIDDEN'));
  await store.remove('work/order1.json');
  await store.remove('work/order1.json');
  assert.equal(fake.files.has('work/order1.json'), false);
  assert.equal(fake.calls.find((call) => call.method === 'DELETE')!.body?.sha, sha);
  assert.equal(fake.calls.filter((call) => call.method === 'DELETE').length, 1);
  assert.equal(fake.calls.filter((call) => !call.url.pathname.includes('/contents/')).length, 1);
});

test('GitHub request deadlines hold even when a fetch implementation ignores abort', async () => {
  const store = new GithubStore({ token: 'secret-token-value', repo, encryptionKey, requestTimeoutMs: 10, fetcher: (() => new Promise<Response>(() => {})) as typeof fetch });
  await assert.rejects(store.inspect(), (error: unknown) => error instanceof StoreError && error.code === 'GITHUB_TIMEOUT' && error.status === 503 && !error.message.includes('secret-token-value'));
});

test('network and upstream errors do not expose credentials or raw error text', async () => {
  const store = new GithubStore({ token: 'secret-token-value', repo, encryptionKey, fetcher: (async () => { throw new Error('secret-token-value: confidential upstream URL'); }) as typeof fetch });
  await assert.rejects(store.inspect(), (error: unknown) => error instanceof StoreError && error.code === 'GITHUB_NETWORK_ERROR' && !error.message.includes('secret-token-value'));
});

test('encrypted records cannot be copied between paths and ciphertext tampering fails closed', async () => {
  const fake = new FakeGithub();
  await fake.seed('orders/a.json', { amount: 100 });
  fake.files.set('orders/b.json', fake.files.get('orders/a.json')!);
  await assert.rejects(fake.store().read('orders/b.json'), code('STORAGE_DECRYPTION_FAILED'));
  const file = fake.files.get('orders/a.json')!;
  const envelope = JSON.parse(decoder.decode(base64ToBytes(file.content)));
  const encrypted = base64ToBytes(envelope.ciphertext);
  encrypted[0] = encrypted[0]! ^ 1;
  envelope.ciphertext = bytesToBase64(encrypted);
  file.content = bytesToBase64(encoder.encode(JSON.stringify(envelope)));
  await assert.rejects(fake.store().read('orders/a.json'), code('STORAGE_DECRYPTION_FAILED'));
});

test('directory listings fail explicitly at the GitHub truncation limit', async () => {
  const fake = new FakeGithub();
  fake.listing = Array.from({ length: 1000 }, (_, index) => ({ name: `${index}.json`, path: `work/${index}.json`, type: 'file' }));
  await assert.rejects(fake.store().list('work'), code('GITHUB_DIRECTORY_LIMIT'));
  fake.listing = [{ name: 'a.json', path: 'work/a.json', type: 'file' }];
  assert.deepEqual(await fake.store().list('work'), fake.listing);
});

test('arbitrary URLs, path traversal, and special path characters are rejected before fetch', async () => {
  const fake = new FakeGithub();
  const store = fake.store();
  for (const path of ['../secret', 'orders/../secret', '/orders/a', 'https://evil.test/a', 'orders/a?ref=main', 'orders/a#b', 'orders/%2e%2e/a']) {
    await assert.rejects(store.read(path), code('INVALID_STORAGE_PATH'));
  }
  assert.equal(fake.calls.length, 0);
});
