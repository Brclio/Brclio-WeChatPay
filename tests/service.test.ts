import assert from 'node:assert/strict';
import test from 'node:test';
import { hmac } from '../src/crypto.js';
import { PaymentService, orderPath, type OrderStore, type PaymentProvider } from '../src/service.js';
import { WechatError } from '../src/wechat.js';
import { HttpError, type Client, type Env, type Order, type Payment, type WechatTransaction } from '../src/types.js';

const client: Client = {
  id: 'product-one', name: 'Product One', apiKey: 'a'.repeat(64), webhookSecret: 'w'.repeat(64),
  webhookUrl: 'https://api.brclio.com/payment/webhook', returnOrigins: ['https://brclio.com', 'https://*.brclio.com'], channels: ['native', 'h5', 'jsapi', 'app'],
  products: { membership: { description: '年度会员', amount: 12900, maxQuantity: 3 } },
};
const env = {
  PUBLIC_BASE_URL: 'https://pay.bornforthis.cn', GITHUB_DATA_REPO: 'owner/private-data', ORDER_ID_SECRET: 'o'.repeat(64), CHECKOUT_SECRET: 'c'.repeat(64),
  WECHAT_MCH_ID: '1751349372', WECHAT_APP_ID: 'wx59aa532fbf6fa540', WECHAT_JSAPI_APP_ID: 'wx59aa532fbf6fa540', WECHAT_APP_APP_ID: 'wx0123456789abcdef',
  CLIENTS_JSON: JSON.stringify([client]), ENABLED_CHANNELS: 'native,h5,jsapi,app',
} as Env;
const input = { merchantOrderId: 'business-order-1', sku: 'membership', channel: 'native' as const, returnUrl: 'https://app.brclio.com/account' };

class MemoryStore implements OrderStore {
  values = new Map<string, unknown>();
  events: string[] = [];
  failWork = false;
  async read<T>(path: string): Promise<{ value: T; sha: string } | null> { return this.values.has(path) ? { value: structuredClone(this.values.get(path)) as T, sha: '0'.repeat(40) } : null; }
  async create<T>(path: string, value: T): Promise<boolean> {
    this.events.push(`create:${path}`);
    if (this.failWork && path.startsWith('work/')) throw new Error('Simulated durable-work failure');
    if (this.values.has(path)) return false;
    this.values.set(path, structuredClone(value));
    return true;
  }
  async update<T>(path: string, mutator: (value: T | null) => T | null): Promise<T | null> {
    const result = mutator(this.values.has(path) ? structuredClone(this.values.get(path)) as T : null);
    if (result === null) return null;
    this.values.set(path, structuredClone(result));
    this.events.push(`update:${path}`);
    return structuredClone(result);
  }
  async list(dir: string): Promise<Array<{ name: string; path: string; type: 'file' }>> {
    return [...this.values.keys()].filter((path) => path.startsWith(`${dir}/`) && !path.slice(dir.length + 1).includes('/')).map((path) => ({ path, name: path.slice(dir.length + 1), type: 'file' }));
  }
  async remove(path: string): Promise<void> { this.events.push(`remove:${path}`); this.values.delete(path); }
}

function transaction(order: Order, overrides: Partial<WechatTransaction> = {}): WechatTransaction {
  return { appid: order.appId, mchid: env.WECHAT_MCH_ID!, out_trade_no: order.id, trade_state: 'SUCCESS', trade_type: order.channel.toUpperCase(), transaction_id: '420000000000000000000001', success_time: new Date().toISOString(), amount: { total: order.total, currency: 'CNY' }, ...overrides };
}

class FakeProvider implements PaymentProvider {
  creates = 0;
  queries = 0;
  closes = 0;
  order?: Order;
  onCreate?: (order: Order) => Promise<Payment>;
  onQuery?: (id: string) => Promise<WechatTransaction>;
  onClose?: (id: string) => Promise<void>;
  async create(order: Order): Promise<Payment> { this.creates++; this.order = structuredClone(order); return this.onCreate ? this.onCreate(order) : { channel: 'native', codeUrl: 'weixin://wxpay/bizpayurl?pr=test' }; }
  async query(id: string): Promise<WechatTransaction> { this.queries++; return this.onQuery ? this.onQuery(id) : transaction(this.order!, { trade_state: 'NOTPAY', transaction_id: undefined, success_time: undefined }); }
  async close(id: string): Promise<void> { this.closes++; await this.onClose?.(id); }
}

