import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, pbkdf2Sync } from 'node:crypto';
import test from 'node:test';
import { authenticate, checkoutToken } from '../src/auth.js';
import { bytesToBase64, encryptJson, rsaSign } from '../src/crypto.js';
import worker from '../src/index.js';
import { integrationSkill } from '../src/skill.js';
import { PaymentService } from '../src/service.js';
import { HttpError, type Client, type Env, type Order, type WechatTransaction } from '../src/types.js';

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
function existingOrder(id:string,extra:Partial<Order>={}):Order {
  const createdAt=new Date().toISOString();
  return {version:1,id,clientId:client.id,clientName:client.name,merchantOrderId:'paused-existing',sku:'coin',quantity:1,description:client.products.coin.description,total:1,currency:'CNY',appId:'wx59aa532fbf6fa540',channel:'native',status:'PENDING',createdAt,expiresAt:new Date(Date.parse(createdAt)+300000).toISOString(),requestHash:'a'.repeat(64),delivery:null,...extra};
}
function signedProductRequest(path:string,method='GET'):Request {
  const timestamp=String(Math.floor(Date.now()/1000)),nonce='fixture-paused-request-nonce';
  const signature=createHmac('sha256',client.apiKey).update(`${method}\n${path}\n${timestamp}\n${nonce}\n\n`).digest('hex');
  return request(path,{method,headers:{'X-Brclio-Client':client.id,'X-Brclio-Timestamp':timestamp,'X-Brclio-Nonce':nonce,'X-Brclio-Signature':signature}});
}
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

test('pausing live collection blocks new orders before authentication, registry, or provider access',async(t)=>{
  const calls=denyNetwork(t),env={...environment(true),PAYMENT_ENABLED:'false'};
  let creates=0;t.mock.method(PaymentService.prototype,'create',async()=>{creates++;throw Error('Creation must stay paused');});
  const response=await worker.fetch(request('/api/v1/orders',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}),env,context());
  assert.equal(response.status,503);assert.equal((await response.json() as {error:{code:string}}).error.code,'PAYMENTS_DISABLED');
  assert.equal(creates,0);assert.equal(calls(),0);
});

test('paused live maintenance still rejects missing checkout/product/provider credentials before storage',async(t)=>{
  const calls=denyNetwork(t),env={...environment(true),PAYMENT_ENABLED:'false'},id='1'.repeat(32);
  for (const [path,method] of [[`/api/checkout/${id}`,'GET'],[`/api/checkout/${id}/refresh`,'POST'],[`/api/v1/orders/${id}`,'GET'],[`/api/v1/orders/${id}/refresh`,'POST'],['/api/wechat/notify','POST']]) {
    const response=await worker.fetch(request(path,{method}),env,context());assert.equal(response.status,401);
  }
  assert.equal(calls(),0);
});

test('authenticated checkout and product order reads and refresh remain available during a live collection pause',async(t)=>{
  const env={...environment(true),PAYMENT_ENABLED:'false'},id='2'.repeat(32),order=existingOrder(id);
  let reads=0,refreshes=0;
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{
    const url=new URL(String(input));assert.equal(url.origin,'https://api.github.com');assert.equal(init?.method,'GET');assert.equal(url.pathname,`/repos/${repo}/contents/config/clients.json`);
    return new Response(null,{status:404});
  });
  t.mock.method(PaymentService.prototype,'read',async(requestedId:string)=>{assert.equal(requestedId,id);reads++;return order;});
  t.mock.method(PaymentService.prototype,'refresh',async(requestedId:string)=>{assert.equal(requestedId,id);refreshes++;return {...order,status:'CLOSED',closeReason:'timeout'} as Order;});
  const bearer={Authorization:'Bearer '+await checkoutToken(id,env)};
  const requests=[request(`/api/checkout/${id}`,{headers:bearer}),request(`/api/checkout/${id}/refresh`,{method:'POST',headers:bearer}),signedProductRequest(`/api/v1/orders/${id}`),signedProductRequest(`/api/v1/orders/${id}/refresh`,'POST')];
  for (let index=0;index<requests.length;index++) {
    const response=await worker.fetch(requests[index],env,context());assert.equal(response.status,200);
    const result=await response.json() as {id:string;status:string};assert.equal(result.id,id);assert.equal(result.status,index%2?'CLOSED':'PENDING');
  }
  assert.equal(reads,3);assert.equal(refreshes,2);
});

