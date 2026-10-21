import { constantTimeEqual, hmac, randomHex, sha256 } from './crypto';
import { assertMaintenance, baseUrl, enabledChannels } from './config';
import { configStore, loadClients, maskedClient, runtimeEnv, saveClient } from './registry';
import { adminOrder, OrderLedger } from './ledger';
import { PaymentService } from './service';
import { issueIntegration } from './integration';
import { bootstrapSkill } from './bootstrap-skill';
import { integrationSkill } from './skill';
import { HttpError, type Env } from './types';
const cookieName='__Host-brclio-admin',localCookie='brclio-admin-dev';
const sessionSeconds=7200;
const encoder=new TextEncoder();
function hex(bytes:ArrayBuffer):string { return Array.from(new Uint8Array(bytes),x=>x.toString(16).padStart(2,'0')).join(''); }
function adminConfigured(env:Env):void {
  if (!env.ADMIN_EMAIL || !env.ADMIN_PASSWORD_HASH || (env.ADMIN_SESSION_SECRET?.length||0)<32) throw new HttpError(503,'ADMIN_NOT_CONFIGURED','管理控制台登录尚未配置');
}
export async function verifyPassword(password:string,hash:string):Promise<boolean> {
  const parts=hash.split('$');
  if (parts.length!==4 || parts[0]!=='pbkdf2-sha256' || parts[1]!=='100000' || !/^[a-f0-9]{32}$/.test(parts[2]) || !/^[a-f0-9]{64}$/.test(parts[3])) return false;
  const salt=Uint8Array.from(parts[2].match(/../g)!,x=>parseInt(x,16));
  const key=await crypto.subtle.importKey('raw',encoder.encode(password),'PBKDF2',false,['deriveBits']);
  const bits=await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt,iterations:100000},key,256);
  return constantTimeEqual(hex(bits),parts[3]);
}
function isLocal(request:Request):boolean { return ['localhost','127.0.0.1'].includes(new URL(request.url).hostname); }
function requireSameOrigin(request:Request):void {
  const origin=request.headers.get('Origin');
  if (!origin || origin!==new URL(request.url).origin) throw new HttpError(403,'ADMIN_ORIGIN_INVALID','请在管理控制台内执行此操作');
}
function getCookie(request:Request):string {
  const name=isLocal(request)?localCookie:cookieName;
  return (request.headers.get('Cookie')||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(name+'='))?.slice(name.length+1)||'';
}
function cookie(request:Request,token:string,maxAge=sessionSeconds):string {
  return `${isLocal(request)?localCookie:cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${isLocal(request)?'':'; Secure'}`;
}
export async function session(request:Request,env:Env):Promise<{email:string;csrfToken:string}> {
  adminConfigured(env);
  const token=getCookie(request);
  if (token.length>2048 || !/^[a-zA-Z0-9_-]+\.[a-f0-9]{64}$/.test(token)) throw new HttpError(401,'ADMIN_UNAUTHORIZED','请先登录管理控制台');
  const [payload,signature]=token.split('.');
  if (!constantTimeEqual(await hmac(env.ADMIN_SESSION_SECRET!,payload),signature)) throw new HttpError(401,'ADMIN_UNAUTHORIZED','登录已失效，请重新登录');
  try {
    const data=JSON.parse(atob(payload.replace(/-/g,'+').replace(/_/g,'/')));
    const now=Math.floor(Date.now()/1000);
    if (data.email!==env.ADMIN_EMAIL || !Number.isInteger(data.exp) || data.exp<now || data.exp>now+sessionSeconds || data.version!==await sha256(env.ADMIN_PASSWORD_HASH!)) throw Error();
    return {email:data.email,csrfToken:await hmac(env.ADMIN_SESSION_SECRET!,`csrf:${token}`)};
  } catch { throw new HttpError(401,'ADMIN_UNAUTHORIZED','登录已失效，请重新登录'); }
}
export async function handleAdmin(request:Request,env:Env,readBody:()=>Promise<string>):Promise<Response> {
  const url=new URL(request.url),path=url.pathname;
  const json=(value:unknown,status=200,headers:Record<string,string>={})=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...headers}});
  if (path==='/api/admin/login' && request.method==='POST') {
    adminConfigured(env);requireSameOrigin(request);
    if (!env.AUTH_RATE_LIMITER) throw new HttpError(503,'LOGIN_RATE_LIMIT_NOT_CONFIGURED','登录保护尚未配置');
    const ip=request.headers.get('CF-Connecting-IP')||'local';
    const [perIp,global]=await Promise.all([env.AUTH_RATE_LIMITER.limit({key:'admin:ip:'+await sha256(ip)}),env.AUTH_RATE_LIMITER.limit({key:'admin:global'})]);
    if (!perIp.success || !global.success) throw new HttpError(429,'LOGIN_RATE_LIMITED','尝试次数较多，请一分钟后重试');
    let input:any;try {input=JSON.parse(await readBody());}catch {throw new HttpError(400,'JSON_INVALID','登录信息格式不正确');}
    if (!input || typeof input!=='object' || Array.isArray(input) || typeof input.password!=='string' || input.password.length>256 || typeof input.email!=='string') throw new HttpError(401,'LOGIN_INVALID','账号或密码不正确');
    const matches=await verifyPassword(input.password,env.ADMIN_PASSWORD_HASH!);
    if (!matches || !constantTimeEqual(input.email.trim().toLowerCase(),env.ADMIN_EMAIL!.toLowerCase())) throw new HttpError(401,'LOGIN_INVALID','账号或密码不正确');
    const payload=btoa(JSON.stringify({email:env.ADMIN_EMAIL,exp:Math.floor(Date.now()/1000)+sessionSeconds,nonce:randomHex(),version:await sha256(env.ADMIN_PASSWORD_HASH!)})).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
    const token=payload+'.'+await hmac(env.ADMIN_SESSION_SECRET!,payload);
    return json({email:env.ADMIN_EMAIL,csrfToken:await hmac(env.ADMIN_SESSION_SECRET!,`csrf:${token}`)},200,{'Set-Cookie':cookie(request,token)});
  }
  const current=await session(request,env);
  if (request.method!=='GET') {
    requireSameOrigin(request);
    if (!constantTimeEqual(request.headers.get('X-Brclio-CSRF')||'',current.csrfToken)) throw new HttpError(403,'CSRF_INVALID','页面凭证已失效，请刷新后重试');
  }
  if (path==='/api/admin/session' && request.method==='GET') return json(current);
  if (path==='/api/admin/logout' && request.method==='POST') return json({ok:true},200,{'Set-Cookie':cookie(request,'',0)});
  if (request.method==='GET' && (path==='/api/admin/orders' || path==='/api/admin/payments')) {
    return json(await new OrderLedger(configStore(env),env.ADMIN_SESSION_SECRET!).list(path.endsWith('/payments')?'payments':'orders',url.searchParams));
  }
  const orderRoute=path.match(/^\/api\/admin\/orders\/([a-f0-9]{32})(?:\/(refresh|close|retry-notification))?$/);
  if (orderRoute) {
    if (request.method==='GET' && !orderRoute[2]) return json({order:adminOrder(await new OrderLedger(configStore(env),env.ADMIN_SESSION_SECRET!).read(orderRoute[1]))});
    if (request.method==='POST' && orderRoute[2]) {
      let input:unknown;try {input=JSON.parse(await readBody());}catch {throw new HttpError(400,'JSON_INVALID','操作原因不是有效 JSON');}
      if (!input || typeof input!=='object' || Array.isArray(input) || Object.keys(input).some(key=>key!=='reason') || typeof (input as {reason?:unknown}).reason!=='string') throw new HttpError(400,'ADMIN_REASON_REQUIRED','请填写 3 至 200 字的操作原因');
      const reason=(input as {reason:string}).reason.trim();
      if (reason.length<3 || reason.length>200 || /[\u0000-\u001f\u007f]/.test(reason)) throw new HttpError(400,'ADMIN_REASON_REQUIRED','请填写 3 至 200 字的操作原因');
      const action=orderRoute[2] as 'refresh'|'close'|'retry-notification';
      if (action!=='retry-notification') assertMaintenance(env);
      const service=new PaymentService(await runtimeEnv(env));
      return json({order:adminOrder(await service.adminAction(orderRoute[1],action,current.email,reason))});
    }
    throw new HttpError(405,'METHOD_NOT_ALLOWED','不支持此请求方式');
  }
  if (path==='/api/admin/bootstrap-skill' && request.method==='GET') {
    const access=await issueIntegration(env);
    return json({filename:'SKILL.md',content:bootstrapSkill(baseUrl(env),access.clientId,access.token,access.expiresAt),expiresAt:access.expiresAt});
  }
  if (path==='/api/admin/clients' && request.method==='GET') return json({clients:(await loadClients(env)).map(maskedClient),channels:enabledChannels(env)});
  if (path==='/api/admin/clients' && request.method==='POST') {
    let input:any;try {input=JSON.parse(await readBody());}catch {throw new HttpError(400,'JSON_INVALID','产品配置不是有效 JSON');}
    if (!input || typeof input!=='object' || Array.isArray(input)) throw new HttpError(400,'CLIENT_CONFIG_INVALID','产品配置不正确');
    return json({client:maskedClient(await saveClient(env,input))});
  }
  const action=path.match(/^\/api\/admin\/clients\/([a-z0-9][a-z0-9_-]{1,63})\/(skill|credentials|rotate)$/);
  if (action) {
    const client=(await loadClients(env)).find(c=>c.id===action[1]);
    if (!client) throw new HttpError(404,'CLIENT_NOT_FOUND','未找到该产品');
    if (request.method==='GET' && action[2]==='skill') {const access=await issueIntegration(env,client);return json({filename:'SKILL.md',content:integrationSkill(client,baseUrl(env),access),expiresAt:access.expiresAt});}
    if (request.method==='GET' && action[2]==='credentials') return json({clientId:client.id,apiKey:client.apiKey,webhookSecret:client.webhookSecret});
    if (request.method==='POST' && action[2]==='rotate') return json({client:maskedClient(await saveClient(env,{id:client.id},true))});
  }
  throw new HttpError(404,'NOT_FOUND','未找到管理接口');
}
