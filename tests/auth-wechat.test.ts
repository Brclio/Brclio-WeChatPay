import assert from 'node:assert/strict';
import test from 'node:test';
import { authenticate, checkoutToken, verifyCheckout } from '../src/auth.js';
import { assertLive, clients, originMatches, validOriginPattern } from '../src/config.js';
import { bytesToBase64, hmac, rsaSign, rsaVerify } from '../src/crypto.js';
import { WechatError, WechatPay } from '../src/wechat.js';
import { HttpError, type Client, type Env, type Order } from '../src/types.js';

const client: Client = { id: 'product-one', name: 'Product One', apiKey: 'a'.repeat(64), webhookSecret: 'w'.repeat(64), webhookUrl: 'https://api.brclio.com/payment/webhook', returnOrigins: ['https://brclio.com', 'https://*.brclio.com'], channels: ['native'], products: { demo: { description: '测试商品', amount: 1 } } };
const env = { CLIENTS_JSON: JSON.stringify([client]), CHECKOUT_SECRET: 'c'.repeat(64), PUBLIC_BASE_URL: 'https://pay.bornforthis.cn', WECHAT_MCH_ID: '1751349372', WECHAT_SERIAL_NO: 'A'.repeat(40), WECHAT_JSAPI_CONTEXT: 'web' } as Env;
const publicId = 'PUB_KEY_ID_00000000000000000000000000000001';
let pemPair: Promise<{ privatePem: string; publicPem: string }> | undefined;
function pair() {
  return pemPair ??= (async () => {
    const keys = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
    return {
      privatePem: `-----BEGIN PRIVATE KEY-----\n${bytesToBase64(new Uint8Array(await crypto.subtle.exportKey('pkcs8', keys.privateKey) as ArrayBuffer))}\n-----END PRIVATE KEY-----`,
      publicPem: `-----BEGIN PUBLIC KEY-----\n${bytesToBase64(new Uint8Array(await crypto.subtle.exportKey('spki', keys.publicKey) as ArrayBuffer))}\n-----END PUBLIC KEY-----`,
    };
  })();
}
async function merchantEnv(): Promise<Env> {
  const keys = await pair();
  return { ...env, WECHAT_PRIVATE_KEY: keys.privatePem, WECHAT_PUBLIC_KEYS_JSON: JSON.stringify({ [publicId]: keys.publicPem }) };
}
async function signedResponse(value: unknown, status = 200, ageSeconds = 0): Promise<Response> {
  const body = status === 204 ? '' : JSON.stringify(value);
  const timestamp = String(Math.floor(Date.now() / 1000) - ageSeconds);
  const nonce = 'nonce0123456789abcdef';
  const signature = await rsaSign((await pair()).privatePem, `${timestamp}\n${nonce}\n${body}\n`);
  return new Response(status === 204 ? null : body, { status, headers: { 'Content-Type': 'application/json', 'Wechatpay-Timestamp': timestamp, 'Wechatpay-Nonce': nonce, 'Wechatpay-Serial': publicId, 'Wechatpay-Signature': signature } });
}
function order(channel: Order['channel']): Order {
  return { version: 1, id: 'a'.repeat(32), clientId: client.id, clientName: client.name, merchantOrderId: 'business1', sku: 'demo', quantity: 1, description: '测试商品', total: 1, currency: 'CNY', appId: 'wx0123456789abcdef', channel, status: 'CREATING', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 300000).toISOString(), requestHash: 'b'.repeat(64), delivery: null, payerOpenid: 'openid0123456789', clientIp: '203.0.113.1' };
}

test('product authentication binds method, exact path/query, timestamp, nonce, and body', async () => {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = '0123456789abcdef';
  const body = '{"sku":"demo"}';
  const path = '/api/v1/orders?check=1';
  const signature = await hmac(client.apiKey, `POST\n${path}\n${timestamp}\n${nonce}\n${body}\n`);
  const headers = { 'X-Brclio-Client': client.id, 'X-Brclio-Timestamp': timestamp, 'X-Brclio-Nonce': nonce, 'X-Brclio-Signature': signature };
  assert.equal((await authenticate(new Request(`https://pay.bornforthis.cn${path}`, { method: 'POST', headers }), body, env)).id, client.id);
  for (const [url, method, requestBody] of [[`https://pay.bornforthis.cn${path}`, 'POST', '{}'], ['https://pay.bornforthis.cn/api/v1/orders?check=2', 'POST', body], [`https://pay.bornforthis.cn${path}`, 'GET', body]]) {
    await assert.rejects(authenticate(new Request(url, { method, headers }), requestBody, env), (error: unknown) => error instanceof HttpError && error.status === 401);
  }
  const oldTimestamp = String(Math.floor(Date.now() / 1000) - 301);
  await assert.rejects(authenticate(new Request(`https://pay.bornforthis.cn${path}`, { method: 'POST', headers: { ...headers, 'X-Brclio-Timestamp': oldTimestamp } }), body, env));
});

test('checkout credentials authorize only the exact order ID', async () => {
  const first = 'a'.repeat(32), second = 'b'.repeat(32);
  const token = await checkoutToken(first, env);
  const request = new Request('https://pay.bornforthis.cn/api/checkout/a', { headers: { Authorization: `Bearer ${token}` } });
  await verifyCheckout(request, first, env);
  await assert.rejects(verifyCheckout(request, second, env));
});