function fixture(fetcher: typeof fetch = (async () => new Response(null, { status: 204 })) as typeof fetch) {
  const store = new MemoryStore();
  const provider = new FakeProvider();
  const service = new PaymentService(env, { store, provider, fetcher });
  return { store, provider, service };
}

test('price comes from configured SKU and order plus recovery index are durable before provider invocation', async () => {
  const { store, provider, service } = fixture();
  provider.onCreate = async (order) => {
    assert.ok(store.values.has(orderPath(order.id)));
    assert.ok(store.values.has(`work/${order.id}.json`));
    return { channel: 'native', codeUrl: 'weixin://wxpay/bizpayurl?pr=test' };
  };
  const order = await service.create(client, { ...input, quantity: 2 });
  assert.equal(order.total, 25800);
  assert.equal(order.status, 'PENDING');
  assert.equal(order.currency, 'CNY');
  await assert.rejects(service.create(client, { ...input, amount: 1 } as never), (error: unknown) => error instanceof HttpError && error.code === 'ORDER_FIELDS_INVALID');
});

test('same business order is idempotent and changing immutable content is rejected', async () => {
  const { provider, service } = fixture();
  const first = await service.create(client, input);
  const second = await service.create(client, input);
  assert.equal(second.id, first.id);
  assert.equal(provider.creates, 1);
  await assert.rejects(service.create(client, { ...input, quantity: 2 }), (error: unknown) => error instanceof HttpError && error.code === 'IDEMPOTENCY_CONFLICT');
  assert.equal(provider.creates, 1);
});

test('return URL matching rejects lookalike suffixes, credentials, and insecure origins', async () => {
  const { service } = fixture();
  for (const returnUrl of ['https://brclio.com.evil.example/return', 'https://evilbrclio.com/return', 'http://app.brclio.com/return', 'https://user:pass@app.brclio.com/return']) {
    await assert.rejects(service.create(client, { ...input, returnUrl }), (error: unknown) => error instanceof HttpError && error.code === 'RETURN_URL_INVALID');
  }
});

test('failed durable recovery-index creation prevents a provider charge request', async () => {
  const { store, provider, service } = fixture();
  store.failWork = true;
  await assert.rejects(service.create(client, input));
  assert.equal(provider.creates, 0);
  assert.equal([...store.values.values()].filter((value) => (value as Order).status === 'CREATING').length, 1);
});

test('mismatched merchant, application, amount, currency, and trade type never mark an order paid', async () => {
  const { service } = fixture();
  const order = await service.create(client, input);
  const variants: Partial<WechatTransaction>[] = [
    { mchid: 'another-merchant' }, { appid: 'wx0000000000000000' }, { amount: { total: 1, currency: 'CNY' } },
    { amount: { total: order.total, currency: 'USD' } }, { trade_type: 'APP' }, { transaction_id: '' }, { success_time: 'invalid' },
  ];
  for (const mismatch of variants) await assert.rejects(service.applyTransaction(transaction(order, mismatch)));
  assert.equal((await service.read(order.id)).status, 'PENDING');
  assert.equal((await service.read(order.id)).delivery, null);
});

test('duplicate success preserves outbox progress and a different transaction ID is rejected', async () => {
  const { store, service } = fixture();
  const order = await service.create(client, input);
  const paid = await service.applyTransaction(transaction(order));
  assert.equal(paid.status, 'SUCCESS');
  assert.equal(paid.delivery?.status, 'pending');
  await store.update<Order>(orderPath(order.id), (current) => ({ ...current!, delivery: { ...current!.delivery!, attempts: 3 } }));
  assert.equal((await service.applyTransaction(transaction(order))).delivery?.attempts, 3);
  await assert.rejects(service.applyTransaction(transaction(order, { transaction_id: '420000000000000000000002' })), (error: unknown) => error instanceof HttpError && error.code === 'TRANSACTION_CONFLICT');
});

