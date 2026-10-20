import { handleIntegration } from './integration';
import { handleAdmin } from './admin';
import { runtimeEnv } from './registry';
import { authenticate, verifyCheckout } from './auth';
import { assertLive, baseUrl, enabledChannels, originMatches } from './config';
import { PaymentService, validId } from './service';
import { StoreError } from './store';
import { HttpError, type Env, type Order } from './types';
import { WechatPay } from './wechat';

const securityHeaders={
  'X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'strict-origin',
  'Permissions-Policy':'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'Strict-Transport-Security':'max-age=31536000'
};
const publicCache=new Map<string,{at:number;order:Order}>();
function json(data:unknown,status=200):Response { return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}}); }
function responseHeaders(request:Request,response:Response,env:Env):Response {
  const headers=new Headers(response.headers);
  for (const [key,value] of Object.entries(securityHeaders)) headers.set(key,value);
  const origin=request.headers.get('Origin');
  if (origin && allowedOrigin(origin,env)) {
    headers.set('Access-Control-Allow-Origin',origin);headers.set('Vary','Origin');
    headers.set('Access-Control-Allow-Methods','GET, POST, PUT, OPTIONS');
    headers.set('Access-Control-Allow-Headers','Authorization, Content-Type, X-Brclio-CSRF, X-Brclio-Client, X-Brclio-Timestamp, X-Brclio-Nonce, X-Brclio-Signature');
    headers.set('Access-Control-Max-Age','600');
  }
  return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
}
function allowedOrigin(origin:string,env:Env):boolean {
  try {
    if (origin===baseUrl(env)) return true;
    return (env.ALLOWED_ORIGINS||'').split(',').some(x=>originMatches(origin,x.trim()));
  } catch { return false; }
}
async function bodyText(request:Request):Promise<string> {
  if (Number(request.headers.get('Content-Length')||0)>32768) throw new HttpError(413,'BODY_TOO_LARGE','请求正文过大');
  if (!request.body) return '';
  const reader=request.body.getReader(),chunks:Uint8Array[]=[];
  let total=0;
  while (true) {
    const {done,value}=await reader.read();if(done)break;
    total+=value.length;
    if (total>32768) { await reader.cancel();throw new HttpError(413,'BODY_TOO_LARGE','请求正文过大'); }
    chunks.push(value);
  }
  const merged=new Uint8Array(total);let offset=0;
  for (const chunk of chunks) { merged.set(chunk,offset);offset+=chunk.length; }
  try { return new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(merged); } catch { throw new HttpError(400,'BODY_INVALID','请求正文编码不正确'); }
}
function logged(code:string):void { console.error(JSON.stringify({service:'brclio-pay',code})); }
function background(ctx:ExecutionContext,work:Promise<unknown>):void { ctx.waitUntil(work.catch(()=>logged('BACKGROUND_RETRY_REQUIRED'))); }
async function route(request:Request,env:Env,ctx:ExecutionContext):Promise<Response> {
  const url=new URL(request.url),path=url.pathname;
  if (path.startsWith('/api/')) {
    const origin=request.headers.get('Origin');
    if (origin && origin!==url.origin && !allowedOrigin(origin,env) && url.hostname!=='localhost' && url.hostname!=='127.0.0.1') throw new HttpError(403,'ORIGIN_DENIED','此来源未登记');
    if (request.method==='OPTIONS') return new Response(null,{status:204});
    if (path.startsWith('/api/integration/')) return handleIntegration(request,env,()=>bodyText(request));
    if (path.startsWith('/api/admin/')) return handleAdmin(request,env,()=>bodyText(request));
    if (path==='/api/health' && request.method==='GET') {
      let configured=false;try { assertLive(env,false);configured=true; } catch { /* Safe public readiness only. */ }
      return json({service:'brclio-pay',mode:env.PAYMENT_MODE==='live'?'live':'demo',configured,channels:configured?enabledChannels(env):[]});
    }
    if (env.PAYMENT_MODE!=='live' || env.PAYMENT_ENABLED!=='true') throw new HttpError(503,'PAYMENTS_DISABLED','收款尚未启用，请等待商户配置完成');
    assertLive(env,false);
    const checkoutPreflight=path.match(/^\/api\/checkout\/([a-f0-9]{32})(\/refresh)?$/);
    const clientPreflight=path.match(/^\/api\/v1\/orders(?:\/([a-f0-9]{32})(?:\/(refresh|retry-notification))?)?$/);
    const isNotify=path==='/api/wechat/notify' && request.method==='POST';
    if (!checkoutPreflight && !clientPreflight && !isNotify) throw new HttpError(404,'NOT_FOUND','未找到接口');
    if (checkoutPreflight) await verifyCheckout(request,checkoutPreflight[1],env);
    if (clientPreflight) {
      const timestamp=request.headers.get('X-Brclio-Timestamp')||'';
      if (!request.headers.get('X-Brclio-Client') || !/^[a-f0-9]{64}$/.test(request.headers.get('X-Brclio-Signature')||'') || !/^\d{10}$/.test(timestamp) || Math.abs(Date.now()/1000-Number(timestamp))>300 || !/^[a-zA-Z0-9_-]{16,128}$/.test(request.headers.get('X-Brclio-Nonce')||'')) throw new HttpError(401,'AUTH_INVALID','请求签名或时间戳不正确');
    }
    // Authenticate WeChat before reading any GitHub registry or order data.
    const notification=isNotify?await new WechatPay(env).notification(request.headers,await bodyText(request)):undefined;
    env=await runtimeEnv(env);
    assertLive(env);
    const service=new PaymentService(env);
    if (path==='/api/wechat/notify' && request.method==='POST') {
      const transaction=notification!;
      if (transaction.trade_state!=='SUCCESS') throw new HttpError(400,'NOTIFY_INVALID','支付通知状态不正确');
      const order=await service.applyTransaction(transaction);
      publicCache.delete(order.id);
      // Never acknowledge a payment before encrypted order persistence succeeds.
      // Outbound fulfillment is separately retried and must not block WeChat's response.
      background(ctx,service.deliver(order.id));
      return new Response(null,{status:204,headers:{'Cache-Control':'no-store'}});
    }
    const checkout=path.match(/^\/api\/checkout\/([a-f0-9]{32})(\/refresh)?$/);
    if (checkout && ((request.method==='GET' && !checkout[2]) || (request.method==='POST' && checkout[2]))) {
      const id=checkout[1];await verifyCheckout(request,id,env);
      let order:Order;
      if (checkout[2]) { order=await service.refresh(id);publicCache.delete(id);if (order.status==='SUCCESS') background(ctx,service.deliver(id)); }
      else {
        const cached=publicCache.get(id);
        if (cached && Date.now()-cached.at<8000) order=cached.order;
        else {order=await service.read(id);if (publicCache.size>500) publicCache.clear();publicCache.set(id,{at:Date.now(),order});}
      }
      return json(await service.publicOrder(order));
    }
    const v1=path.match(/^\/api\/v1\/orders(?:\/([a-f0-9]{32})(?:\/(refresh|retry-notification))?)?$/);
    if (v1) {
      const raw=await bodyText(request),client=await authenticate(request,raw,env);
      if (!v1[1] && request.method==='POST') {
        if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type')||'')) throw new HttpError(415,'JSON_REQUIRED','请使用 application/json');
        let input:any;try {input=JSON.parse(raw);}catch {throw new HttpError(400,'JSON_INVALID','请求正文不是有效 JSON');}
        const order=await service.create(client,input);publicCache.delete(order.id);
        if (order.status==='SUCCESS') background(ctx,service.deliver(order.id));
        return json(await service.clientOrder(order),201);
      }
      if (v1[1]) {
        let order=await service.read(v1[1]);
        if (order.clientId!==client.id) throw new HttpError(404,'ORDER_NOT_FOUND','未找到该订单');
        if (request.method==='GET' && !v1[2]) return json(await service.clientOrder(order));
        if (request.method==='POST' && v1[2]==='refresh') {order=await service.refresh(order.id);publicCache.delete(order.id);if (order.status==='SUCCESS') background(ctx,service.deliver(order.id));return json(await service.clientOrder(order));}
        if (request.method==='POST' && v1[2]==='retry-notification') {order=await service.retryNotification(order);publicCache.delete(order.id);return json(await service.clientOrder(order));}
      }
      throw new HttpError(405,'METHOD_NOT_ALLOWED','不支持此请求方式');
    }
    throw new HttpError(404,'NOT_FOUND','未找到接口');
  }
  if (request.method!=='GET' && request.method!=='HEAD') throw new HttpError(405,'METHOD_NOT_ALLOWED','不支持此请求方式');
  let assetPath=path;
  if (path==='/' || path==='/index.html') assetPath='/index.html';
  if (/^\/checkout\/(?:demo|[a-f0-9]{32})\/?$/.test(path)) assetPath='/checkout.html';
  if (path==='/admin' || path==='/admin/') assetPath='/admin.html';
  if (path==='/integration' || path==='/integration/') assetPath='/integration.html';
  const target=new URL(assetPath,url.origin);
  const asset=await env.ASSETS.fetch(new Request(target,request));
  if (asset.status===404) return new Response('页面不存在',{status:404,headers:{'Content-Type':'text/plain; charset=utf-8'}});
  const headers=new Headers(asset.headers);
  headers.set('Cache-Control',assetPath.endsWith('.html')?'no-store':'public, max-age=0, must-revalidate');
  return new Response(asset.body,{status:asset.status,headers});
}
export default {
  async fetch(request:Request,env:Env,ctx:ExecutionContext):Promise<Response> {
    try { return responseHeaders(request,await route(request,env,ctx),env); }
    catch (error) {
      let status=500,code='INTERNAL_ERROR',message='支付服务暂时不可用，请稍后重试';
      if (error instanceof HttpError) {status=error.status;code=error.code;message=error.message;}
      else if (error instanceof StoreError) {status=error.status>=500?503:error.status;code=error.code;message='订单存储暂时不可用，请稍后重试';}
      if (status>=500) logged(code);
      return responseHeaders(request,json({error:{code,message}},status),env);
    }
  },
  async scheduled(controller:ScheduledController,env:Env,_ctx:ExecutionContext):Promise<void> {
    if (env.PAYMENT_MODE!=='live' || env.PAYMENT_ENABLED!=='true') return;
    env=await runtimeEnv(env);
    if (env.CLIENTS_JSON==='[]') return;
    assertLive(env);
    const result=await new PaymentService(env).processWork(controller.scheduledTime);
    if (result.failed) {logged('RECONCILIATION_INCOMPLETE');throw new Error('Payment reconciliation requires retry');}
  }
} satisfies ExportedHandler<Env>;
