import { hmac, randomHex, sha256 } from './crypto';
import { appIdFor, baseUrl, clients, enabledChannels, originMatches } from './config';
import { checkoutToken } from './auth';
import { GithubStore } from './store';
import { WechatError, WechatPay } from './wechat';
import { HttpError, type Client, type Env, type Order, type Payment, type Channel, type WechatTransaction } from './types';

export interface OrderStore {
  read<T>(path:string):Promise<{value:T;sha:string}|null>;
  create<T>(path:string,value:T):Promise<boolean>;
  update<T>(path:string,mutator:(value:T|null)=>T|null):Promise<T|null>;
  list(dir:string):Promise<Array<{name:string;path:string;type:'file'|'dir'}>>;
  remove(path:string):Promise<void>;
}
export interface PaymentProvider { create(order:Order):Promise<Payment>; query(id:string):Promise<WechatTransaction>; close(id:string):Promise<void> }
export interface CreateInput { merchantOrderId:string; sku:string; quantity?:number; channel:Channel; returnUrl?:string; payerOpenid?:string; clientIp?:string; expectedTotal?:number }
export const orderPath=(id:string)=>`orders/${id.slice(0,2)}/${id}.json`;
const workPath=(id:string)=>`work/${id}.json`;
export const validId=(id:string)=>/^[a-f0-9]{32}$/.test(id);
const nowIso=()=>new Date().toISOString();