test('a lost create response is recovered by querying the same durable order', async () => {
  const { store, provider, service } = fixture();
  provider.onCreate = async () => { throw new Error('Simulated lost response after provider accepted order'); };
  await assert.rejects(service.create(client, input));
  const order = provider.order!;
  assert.equal((await service.read(order.id)).status, 'CREATING');
  assert.ok(store.values.has(`work/${order.id}.json`));
  provider.onQuery = async () => transaction(order);
  const recovered = await service.refresh(order.id, true);
  assert.equal(recovered.status, 'SUCCESS');
  assert.equal(recovered.transactionId, transaction(order).transaction_id);
  assert.equal(recovered.delivery?.status, 'pending');
  assert.equal(provider.creates, 1);
});

test('canonical ORDER_NOT_EXIST on a never-submitted order recovers with the original out_trade_no', async () => {
  const { provider, service } = fixture();
  provider.onCreate = async () => { throw new Error('Simulated connection failure before acceptance'); };
  await assert.rejects(service.create(client, input));
  const originalId = provider.order!.id;
  provider.onCreate = async (order) => { assert.equal(order.id, originalId); return { channel: 'native', codeUrl: 'weixin://wxpay/bizpayurl?pr=recovered' }; };
  provider.onQuery = async () => { throw new WechatError('ORDER_NOT_EXIST'); };
  const recovered = await service.refresh(originalId, true);
  assert.equal(recovered.status, 'PENDING');
  assert.equal(provider.creates, 2);
});

test('expired unpaid orders close only after a provider-confirmed CLOSED query', async () => {
  const { store, provider, service } = fixture();
  const order = await service.create(client, input);
  await store.update<Order>(orderPath(order.id), (current) => ({ ...current!, expiresAt: new Date(Date.now() - 1000).toISOString() }));
  provider.onQuery = async () => transaction(order, { trade_state: provider.closes ? 'CLOSED' : 'NOTPAY', transaction_id: undefined, success_time: undefined });
  const closed = await service.refresh(order.id, true);
  assert.equal(closed.status, 'CLOSED');
  assert.equal(provider.closes, 1);
  assert.equal(provider.queries, 2);
  assert.equal(closed.delivery, null);
});

test('payment winning a close race is preserved and enters notification delivery', async () => {
  const { store, provider, service } = fixture();
  const order = await service.create(client, input);
  await store.update<Order>(orderPath(order.id), (current) => ({ ...current!, expiresAt: new Date(Date.now() - 1000).toISOString() }));
  provider.onQuery = async () => transaction(order, provider.queries === 1 ? { trade_state: 'NOTPAY', transaction_id: undefined, success_time: undefined } : {});
  provider.onClose = async () => { throw new WechatError('ORDERPAID'); };
  const paid = await service.refresh(order.id, true);
  assert.equal(paid.status, 'SUCCESS');
  assert.equal(paid.delivery?.status, 'pending');
});

test('signed webhook retries retain durable work, keep a stable event ID, and finish only on 2xx', async () => {
  const sent: Array<{ headers: Headers; body: string }> = [];
  const fetcher = (async (_request: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ headers: new Headers(init?.headers), body: String(init?.body) });
    return new Response(null, { status: sent.length === 1 ? 503 : 204 });
  }) as typeof fetch;
  const { store, service } = fixture(fetcher);
  const order = await service.create(client, input);
  await service.applyTransaction(transaction(order));
  const failed = await service.deliver(order.id);
  assert.equal(failed.delivery?.status, 'pending');
  assert.ok(store.values.has(`work/${order.id}.json`));
  await store.update<Order>(orderPath(order.id), (current) => ({ ...current!, delivery: { ...current!.delivery!, nextAt: new Date(0).toISOString() } }));
  const delivered = await service.deliver(order.id);
  assert.equal(delivered.delivery?.status, 'delivered');
  assert.equal(delivered.delivery?.attempts, 2);
  assert.equal(store.values.has(`work/${order.id}.json`), false);
  assert.equal(sent[0]!.headers.get('X-Brclio-Event'), sent[1]!.headers.get('X-Brclio-Event'));
  const request = sent[0]!;
  assert.equal(request.headers.get('X-Brclio-Signature'), await hmac(client.webhookSecret, `${request.headers.get('X-Brclio-Timestamp')}\n${request.headers.get('X-Brclio-Nonce')}\n${request.body}\n`));
});

