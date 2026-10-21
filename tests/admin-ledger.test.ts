import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { handleAdmin } from '../src/admin.js';
import { bytesToBase64, encryptJson, hmac, sha256 } from '../src/crypto.js';
import { PaymentService, orderPath } from '../src/service.js';
import { HttpError, type Env, type Order } from '../src/types.js';

const origin='https://pay.bornforthis.cn',repo='fixture-owner/private-ledger';
const key=bytesToBase64(new Uint8Array(32).fill(34));
const merchantKeys=generateKeyPairSync('rsa',{modulusLength:2048,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
const order:Order={version:1,id:'b'.repeat(32),clientId:'product-one',clientName:'历史产品',merchantOrderId:'business-1',sku:'year',quantity:1,description:'年度会员',total:12900,currency:'CNY',appId:'wx0123456789abcdef',channel:'native',status:'SUCCESS',createdAt:'2026-10-03T12:00:00.000Z',expiresAt:'2026-10-03T12:15:00.000Z',paidAt:'2026-10-03T12:01:00.000Z',transactionId:'420000000000000000000001',requestHash:'SECRET_ORDER_HASH',payerOpenid:'SECRET_ORDER_OPENID',clientIp:'SECRET_ORDER_IP',payment:{channel:'native',codeUrl:'weixin://SECRET_ORDER_PAYMENT'},delivery:{status:'manual',attempts:20,nextAt:'2026-10-03T14:01:00.000Z'}};
function environment():Env {return {ASSETS:{fetch:async()=>new Response('asset')} as unknown as Fetcher,PUBLIC_BASE_URL:origin,GITHUB_DATA_REPO:repo,GITHUB_DATA_BRANCH:'main',GITHUB_TOKEN:'SECRET_GITHUB',ENCRYPTION_KEY:key,CLIENTS_JSON:'[]',ADMIN_EMAIL:'admin@example.com',ADMIN_PASSWORD_HASH:'fixture-version-hash',ADMIN_SESSION_SECRET:'SECRET_ADMIN_SESSION'.repeat(4),PAYMENT_ENABLED:'false'} as Env;}
function pausedEnvironment():Env {return {...environment(),PAYMENT_MODE:'live',PAYMENT_ENABLED:'false',ORDER_ID_SECRET:'fixture-order-id-'.repeat(4),CHECKOUT_SECRET:'fixture-checkout-'.repeat(4),WECHAT_MCH_ID:'1751349372',WECHAT_APP_ID:'wx0123456789abcdef',WECHAT_SERIAL_NO:'A'.repeat(40),WECHAT_PRIVATE_KEY:merchantKeys.privateKey,WECHAT_API_V3_KEY:'v'.repeat(32),WECHAT_PUBLIC_KEYS_JSON:JSON.stringify({PUB_KEY_ID_FIXTURE:merchantKeys.publicKey}),ENABLED_CHANNELS:'native'};}
async function credentials(env:Env) {
  const payload=btoa(JSON.stringify({email:env.ADMIN_EMAIL,exp:Math.floor(Date.now()/1000)+3600,version:await sha256(env.ADMIN_PASSWORD_HASH!)})).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
  const token=payload+'.'+await hmac(env.ADMIN_SESSION_SECRET!,payload);
  return {cookie:'__Host-brclio-admin='+token,csrf:await hmac(env.ADMIN_SESSION_SECRET!,`csrf:${token}`)};
}
function request(path:string,options:{method?:string;cookie?:string;csrf?:string;sameOrigin?:boolean}={}) {
  const headers=new Headers();if (options.cookie) headers.set('Cookie',options.cookie);if (options.csrf) headers.set('X-Brclio-CSRF',options.csrf);if (options.sameOrigin!==undefined) headers.set('Origin',options.sameOrigin?origin:'https://evil.example');
  return new Request(origin+path,{method:options.method||'GET',headers});
}
function rejects(code:string,status:number) {return (error:unknown)=>error instanceof HttpError && error.code===code && error.status===status;}
async function githubFixture() {
  const content=bytesToBase64(new TextEncoder().encode(JSON.stringify(await encryptJson(key,order,`${repo}:${orderPath(order.id)}`))));
  const calls:string[]=[];
  const fetcher=async(input:RequestInfo|URL,init?:RequestInit)=>{
    const url=new URL(String(input));assert.equal(url.origin,'https://api.github.com');assert.equal(init?.method,'GET');calls.push(url.pathname);
    const prefix=`/repos/${repo}/contents/`;
    if (url.pathname===prefix+'orders') return Response.json([{name:'bb',path:'orders/bb',type:'dir'}]);
    if (url.pathname===prefix+'orders/bb') return Response.json([{name:order.id+'.json',path:orderPath(order.id),type:'file'}]);
    if (url.pathname===prefix+orderPath(order.id)) return Response.json({type:'file',encoding:'base64',sha:'a'.repeat(40),content});
    if (url.pathname===prefix+'config/clients.json') return new Response(null,{status:404});
    throw Error('Unexpected fixture path '+url.pathname);
  };
  return {fetcher,calls};
}

test('all order/payment endpoints authenticate before touching storage or parsing action bodies',async(t)=>{
  let access=0,bodies=0;t.mock.method(globalThis,'fetch',async()=>{access++;throw Error('Unexpected external access');});
  for (const path of ['/api/admin/orders','/api/admin/payments',`/api/admin/orders/${order.id}`]) await assert.rejects(handleAdmin(request(path),environment(),async()=>{bodies++;return '';}),rejects('ADMIN_UNAUTHORIZED',401));
  await assert.rejects(handleAdmin(request(`/api/admin/orders/${order.id}/close`,{method:'POST'}),environment(),async()=>{bodies++;return '{}';}),rejects('ADMIN_UNAUTHORIZED',401));
  assert.equal(access,0);assert.equal(bodies,0);
});

test('browse/detail remain available while payments and provider configuration are disabled and never expose checkout secrets',async(t)=>{
  const github=await githubFixture();t.mock.method(globalThis,'fetch',github.fetcher);const env=environment(),{cookie}=await credentials(env);
  for (const path of ['/api/admin/orders','/api/admin/payments',`/api/admin/orders/${order.id}`]) {
    const response=await handleAdmin(request(path,{cookie}),env,async()=>'');assert.equal(response.status,200);assert.equal(response.headers.get('Cache-Control'),'no-store');
    const text=await response.text();assert.ok(text.includes(order.merchantOrderId));
    for (const secret of ['SECRET_ORDER_HASH','SECRET_ORDER_OPENID','SECRET_ORDER_IP','SECRET_ORDER_PAYMENT',env.GITHUB_TOKEN!,env.ENCRYPTION_KEY!,env.ADMIN_PASSWORD_HASH!,env.ADMIN_SESSION_SECRET!]) assert.equal(text.includes(secret),false);
    assert.equal(text.includes('2026-10-03T12:05:00.000Z'),true);
  }
  assert.equal(github.calls.some(path=>path.endsWith('config/clients.json')),false);
});

test('all admin actions require same-origin and CSRF before storage access',async(t)=>{
  let access=0;t.mock.method(globalThis,'fetch',async()=>{access++;throw Error('Unexpected storage access');});
  const env=environment(),{cookie,csrf}=await credentials(env);
  for (const action of ['refresh','close','retry-notification']) {
    for (const options of [{sameOrigin:true},{sameOrigin:true,csrf:'invalid'},{sameOrigin:false,csrf}]) {
      await assert.rejects(handleAdmin(request(`/api/admin/orders/${order.id}/${action}`,{method:'POST',cookie,...options}),env,async()=>JSON.stringify({reason:'人工核查'})),(error:unknown)=>error instanceof HttpError && error.status===403);
    }
  }
  assert.equal(access,0);
});

test('admin mutations reject malformed reasons and arbitrary status/amount fields before storage access',async(t)=>{
  let access=0;t.mock.method(globalThis,'fetch',async()=>{access++;throw Error('Unexpected storage access');});
  const env=environment(),auth=await credentials(env),req=()=>request(`/api/admin/orders/${order.id}/retry-notification`,{method:'POST',...auth,sameOrigin:true});
  await assert.rejects(handleAdmin(req(),env,async()=>'{'),rejects('JSON_INVALID',400));
  for (const body of [null,[],{},'manual',{reason:2},{reason:'ab'},{reason:'a'.repeat(201)},{reason:'reason\nunsafe'},{reason:'人工核查',status:'SUCCESS'},{reason:'人工核查',total:1}]) {
    await assert.rejects(handleAdmin(req(),env,async()=>JSON.stringify(body)),rejects('ADMIN_REASON_REQUIRED',400));
  }
  assert.equal(access,0);
});

test('retry notification can run with collection disabled and forwards the authenticated actor and a trimmed reason',async(t)=>{
  const github=await githubFixture();t.mock.method(globalThis,'fetch',github.fetcher);
  const env=environment(),auth=await credentials(env);let actionArgs:unknown[]=[];
  t.mock.method(PaymentService.prototype,'adminAction',async(...args:unknown[])=>{actionArgs=args;return order;});
  const response=await handleAdmin(request(`/api/admin/orders/${order.id}/retry-notification`,{method:'POST',...auth,sameOrigin:true}),env,async()=>JSON.stringify({reason:'  人工重试通知  '}));
  assert.equal(response.status,200);assert.deepEqual(actionArgs,[order.id,'retry-notification',env.ADMIN_EMAIL,'人工重试通知']);
  const result=await response.json() as {order:{status:string;payment?:unknown}};assert.equal(result.order.status,'SUCCESS');assert.equal(Object.hasOwn(result.order,'payment'),false);
  assert.ok(github.calls.some(path=>path.endsWith('config/clients.json')));
});

test('provider mutations stay blocked in demo mode before runtime registry access',async(t)=>{
  let access=0;t.mock.method(globalThis,'fetch',async()=>{access++;throw Error('Unexpected storage access');});
  const env=environment(),auth=await credentials(env);
  for (const action of ['refresh','close']) await assert.rejects(handleAdmin(request(`/api/admin/orders/${order.id}/${action}`,{method:'POST',...auth,sameOrigin:true}),env,async()=>JSON.stringify({reason:'人工核查订单'})),rejects('PAYMENTS_DISABLED',503));
  assert.equal(access,0);
});

test('administrator refresh and close remain available with valid merchant configuration while live collection is paused',async(t)=>{
  const github=await githubFixture();t.mock.method(globalThis,'fetch',github.fetcher);
  const env=pausedEnvironment(),auth=await credentials(env),actions:string[]=[];
  t.mock.method(PaymentService.prototype,'adminAction',async(id:string,action:string,actor:string,reason:string)=>{
    assert.equal(id,order.id);assert.equal(actor,env.ADMIN_EMAIL);assert.equal(reason,'暂停下单期间核对');actions.push(action);
    return {...order,status:'CLOSED'} as Order;
  });
  for (const action of ['refresh','close']) {
    const response=await handleAdmin(request(`/api/admin/orders/${order.id}/${action}`,{method:'POST',...auth,sameOrigin:true}),env,async()=>JSON.stringify({reason:'暂停下单期间核对'}));
    assert.equal(response.status,200);assert.equal((await response.json() as {order:{status:string}}).order.status,'CLOSED');
  }
  assert.deepEqual(actions,['refresh','close']);
});

test('paused live admin maintenance requires merchant keys before registry access',async(t)=>{
  let access=0;t.mock.method(globalThis,'fetch',async()=>{access++;throw Error('Unexpected storage access');});
  const env={...pausedEnvironment(),WECHAT_PRIVATE_KEY:undefined},auth=await credentials(env);
  for (const action of ['refresh','close']) await assert.rejects(handleAdmin(request(`/api/admin/orders/${order.id}/${action}`,{method:'POST',...auth,sameOrigin:true}),env,async()=>JSON.stringify({reason:'暂停下单期间核对'})),rejects('CONFIGURATION_INCOMPLETE',503));
  assert.equal(access,0);
});
