import { hmac, constantTimeEqual } from './crypto';
import { clients } from './config';
import { HttpError, type Client, type Env } from './types';
export async function authenticate(request:Request,body:string,env:Env):Promise<Client> {
  const id=request.headers.get('X-Brclio-Client')||'',timestamp=request.headers.get('X-Brclio-Timestamp')||'',nonce=request.headers.get('X-Brclio-Nonce')||'',signature=request.headers.get('X-Brclio-Signature')||'';
  const client=clients(env).find(c=>c.id===id);
  if (!client || !/^\d{10}$/.test(timestamp) || Math.abs(Date.now()/1000-Number(timestamp))>300 || !/^[a-zA-Z0-9_-]{16,128}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(signature)) throw new HttpError(401,'AUTH_INVALID','请求签名或时间戳不正确');
  const url=new URL(request.url);
  const canonical=`${request.method}\n${url.pathname+url.search}\n${timestamp}\n${nonce}\n${body}\n`;
  if (!constantTimeEqual(await hmac(client.apiKey,canonical),signature)) throw new HttpError(401,'AUTH_INVALID','请求签名或时间戳不正确');
  return client;
}
export async function checkoutToken(id:string,env:Env):Promise<string> { return hmac(env.CHECKOUT_SECRET!,`checkout:v1:${id}`); }
export async function verifyCheckout(request:Request,id:string,env:Env):Promise<void> {
  const token=request.headers.get('Authorization')?.replace(/^Bearer /,'')||'';
  if (!/^[a-f0-9]{64}$/.test(token) || !constantTimeEqual(token,await checkoutToken(id,env))) throw new HttpError(401,'CHECKOUT_UNAUTHORIZED','收银台链接已失效或不完整，请从产品重新进入');
}