test('concurrent delivery calls honor the durable lease', async () => {
  let notifications = 0;
  const { service } = fixture((async () => { notifications++; return new Response(null, { status: 204 }); }) as typeof fetch);
  const order = await service.create(client, input);
  await service.applyTransaction(transaction(order));
  await Promise.all([service.deliver(order.id), service.deliver(order.id)]);
  assert.equal(notifications, 1);
});

test('cron recovers an unnotified paid order, delivers it, and removes completed active work', async () => {
  const { store, provider, service } = fixture();
  const order = await service.create(client, input);
  provider.onQuery = async () => transaction(order);
  assert.deepEqual(await service.processWork(), { processed: 1, failed: 0 });
  const stored = await service.read(order.id);
  assert.equal(stored.status, 'SUCCESS');
  assert.equal(stored.delivery?.status, 'delivered');
  assert.ok(store.values.has(orderPath(order.id)));
  assert.equal(store.values.has(`work/${order.id}.json`), false);
});

test('duplicate remote create recovery queries once instead of recursively recreating a NOTPAY order', async () => {
  const { provider, service } = fixture();
  provider.onCreate = async () => { throw new WechatError('OUT_TRADE_NO_USED'); };
  const result = await service.create(client, input);
  assert.equal(result.status, 'CREATING');
  assert.equal(provider.creates, 1);
  assert.equal(provider.queries, 1);
});

test('delivered state is terminal even when retry uses a stale pending order snapshot', async () => {
  let notifications = 0;
  const { store, service } = fixture((async () => { notifications++; return new Response(null, { status: 204 }); }) as typeof fetch);
  const order = await service.create(client, input);
  const stale = await service.applyTransaction(transaction(order));
  const delivered = await service.deliver(order.id);
  await service.retryNotification(delivered);
  assert.equal(store.values.has(`work/${order.id}.json`), false);
  const afterStaleRetry = await service.retryNotification(stale);
  assert.equal(afterStaleRetry.delivery?.status, 'delivered');
  assert.equal(notifications, 1);
});

test('manual retry cannot reset an active outbound delivery lease', async () => {
  let notifications = 0;
  const { store, service } = fixture((async () => { notifications++; return new Response(null, { status: 204 }); }) as typeof fetch);
  const order = await service.create(client, input);
  const paid = await service.applyTransaction(transaction(order));
  await store.update<Order>(orderPath(order.id), (current) => ({ ...current!, delivery: { ...current!.delivery!, attempts: 7, leaseUntil: new Date(Date.now() + 60000).toISOString() } }));
  const result = await service.retryNotification(paid);
  assert.equal(result.delivery?.attempts, 7);
  assert.equal(notifications, 0);
});

test('H5 orders respect the five-minute payment-link lifetime and accept WeChat MWEB trade type', async () => {
  const { provider, service } = fixture();
  provider.onCreate = async () => ({ channel: 'h5', h5Url: 'https://wx.tenpay.com/cgi-bin/mmpayweb-bin/checkmweb?prepay_id=test' });
  const order = await service.create(client, { ...input, channel: 'h5', clientIp: '203.0.113.1' });
  const lifetime = Date.parse(order.expiresAt) - Date.parse(order.createdAt);
  assert.ok(lifetime <= 300050 && lifetime >= 299950);
  const paid = await service.applyTransaction(transaction(order, { trade_type: 'MWEB' }));
  assert.equal(paid.status, 'SUCCESS');
});
