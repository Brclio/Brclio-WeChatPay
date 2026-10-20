import { constantTimeEqual, hmac, randomHex, sha256 } from './crypto';
import { baseUrl, enabledChannels } from './config';
import { loadClients, maskedClient, saveClient } from './registry';
import { integrationSkill } from './skill';
import { HttpError, type Client, type Env } from './types';
export interface IntegrationClaims { version:1; clientId:string; scope:'integration:configure'; exp:number; nonce:string; credentialVersion?:string }
const lifetime=24*3600;
function signer(env:Env):string {
  if ((env.ADMIN_SESSION_SECRET?.length||0)<32) throw new HttpError(503,'INTEGRATION_NOT_CONFIGURED','接入授权尚未配置');
  return env.ADMIN_SESSION_SECRET!;
}
export async function issueIntegration(env:Env,client?:Client):Promise<{token:string;clientId:string;expiresAt:string}> {
  const claims:IntegrationClaims={version:1,clientId:client?.id||'p-'+randomHex(16),scope:'integration:configure',exp:Math.floor(Date.now()/1000)+lifetime,nonce:randomHex(),...(client?{credentialVersion:await sha256(client.apiKey)}:{})};
  const payload=btoa(JSON.stringify(claims)).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
  return {clientId:claims.clientId,token:`bri1.${payload}.${await hmac(signer(env),`integration:v1:${payload}`)}`,expiresAt:new Date(claims.exp*1000).toISOString()};
}
export async function verifyIntegration(request:Request,env:Env,clientId:string):Promise<IntegrationClaims> {
  const authorization=request.headers.get('Authorization')||'';
  const token=/^Bearer /i.test(authorization)?authorization.slice(7):'';
  if (token.length>2048 || !/^bri1\.[a-zA-Z0-9_-]+\.[a-f0-9]{64}$/.test(token)) throw new HttpError(401,'INTEGRATION_UNAUTHORIZED','接入授权缺失或已失效，请登录后台重新复制 Skill');
  const [,payload,signature]=token.split('.');
  if (!constantTimeEqual(await hmac(signer(env),`integration:v1:${payload}`),signature)) throw new HttpError(401,'INTEGRATION_UNAUTHORIZED','接入授权不正确');
  let claims:IntegrationClaims;
  try {
    claims=JSON.parse(atob(payload.replace(/-/g,'+').replace(/_/g,'/')));
    const now=Math.floor(Date.now()/1000);
    if (claims.version!==1 || claims.scope!=='integration:configure' || claims.clientId!==clientId || !/^[a-z0-9][a-z0-9_-]{1,63}$/.test(claims.clientId) || !/^[a-f0-9]{32}$/.test(claims.nonce) || !Number.isInteger(claims.exp) || claims.exp<=now || claims.exp>now+lifetime || (claims.credentialVersion!==undefined && !/^[a-f0-9]{64}$/.test(claims.credentialVersion))) throw Error();
  } catch { throw new HttpError(401,'INTEGRATION_UNAUTHORIZED','接入授权范围不匹配或已过期'); }
  return claims;
}
export async function handleIntegration(request:Request,env:Env,readBody:()=>Promise<string>):Promise<Response> {
  const match=new URL(request.url).pathname.match(/^\/api\/integration\/clients\/([a-z0-9][a-z0-9_-]{1,63})(\/skill)?$/);
  if (!match) throw new HttpError(404,'NOT_FOUND','未找到接入管理接口');
  const claims=await verifyIntegration(request,env,match[1]);
  if (!['GET','PUT'].includes(request.method) || (match[2] && request.method!=='GET')) throw new HttpError(405,'METHOD_NOT_ALLOWED','此接入授权不支持该操作');
  let client=(await loadClients(env)).find(c=>c.id===claims.clientId);
  const bootstrapHash=await sha256(claims.nonce);
  if (client) {
    const allowed=claims.credentialVersion!==undefined
      ? constantTimeEqual(claims.credentialVersion,await sha256(client.apiKey))
      : !!client.integrationBootstrapHash && constantTimeEqual(bootstrapHash,client.integrationBootstrapHash);
    if (!allowed) throw new HttpError(403,'INTEGRATION_REVOKED','该接入授权已撤销或不属于此产品');
  } else if (claims.credentialVersion!==undefined || !claims.clientId.startsWith('p-')) throw new HttpError(403,'INTEGRATION_REVOKED','该接入授权不能创建其他产品');
  if (request.method==='PUT') {
    let input:Record<string,unknown>;
    try {input=JSON.parse(await readBody());}catch {throw new HttpError(400,'JSON_INVALID','产品配置不是有效 JSON');}
    const allowedFields=['name','webhookUrl','returnOrigins','channels','products'];
    if (!input || typeof input!=='object' || Array.isArray(input) || Object.keys(input).some(k=>!allowedFields.includes(k))) throw new HttpError(400,'INTEGRATION_FIELDS_DENIED','只允许设置本产品名称、回调、返回来源、渠道和商品目录');
    const selected=input.channels??client?.channels??['native'];
    if (!Array.isArray(selected) || !selected.length || selected.some(c=>!enabledChannels(env).includes(c))) throw new HttpError(400,'CHANNEL_DISABLED','只能接入商户当前开放的支付渠道');
    client=await saveClient(env,{...input,id:claims.clientId,...(!client && input.channels===undefined?{channels:selected}:{})},false,claims.credentialVersion!==undefined?{expectedApiKey:client!.apiKey}:{bootstrapHash});
  }
  if (!client) throw new HttpError(404,'INTEGRATION_CLIENT_PENDING','尚未登记此产品，请先检测项目并 PUT 产品配置');
  const expiresAt=new Date(claims.exp*1000).toISOString();
  const json=(data:unknown)=>new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
  if (match[2]) {
    const token=request.headers.get('Authorization')!.slice(7);
    return json({filename:'SKILL.md',content:integrationSkill(client,baseUrl(env),{token,expiresAt}),expiresAt});
  }
  return json({client:maskedClient(client),credentials:{clientId:client.id,apiKey:client.apiKey,webhookSecret:client.webhookSecret},channels:enabledChannels(env),expiresAt,capabilities:['read-own-product','configure-own-product']});
}