test('origin wildcard matches only proper HTTPS subdomains and excludes lookalike domains', () => {
  assert.equal(validOriginPattern('https://*.brclio.com'), true);
  assert.equal(originMatches('https://app.brclio.com', 'https://*.brclio.com'), true);
  for (const origin of ['https://brclio.com', 'https://evilbrclio.com', 'https://app.brclio.com.evil.example', 'http://app.brclio.com', 'https://app.brclio.com:8443']) assert.equal(originMatches(origin, 'https://*.brclio.com'), false);
  assert.equal(validOriginPattern('https://brclio.com/path'), false);
});

test('missing or non-string client secrets fail configuration before authentication and delivery', () => {
  for (const invalid of [{ apiKey: undefined }, { webhookSecret: undefined }, { apiKey: 123 }, { webhookSecret: null }]) {
    assert.throws(() => clients({ ...env, CLIENTS_JSON: JSON.stringify([{ ...client, ...invalid }]) }), (error: unknown) => error instanceof HttpError && error.code === 'CLIENT_CONFIG_INVALID');
  }
});

test('merchant API request signs the exact GET path and query string', async () => {
  const configured = await merchantEnv();
  const provider = new WechatPay(configured, (async (input: RequestInfo | URL, init?: RequestInit) => {
    const authorization = new Headers(init?.headers).get('Authorization')!;
    assert.equal(new Headers(init?.headers).get('Wechatpay-Serial'), publicId);
    const parameters = Object.fromEntries([...authorization.matchAll(/([a-z_]+)="([^"]*)"/g)].map((match) => [match[1], match[2]]));
    const url = new URL(String(input));
    const canonical = `GET\n${url.pathname}${url.search}\n${parameters.timestamp}\n${parameters.nonce_str}\n\n`;
    assert.equal(await rsaVerify((await pair()).publicPem, canonical, parameters.signature!), true);
    assert.equal(parameters.mchid, configured.WECHAT_MCH_ID);
    assert.equal(init?.body, undefined);
    return signedResponse({ out_trade_no: 'a'.repeat(32), trade_state: 'NOTPAY' });
  }) as typeof fetch);
  await provider.query('a'.repeat(32));
});

test('successful 204 close responses are verified against the empty response body', async () => {
  const configured = await merchantEnv();
  const provider = new WechatPay(configured, (async () => signedResponse(undefined, 204)) as typeof fetch);
  await provider.close('a'.repeat(32));
  const unsigned = new WechatPay(configured, (async () => new Response(null, { status: 204 })) as typeof fetch);
  await assert.rejects(unsigned.close('a'.repeat(32)), (error: unknown) => error instanceof HttpError && error.code === 'WECHAT_SIGNATURE_INVALID');
});

test('old signed provider responses and test signatures are rejected', async () => {
  const configured = await merchantEnv();
  const provider = new WechatPay(configured);
  const old = await signedResponse({}, 200, 301);
  await assert.rejects(provider.verify(old.headers, await old.text()));
  const probe = await signedResponse({});
  probe.headers.set('Wechatpay-Signature', 'WECHATPAY/SIGNTEST/probe');
  await assert.rejects(provider.verify(probe.headers, await probe.text()));
});

test('APP and JSAPI SDK signatures use their different fourth canonical lines', async () => {
  const configured = await merchantEnv();
  const prepayId = 'wx1234567890prepay';
  const provider = new WechatPay(configured, (async () => signedResponse({ prepay_id: prepayId })) as typeof fetch);
  const app = (await provider.create(order('app'))).app!;
  assert.equal(app.package, 'Sign=WXPay');
  assert.equal(await rsaVerify((await pair()).publicPem, `${app.appid}\n${app.timestamp}\n${app.noncestr}\n${prepayId}\n`, app.sign), true);
  const jsapi = (await provider.create(order('jsapi'))).jsapi!;
  assert.equal(jsapi.package, `prepay_id=${prepayId}`);
  assert.equal(await rsaVerify((await pair()).publicPem, `${jsapi.appId}\n${jsapi.timeStamp}\n${jsapi.nonceStr}\nprepay_id=${prepayId}\n`, jsapi.paySign), true);
});

test('signed canonical ORDER_NOT_EXIST preserves a recoverable provider error code', async () => {
  const provider = new WechatPay(await merchantEnv(), (async () => signedResponse({ code: 'ORDER_NOT_EXIST', message: '订单不存在' }, 404)) as typeof fetch);
  await assert.rejects(provider.query('a'.repeat(32)), (error: unknown) => error instanceof WechatError && error.providerCode === 'ORDER_NOT_EXIST');
});

test('live configuration rejects unusable key maps and storage key lengths before provider calls', async () => {
  const baseline: Env = { ...await merchantEnv(), PAYMENT_MODE: 'live', PAYMENT_ENABLED: 'true', GITHUB_TOKEN: 'test-github-token', GITHUB_DATA_REPO: 'owner/private-data', ORDER_ID_SECRET: 'o'.repeat(64), ENCRYPTION_KEY: bytesToBase64(new Uint8Array(32)), WECHAT_APP_ID: 'wx0123456789abcdef', WECHAT_API_V3_KEY: 'v'.repeat(32), ALLOWED_ORIGINS: 'https://brclio.com' };
  assert.doesNotThrow(() => assertLive(baseline));
  for (const override of [{ WECHAT_PUBLIC_KEYS_JSON: '{}' }, { WECHAT_PUBLIC_KEYS_JSON: 'null' }, { WECHAT_PUBLIC_KEYS_JSON: '[]' }, { WECHAT_PUBLIC_KEYS_JSON: JSON.stringify({ [publicId]: 123 }) }, { ENCRYPTION_KEY: bytesToBase64(new Uint8Array(31)) }, { WECHAT_MCH_ID: 'bad-merchant' }]) {
    assert.throws(() => assertLive({ ...baseline, ...override }), (error: unknown) => error instanceof HttpError && error.status === 503);
  }
});