test('a signed encrypted WeChat payment notification persists before acknowledgement during a live collection pause',async(t)=>{
  const env={...environment(true),PAYMENT_ENABLED:'false'},id='3'.repeat(32),paid=existingOrder(id,{status:'SUCCESS',transactionId:'420000000000000000000003',paidAt:new Date().toISOString(),delivery:{status:'pending',attempts:0,nextAt:new Date().toISOString()}});
  const transaction:WechatTransaction={appid:paid.appId,mchid:env.WECHAT_MCH_ID!,out_trade_no:id,trade_state:'SUCCESS',transaction_id:paid.transactionId,success_time:paid.paidAt,amount:{total:paid.total,currency:'CNY'}};
  const encoder=new TextEncoder(),nonce='0123456789ab',associatedData='fixture-notification';
  const key=await crypto.subtle.importKey('raw',encoder.encode(env.WECHAT_API_V3_KEY!),'AES-GCM',false,['encrypt']);
  const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv:encoder.encode(nonce),additionalData:encoder.encode(associatedData)},key,encoder.encode(JSON.stringify(transaction)));
  const raw=JSON.stringify({event_type:'TRANSACTION.SUCCESS',resource_type:'encrypt-resource',resource:{algorithm:'AEAD_AES_256_GCM',original_type:'transaction',ciphertext:bytesToBase64(new Uint8Array(encrypted)),nonce,associated_data:associatedData}});
  const timestamp=String(Math.floor(Date.now()/1000)),signatureNonce='fixture-callback-nonce';
  const signature=await rsaSign(keyPair.privateKey,`${timestamp}\n${signatureNonce}\n${raw}\n`);
  let persisted=false,delivered=0,failPersistence=false;const pending:Promise<unknown>[]=[];
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{
    const url=new URL(String(input));assert.equal(url.origin,'https://api.github.com');assert.equal(init?.method,'GET');assert.equal(url.pathname,`/repos/${repo}/contents/config/clients.json`);
    return new Response(null,{status:404});
  });
  t.mock.method(PaymentService.prototype,'applyTransaction',async(value:WechatTransaction)=>{assert.deepEqual(value,transaction);if(failPersistence)throw new HttpError(503,'STORAGE_UNAVAILABLE','Fixture storage unavailable');await Promise.resolve();persisted=true;return paid;});
  t.mock.method(PaymentService.prototype,'deliver',async(requestedId:string)=>{assert.equal(requestedId,id);assert.equal(persisted,true);delivered++;return paid;});
  const headers={'Content-Type':'application/json','Wechatpay-Timestamp':timestamp,'Wechatpay-Nonce':signatureNonce,'Wechatpay-Serial':'PUB_KEY_ID_00000000000000000000000000000001','Wechatpay-Signature':signature};
  const response=await worker.fetch(request('/api/wechat/notify',{method:'POST',headers,body:raw}),env,{waitUntil:(work:Promise<unknown>)=>pending.push(work)} as unknown as ExecutionContext);
  assert.equal(response.status,204);assert.equal(persisted,true);await Promise.all(pending);assert.equal(delivered,1);
  failPersistence=true;persisted=false;t.mock.method(console,'error',()=>{});
  const failed=await worker.fetch(request('/api/wechat/notify',{method:'POST',headers,body:raw}),env,context());
  assert.equal(failed.status,503);assert.equal(persisted,false);assert.equal(delivered,1);
});

test('paused live scheduled reconciliation still runs while demo scheduling remains inert',async(t)=>{
  const live={...environment(true),PAYMENT_ENABLED:'false'};let runs=0;
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{
    const url=new URL(String(input));assert.equal(url.origin,'https://api.github.com');assert.equal(init?.method,'GET');assert.equal(url.pathname,`/repos/${repo}/contents/config/clients.json`);
    return new Response(null,{status:404});
  });
  t.mock.method(PaymentService.prototype,'processWork',async(scheduledTime:number)=>{assert.equal(scheduledTime,123456);runs++;return {processed:1,failed:0};});
  await worker.scheduled({scheduledTime:123456} as ScheduledController,live,context());assert.equal(runs,1);
  await worker.scheduled({scheduledTime:123456} as ScheduledController,{...live,PAYMENT_MODE:'demo'},context());assert.equal(runs,1);
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

test('checkout GET enforces the five-minute expiry even while its pending snapshot remains cached', async (t) => {
  const env=environment(true),id='e'.repeat(32),now=Date.now();
  let clock=now+299000,refreshes=0,reads=0;
  const order:Order={version:1,id,clientId:client.id,clientName:client.name,merchantOrderId:'expiry-http',sku:'coin',quantity:1,description:'过期订单',total:1,currency:'CNY',appId:env.WECHAT_APP_ID!,channel:'native',status:'PENDING',createdAt:new Date(now).toISOString(),expiresAt:new Date(now+900000).toISOString(),payment:{channel:'native',codeUrl:'weixin://wxpay/bizpayurl?pr=fixture'},requestHash:'a'.repeat(64),delivery:null};
  t.mock.method(Date,'now',()=>clock);
  t.mock.method(PaymentService.prototype,'refresh',async function (requestedId:string) {
    assert.equal(requestedId,id);refreshes++;
    return {...order,status:'CLOSED',closedAt:new Date(clock).toISOString(),closeReason:'timeout'} as Order;
  });
  t.mock.method(globalThis,'fetch',(async (input:RequestInfo|URL,init?:RequestInit)=>{
    const url=new URL(String(input));assert.equal(url.origin,'https://api.github.com');assert.equal(init?.method,'GET');
    if(url.pathname===`/repos/${repo}/contents/config/clients.json`)return new Response(null,{status:404});
    assert.equal(url.pathname,`/repos/${repo}/contents/orders/ee/${id}.json`);reads++;
    const envelope=await encryptJson(storageKey,order,`${repo}:orders/ee/${id}.json`);
    return Response.json({type:'file',encoding:'base64',sha:'f'.repeat(40),content:bytesToBase64(new TextEncoder().encode(JSON.stringify(envelope)))});
  }) as typeof fetch);
  const headers={Authorization:'Bearer '+await checkoutToken(id,env)};
  const load=async()=>{
    const response=await worker.fetch(request(`/api/checkout/${id}`,{headers}),env,context());
    assert.equal(response.status,200);return response.json() as Promise<{status:string;payment?:unknown;expiresAt:string}>;
  };
  const pending=await load();assert.equal(pending.status,'PENDING');assert.ok(pending.payment);
  assert.equal(pending.expiresAt,new Date(now+300000).toISOString());
  clock=now+301000;
  const expired=await load();assert.equal(expired.status,'CLOSED');assert.equal(expired.payment,undefined);
  assert.equal(reads,1);assert.equal(refreshes,1);
});
