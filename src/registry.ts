import { clients as validateClients } from './config';
import { randomHex } from './crypto';
import { GithubStore } from './store';
import { HttpError, type Client, type Env } from './types';
export function configStore(env:Env):GithubStore {
  if (!env.GITHUB_TOKEN || !env.ENCRYPTION_KEY) throw new HttpError(503,'ADMIN_STORAGE_NOT_CONFIGURED','管理控制台的加密存储尚未配置');
  return new GithubStore({token:env.GITHUB_TOKEN,repo:env.GITHUB_DATA_REPO,branch:env.GITHUB_DATA_BRANCH,encryptionKey:env.ENCRYPTION_KEY});
}
export async function loadClients(env:Env):Promise<Client[]> {
  const saved=await configStore(env).read<{version:1;clients:Client[]}>('config/clients.json');
  let baseline:Client[]=[];
  if (env.CLIENTS_JSON && env.CLIENTS_JSON!=='[]') baseline=validateClients(env);
  if (!saved) return baseline;
  if (saved.value.version!==1 || !Array.isArray(saved.value.clients)) throw new HttpError(503,'REGISTRY_INVALID','产品配置读取失败');
  const map=new Map(baseline.map(c=>[c.id,c]));
  for (const c of saved.value.clients) map.set(c.id,c);
  const combined=[...map.values()];
  if (combined.length) validateClients({...env,CLIENTS_JSON:JSON.stringify(combined)});
  return combined;
}
let runtimeCache:{source:string;until:number;value:Promise<Client[]>}|undefined;
export async function runtimeEnv(env:Env):Promise<Env> {
  const source=[env.GITHUB_DATA_REPO,env.GITHUB_DATA_BRANCH,env.GITHUB_TOKEN,env.ENCRYPTION_KEY,env.CLIENTS_JSON].join('|');
  if (!runtimeCache || runtimeCache.source!==source || runtimeCache.until<Date.now()) runtimeCache={source,until:Date.now()+15000,value:loadClients(env)};
  try { return {...env,CLIENTS_JSON:JSON.stringify(await runtimeCache.value)}; }
  catch(error) {runtimeCache=undefined;throw error;}
}
export function maskedClient(c:Client):Record<string,unknown> {
  const {apiKey,webhookSecret,...rest}=c;
  return {...rest,maskedKey:apiKey.slice(0,4)+'••••••••'+apiKey.slice(-4)};
}
export async function saveClient(env:Env,input:Record<string,unknown>,rotate=false):Promise<Client> {
  if (typeof input.id!=='string' || !/^[a-z0-9][a-z0-9_-]{1,63}$/.test(input.id)) throw new HttpError(400,'CLIENT_ID_INVALID','产品 ID 须为 2 至 64 位小写字母、数字、下划线或连字符');
  const store=configStore(env), baseline=await loadClients(env),key=randomHex(32),hookKey=randomHex(32);
  let result:Client|undefined;
  await store.update<{version:1;clients:Client[]}>('config/clients.json',current=>{
    const merged=new Map(baseline.map(c=>[c.id,c]));
    for (const saved of current?.clients||[]) merged.set(saved.id,saved);
    const list=[...merged.values()];
    const existing=list.find(c=>c.id===input.id);
    if (rotate && !existing) throw new HttpError(404,'CLIENT_NOT_FOUND','未找到该产品');
    const candidate=(rotate?{...existing,apiKey:key,webhookSecret:hookKey}:{id:input.id,name:input.name,webhookUrl:input.webhookUrl,returnOrigins:input.returnOrigins,channels:input.channels,products:input.products,disabled:input.disabled===true,apiKey:existing?.apiKey||key,webhookSecret:existing?.webhookSecret||hookKey}) as Client;
    candidate.lastUpdated=new Date().toISOString();
    try { validateClients({...env,CLIENTS_JSON:JSON.stringify([candidate])}); }
    catch { throw new HttpError(400,'CLIENT_CONFIG_INVALID','请检查名称、HTTPS 回调地址、返回域名、支付方式和商品价格（整数分）'); }
    if (Object.keys(candidate.products).length>100 || (list.length>=100 && !existing)) throw new HttpError(400,'CATALOG_LIMIT','当前最多支持 100 个产品，每个产品最多 100 个商品');
    result=candidate;
    return {version:1,clients:[...list.filter(c=>c.id!==candidate.id),candidate]};
  });
  runtimeCache=undefined;
  return result!;
}
