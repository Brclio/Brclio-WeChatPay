import { HttpError, type Client, type Env, type Channel } from './types';
const channels: Channel[] = ['native','h5','jsapi','app'];
export function enabledChannels(env:Env): Channel[] {
  return (env.ENABLED_CHANNELS || 'native').split(',').map(x=>x.trim()).filter((x):x is Channel=>channels.includes(x as Channel));
}
export function baseUrl(env:Env):string {
  const url = new URL(env.PUBLIC_BASE_URL);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new HttpError(503,'CONFIGURATION_ERROR','支付域名配置不正确');
  return url.origin;
}
export function clients(env:Env):Client[] {
  try {
    const list:Client[] = JSON.parse(env.CLIENTS_JSON || '[]');
    if (!Array.isArray(list) || !list.length) throw Error();
    const ids = new Set<string>();
    for (const c of list) {
      if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(c.id) || ids.has(c.id) || typeof c.name!=='string' || !c.name || typeof c.apiKey!=='string' || c.apiKey.length<32 || typeof c.webhookSecret!=='string' || c.webhookSecret.length<32) throw Error();
      ids.add(c.id);
      const hook=new URL(c.webhookUrl);
      if (!isPublicHttps(hook) || !Array.isArray(c.returnOrigins) || !c.returnOrigins.length || !Array.isArray(c.channels) || !c.channels.every(x=>channels.includes(x))) throw Error();
      for (const origin of c.returnOrigins) if (!validOriginPattern(origin)) throw Error();
      if (!c.products || !Object.keys(c.products).length) throw Error();
      for (const [sku,p] of Object.entries(c.products)) {
        if (!/^[a-zA-Z0-9_-]{1,80}$/.test(sku) || typeof p.description!=='string' || !p.description || new TextEncoder().encode(p.description).length>100 || !Number.isSafeInteger(p.amount) || p.amount<1 || p.amount>100000000 || (p.maxQuantity!==undefined && (!Number.isInteger(p.maxQuantity) || p.maxQuantity<1 || p.maxQuantity>100))) throw Error();
      }
    }
    return list;
  } catch { throw new HttpError(503,'CLIENT_CONFIG_INVALID','产品接入配置尚未完成'); }
}
export function validOriginPattern(pattern:string):boolean {
  try { const u=new URL(pattern.replace('https://*.','https://wildcard.')); return isPublicHttps(u) && u.origin===pattern.replace('https://*.','https://wildcard.'); } catch { return false; }
}
export function originMatches(origin:string,pattern:string):boolean {
  if (origin===pattern) return true;
  if (!pattern.startsWith('https://*.')) return false;
  try { const u=new URL(origin); const host=pattern.slice(10); return u.protocol==='https:' && !u.port && u.hostname.endsWith('.'+host) && u.hostname!==host && u.origin===origin; } catch { return false; }
}
export function isPublicHttps(url:URL):boolean {
  // Fixed administrator-configured endpoints only. IP literals and local hostnames are forbidden.
  return url.protocol==='https:' && !url.username && !url.password && !url.port && !url.hash && !/^\d+[.\d]*$/.test(url.hostname) && !url.hostname.includes(':') && url.hostname.includes('.') && !/(^|\.)(localhost|local|internal|test|invalid)$/.test(url.hostname);
}
export function assertLive(env:Env,requireClients=true):void {
  if (env.PAYMENT_MODE!=='live' || env.PAYMENT_ENABLED!=='true') throw new HttpError(503,'PAYMENTS_DISABLED','收款尚未启用，请等待商户配置完成');
  const needed=['GITHUB_TOKEN','ENCRYPTION_KEY','ORDER_ID_SECRET','CHECKOUT_SECRET','WECHAT_MCH_ID','WECHAT_APP_ID','WECHAT_SERIAL_NO','WECHAT_PRIVATE_KEY','WECHAT_API_V3_KEY','WECHAT_PUBLIC_KEYS_JSON'] as const;
  if (needed.some(k=>!env[k]) || (env.ORDER_ID_SECRET?.length||0)<32 || (env.CHECKOUT_SECRET?.length||0)<32 || new TextEncoder().encode(env.WECHAT_API_V3_KEY).length!==32) throw new HttpError(503,'CONFIGURATION_INCOMPLETE','商户密钥配置尚未完成');
  try {
    if (!/^[0-9]{6,20}$/.test(env.WECHAT_MCH_ID!) || !/^[A-Fa-f0-9]{16,64}$/.test(env.WECHAT_SERIAL_NO!) || !/^-----BEGIN PRIVATE KEY-----/.test(env.WECHAT_PRIVATE_KEY!.trim())) throw Error();
    const decoded=atob(env.ENCRYPTION_KEY!);
    if (decoded.length!==32) throw Error();
    const keys=JSON.parse(env.WECHAT_PUBLIC_KEYS_JSON!);
    if (!keys || typeof keys!=='object' || Array.isArray(keys) || !Object.keys(keys).length || Object.entries(keys).some(([id,key])=>!/^PUB_KEY_ID_[A-Za-z0-9_]+$/.test(id) || typeof key!=='string' || !/^-----BEGIN PUBLIC KEY-----/.test(key.trim()))) throw Error();
    if (env.WECHAT_PUBLIC_KEY_ID && !Object.hasOwn(keys,env.WECHAT_PUBLIC_KEY_ID)) throw Error();
    for (const channel of enabledChannels(env)) appIdFor(env,channel);
  } catch { throw new HttpError(503,'CONFIGURATION_INVALID','商户密钥或支付通道配置不正确'); }
  baseUrl(env); if (requireClients) clients(env);
}
export function appIdFor(env:Env,channel:Channel):string {
  const id=channel==='app'?env.WECHAT_APP_APP_ID:channel==='jsapi'?env.WECHAT_JSAPI_APP_ID:env.WECHAT_APP_ID;
  if (!id || !/^wx[a-zA-Z0-9]{16}$/.test(id)) throw new HttpError(503,'CHANNEL_NOT_CONFIGURED','该支付通道尚未配置关联 AppID');
  return id;
}