export class PaymentService {
  readonly store:OrderStore;
  readonly provider:PaymentProvider;
  readonly fetcher:typeof fetch;
  constructor(readonly env:Env,deps?:{store?:OrderStore;provider?:PaymentProvider;fetcher?:typeof fetch}) {
    this.fetcher=deps?.fetcher||((input,init)=>globalThis.fetch(input,init));
    this.store=deps?.store||new GithubStore({token:env.GITHUB_TOKEN!,repo:env.GITHUB_DATA_REPO,branch:env.GITHUB_DATA_BRANCH,encryptionKey:env.ENCRYPTION_KEY!});
    this.provider=deps?.provider||new WechatPay(env);
  }
  async read(id:string):Promise<Order> {
    if (!validId(id)) throw new HttpError(404,'ORDER_NOT_FOUND','未找到该订单');
    const item=await this.store.read<Order>(orderPath(id));
    if (!item) throw new HttpError(404,'ORDER_NOT_FOUND','未找到该订单');
    return item.value;
  }
  private validate(client:Client,input:CreateInput):{product:Client['products'][string];quantity:number;returnUrl?:string} {
    if (client.disabled) throw new HttpError(403,'CLIENT_DISABLED','该产品已暂停创建新订单');
    if (!input || typeof input!=='object' || typeof input.merchantOrderId!=='string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,95}$/.test(input.merchantOrderId) || typeof input.sku!=='string' || !Object.hasOwn(client.products,input.sku)) throw new HttpError(400,'ORDER_INVALID','商品或业务订单号不正确');
    const allowedKeys=['merchantOrderId','sku','quantity','channel','returnUrl','payerOpenid','clientIp','expectedTotal'];
    if (Object.keys(input).some(k=>!allowedKeys.includes(k))) throw new HttpError(400,'ORDER_FIELDS_INVALID','订单包含不支持的字段；价格由服务端商品配置确定');
    const product=client.products[input.sku],quantity=input.quantity??1;
    if (!Number.isInteger(quantity) || quantity<1 || quantity>(product.maxQuantity||1) || !Number.isSafeInteger(product.amount*quantity) || product.amount*quantity>100000000) throw new HttpError(400,'QUANTITY_INVALID','商品数量不正确');
    if (input.expectedTotal!==undefined && (!Number.isSafeInteger(input.expectedTotal) || input.expectedTotal!==product.amount*quantity)) throw new HttpError(409,'CATALOG_PRICE_CHANGED','商品价格与业务订单预期不一致，请同步商品配置后重试');
    if (!client.channels.includes(input.channel) || !enabledChannels(this.env).includes(input.channel)) throw new HttpError(400,'CHANNEL_DISABLED','该产品尚未启用此支付方式');
    appIdFor(this.env,input.channel);
    let returnUrl:string|undefined;
    if (input.returnUrl!==undefined) {
      try { const u=new URL(input.returnUrl); if (u.username || u.password || u.hash || !client.returnOrigins.some(x=>originMatches(u.origin,x))) throw Error(); returnUrl=u.toString(); }
      catch { throw new HttpError(400,'RETURN_URL_INVALID','返回地址未登记'); }
    }
    if (input.channel==='jsapi' && (typeof input.payerOpenid!=='string' || !/^[a-zA-Z0-9_-]{10,128}$/.test(input.payerOpenid))) throw new HttpError(400,'OPENID_REQUIRED','此支付方式需要关联 AppID 下的 OpenID');
    if (input.channel==='h5' && !validIp(input.clientIp)) throw new HttpError(400,'CLIENT_IP_REQUIRED','H5 支付需要由产品后端提供真实用户 IP');
    return {product,quantity,returnUrl};
  }
  async create(client:Client,input:CreateInput):Promise<Order> {
    const {product,quantity,returnUrl}=this.validate(client,input);
    const id=(await hmac(this.env.ORDER_ID_SECRET!,`${client.id}\n${input.merchantOrderId}`)).slice(0,32);
    const immutable={clientId:client.id,merchantOrderId:input.merchantOrderId,sku:input.sku,quantity,description:product.description,total:product.amount*quantity,channel:input.channel,appId:appIdFor(this.env,input.channel),returnUrl:returnUrl||null,payerOpenid:input.channel==='jsapi'?input.payerOpenid:null,clientIp:input.channel==='h5'?input.clientIp:null};
    const requestHash=await sha256(JSON.stringify(immutable));
    const ttl=input.channel==='h5'?5:Math.max(5,Math.min(120,Number(this.env.ORDER_TTL_MINUTES)||15));
    let order:Order={version:1,id,clientId:client.id,clientName:client.name,merchantOrderId:input.merchantOrderId,sku:input.sku,quantity,description:product.description,total:product.amount*quantity,currency:'CNY',appId:immutable.appId,channel:input.channel,status:'CREATING',createdAt:nowIso(),expiresAt:new Date(Date.now()+ttl*60000).toISOString(),...(returnUrl?{returnUrl}:{}),...(input.channel==='jsapi'?{payerOpenid:input.payerOpenid}:{}),...(input.channel==='h5'?{clientIp:input.clientIp}:{}),requestHash,delivery:null};
    const existing=await this.store.read<Order>(orderPath(id));
    if (existing) order=existing.value;
    else if (!await this.store.create(orderPath(id),order)) order=await this.read(id);
    if (order.requestHash!==requestHash) throw new HttpError(409,'IDEMPOTENCY_CONFLICT','该业务订单号已用于其他订单内容，请使用原请求重试');
    if (order.status!=='CREATING') return order;
    // Durable work reference precedes contacting WeChat: cron can recover a lost response.
    await this.store.create(workPath(id),{id,createdAt:order.createdAt});
    return this.prepare(order);
  }
  private async prepare(order:Order):Promise<Order> {
    if (Date.parse(order.expiresAt)<=Date.now()) return this.refresh(order.id);
    let payment:Payment;
    try { payment=await this.provider.create(order); }
    catch (error) {
      if (error instanceof WechatError && ['ORDERPAID','OUT_TRADE_NO_USED','ORDER_CLOSED'].includes(error.providerCode)) return this.applyTransaction(await this.provider.query(order.id));
      throw error;
    }
    return (await this.store.update<Order>(orderPath(order.id),current=>{
      if (!current) throw new HttpError(404,'ORDER_NOT_FOUND','未找到订单');
      if (current.status==='SUCCESS' || current.status==='CLOSED') return current;
      return {...current,payment,status:'PENDING'};
    }))!;
  }
  async publicOrder(order:Order):Promise<Record<string,unknown>> {
    let payment=order.payment;
    if (payment?.channel==='h5' && payment.h5Url) {
      const h5=new URL(payment.h5Url);
      h5.searchParams.set('redirect_url',await this.checkoutUrl(order));
      payment={...payment,h5Url:h5.toString()};
    }
    return {id:order.id,clientName:order.clientName,description:order.description,amount:{total:order.total,currency:order.currency},status:order.status,expiresAt:order.expiresAt,returnUrl:order.returnUrl,payment:order.status==='PENDING'?payment:undefined,deliveryStatus:order.delivery?.status||null};
  }
  async clientOrder(order:Order):Promise<Record<string,unknown>> {
    return {...await this.publicOrder(order),clientId:order.clientId,merchantOrderId:order.merchantOrderId,sku:order.sku,quantity:order.quantity,transactionId:order.transactionId,paidAt:order.paidAt,checkoutUrl:await this.checkoutUrl(order)};
  }
  async checkoutUrl(order:Order):Promise<string> { return `${baseUrl(this.env)}/checkout/${order.id}#token=${await checkoutToken(order.id,this.env)}`; }
  async applyTransaction(tx:WechatTransaction):Promise<Order> {
    if (!tx || !validId(tx.out_trade_no)) throw new HttpError(400,'TRANSACTION_INVALID','支付订单号不正确');
    const current=await this.read(tx.out_trade_no);
    validateTransaction(this.env,current,tx);
    const updated=await this.store.update<Order>(orderPath(current.id),order=>{
      if (!order) throw new HttpError(404,'ORDER_NOT_FOUND','未找到订单');
      validateTransaction(this.env,order,tx);
      if (order.status==='SUCCESS') {
        if (tx.trade_state==='SUCCESS' && order.transactionId!==tx.transaction_id) throw new HttpError(409,'TRANSACTION_CONFLICT','支付流水号冲突');
        return order;
      }
      const common={...order,queryLeaseUntil:undefined,lastQueryAt:nowIso()};
      if (tx.trade_state==='SUCCESS') return {...common,status:'SUCCESS',transactionId:tx.transaction_id,paidAt:tx.success_time,delivery:{status:'pending',attempts:0,nextAt:nowIso()}};
      if (['CLOSED','REVOKED','REFUND'].includes(tx.trade_state)) return {...common,status:'CLOSED'};
      if (tx.trade_state==='PAYERROR') return {...common,status:'PAYERROR'};
      return common;
    });
    return updated!;
  }
  async refresh(id:string,force=false):Promise<Order> {
    const original=await this.read(id);
    if (original.status==='SUCCESS' || original.status==='CLOSED') return original;
    const now=Date.now();
    const claimed=await this.store.update<Order>(orderPath(id),order=>{
      if (!order || order.status==='SUCCESS' || order.status==='CLOSED' || Date.parse(order.queryLeaseUntil||'')>now || (!force && now-Date.parse(order.lastQueryAt||'1970-01-01')<15000)) return null;
      return {...order,lastQueryAt:new Date(now).toISOString(),queryLeaseUntil:new Date(now+30000).toISOString()};
    });
    if (!claimed) return this.read(id);
    try {
      const tx=await this.provider.query(id);
      const updated=await this.applyTransaction(tx);
      if (tx.trade_state==='NOTPAY' && Date.parse(updated.expiresAt)<=Date.now()) {
        try { await this.provider.close(id); }
        catch (error) {
          if (!(error instanceof WechatError && error.providerCode==='ORDERPAID')) throw error;
          return this.applyTransaction(await this.provider.query(id));
        }
        return this.applyTransaction(await this.provider.query(id));
      }
      return updated;
    } catch (error) {
      if (error instanceof WechatError && ['ORDER_NOT_EXIST','ORDERNOTEXIST'].includes(error.providerCode)) {
        if (Date.parse(claimed.expiresAt)>Date.now()) return this.prepare(claimed);
        return (await this.store.update<Order>(orderPath(id),order=>order?.status==='CREATING'?{...order,status:'CLOSED',queryLeaseUntil:undefined}:order))!;
      }
      throw error;
    } finally {
      // Lease expires naturally on failure. Avoid a needless GitHub write in the error path.
    }
  }
  async deliver(id:string):Promise<Order> {
    const now=Date.now(),lease=randomHex();
    const order=await this.store.update<Order>(orderPath(id),current=>{
      const d=current?.delivery;
      if (!current || current.status!=='SUCCESS' || !d || d.status!=='pending' || Date.parse(d.nextAt)>now || Date.parse(d.leaseUntil||'')>now) return null;
      return {...current,delivery:{...d,attempts:d.attempts+1,leaseUntil:new Date(now+60000).toISOString(),nextAt:new Date(now+60000).toISOString()}};
    });
    if (!order) return this.read(id);
    const client=clients(this.env).find(c=>c.id===order.clientId);
    if (!client) throw new HttpError(503,'CLIENT_NOT_CONFIGURED','原产品接入配置缺失');
    const eventId='payment.success.'+id;
    const body=JSON.stringify({eventId,type:'payment.success',orderId:id,clientId:order.clientId,merchantOrderId:order.merchantOrderId,sku:order.sku,quantity:order.quantity,total:order.total,currency:order.currency,transactionId:order.transactionId,paidAt:order.paidAt});
    const timestamp=String(Math.floor(Date.now()/1000));
    const signature=await hmac(client.webhookSecret,`${timestamp}\n${lease}\n${body}\n`);
    let delivered=false;
    try {
      const response=await this.fetcher(client.webhookUrl,{method:'POST',headers:{'Content-Type':'application/json','X-Brclio-Event':eventId,'X-Brclio-Timestamp':timestamp,'X-Brclio-Nonce':lease,'X-Brclio-Signature':signature},body,redirect:'manual',signal:AbortSignal.timeout(8000)});
      delivered=response.ok;
      await response.body?.cancel();
    } catch { /* Timeout and non-2xx are retried through durable work. */ }
    const updated=(await this.store.update<Order>(orderPath(id),current=>{
      if (!current?.delivery || current.delivery.status==='delivered') return current;
      // A worker that lost its lease must not overwrite a newer delivery result.
      if (current.delivery.leaseUntil!==order.delivery!.leaseUntil || current.delivery.attempts!==order.delivery!.attempts) return current;
      return {...current,delivery:{...current.delivery,status:delivered?'delivered':current.delivery.attempts>=20?'manual':'pending',leaseUntil:undefined,nextAt:new Date(Date.now()+Math.min(6*3600000,60000*2**Math.min(current.delivery.attempts,9))).toISOString(),...(delivered?{deliveredAt:nowIso()}:{})}};
    }))!;
    if (updated.delivery?.status==='delivered') await this.store.remove(workPath(id));
    return updated;
  }
  async retryNotification(order:Order):Promise<Order> {
    if (order.status!=='SUCCESS') throw new HttpError(409,'ORDER_NOT_PAID','仅已支付订单可以重试通知');
    if (order.delivery?.status==='delivered') return order;
    await this.store.create(workPath(order.id),{id:order.id,createdAt:order.createdAt});
    await this.store.update<Order>(orderPath(order.id),current=>current && current.delivery?.status!=='delivered' && !(Date.parse(current.delivery?.leaseUntil||'')>Date.now())?{...current,delivery:{status:'pending',attempts:0,nextAt:nowIso()}}:null);
    return this.deliver(order.id);
  }
  async processWork(scheduledTime=Date.now()):Promise<{processed:number;failed:number}> {
    const entries=(await this.store.list('work')).filter(x=>x.type==='file' && /^[a-f0-9]{32}\.json$/.test(x.name));
    // Rotate through a bounded batch so low-volume GitHub storage stays within Worker budgets.
    const start=entries.length?Math.floor(scheduledTime/600000)*10%entries.length:0;
    let processed=0,failed=0;
    for (let i=0;i<Math.min(10,entries.length);i++) {
      const id=entries[(start+i)%entries.length].name.slice(0,-5);
      try {
        let order=await this.read(id);
        if (!['SUCCESS','CLOSED'].includes(order.status)) order=await this.refresh(id);
        if (order.status==='SUCCESS' && order.delivery?.status==='pending') order=await this.deliver(id);
        if (order.status==='CLOSED' || order.delivery?.status==='delivered') await this.store.remove(workPath(id));
        processed++;
      } catch { failed++; }
    }
    return {processed,failed};
  }
}
export function validateTransaction(env:Env,order:Order,tx:WechatTransaction):void {
  const amountMismatch=tx.trade_state==='SUCCESS'
    ? !tx.amount || tx.amount.total!==order.total || tx.amount.currency!=='CNY'
    : tx.amount && (tx.amount.total!==order.total || (tx.amount.currency!==undefined && tx.amount.currency!=='CNY'));
  // WeChat legitimately omits amount and trade_type when an order is unpaid/closed.
  // Successful payments must always provide and match the exact amount and currency.
  if (tx.mchid!==env.WECHAT_MCH_ID || tx.appid!==order.appId || tx.out_trade_no!==order.id || amountMismatch || (tx.trade_type && tx.trade_type!==(order.channel==='h5'?'MWEB':order.channel.toUpperCase()))) throw new HttpError(400,'TRANSACTION_MISMATCH','支付通知与订单不匹配');
  if (!['SUCCESS','REFUND','NOTPAY','CLOSED','REVOKED','USERPAYING','PAYERROR'].includes(tx.trade_state)) throw new HttpError(400,'TRANSACTION_INVALID','支付状态不正确');
  if (tx.trade_state==='SUCCESS' && (!/^\d{20,64}$/.test(tx.transaction_id||'') || !tx.success_time || !Number.isFinite(Date.parse(tx.success_time)))) throw new HttpError(400,'TRANSACTION_INVALID','支付流水信息不完整');
}
function validIp(value:unknown):value is string {
  if (typeof value!=='string' || value.length>45) return false;
  if (value.includes(':')) { try { return new URL(`https://[${value}]/`).hostname.length>0; } catch { return false; } }
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(value) && value.split('.').every(x=>Number(x)<=255);
}
