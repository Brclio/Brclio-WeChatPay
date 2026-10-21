import { hmac, randomHex, sha256 } from './crypto';
import { appIdFor, baseUrl, clients, enabledChannels, originMatches } from './config';
import { checkoutToken } from './auth';
import { GithubStore } from './store';
import { WechatError, WechatPay } from './wechat';
import { HttpError, type Client, type Env, type Order, type OrderEvent, type CloseRequest, type Payment, type Channel, type WechatTransaction } from './types';

export interface OrderStore {
  read<T>(path:string):Promise<{value:T;sha:string}|null>;
  create<T>(path:string,value:T):Promise<boolean>;
  update<T>(path:string,mutator:(value:T|null)=>T|null):Promise<T|null>;
  list(dir:string):Promise<Array<{name:string;path:string;type:'file'|'dir'}>>;
  remove(path:string):Promise<void>;
}
export interface PaymentProvider { create(order:Order):Promise<Payment>; query(id:string):Promise<WechatTransaction>; close(id:string):Promise<void> }
export interface CreateInput { merchantOrderId:string; sku:string; quantity?:number; channel:Channel; returnUrl?:string; payerOpenid?:string; clientIp?:string; expectedTotal?:number }
interface WorkEntry { id:string; createdAt:string; draft?:Order; transaction?:WechatTransaction }
export const orderPath=(id:string)=>`orders/${id.slice(0,2)}/${id}.json`;
const workPath=(id:string)=>`work/${id}.json`;
const deliveryWorkPath=(id:string)=>`work/${id}-delivery.json`;
export const validId=(id:string)=>/^[a-f0-9]{32}$/.test(id);
const nowIso=()=>new Date().toISOString();
export const orderExpiresAt=(order:Order):string=>new Date(Math.min(Date.parse(order.expiresAt),Date.parse(order.createdAt)+5*60000)).toISOString();
function event(type:string,details:Omit<OrderEvent,'id'|'at'|'type'>={}):OrderEvent { return {id:randomHex(),at:nowIso(),type,...details}; }
function record(order:Order,entry:OrderEvent):Order { return {...order,updatedAt:entry.at,history:[...(order.history||[]),entry]}; }

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
  private validateInput(client:Client,input:CreateInput):void {
    if (typeof client.id!=='string' || !/^[a-z0-9][a-z0-9_-]{1,63}$/.test(client.id) || !input || typeof input!=='object' || Array.isArray(input) || typeof input.merchantOrderId!=='string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,95}$/.test(input.merchantOrderId) || typeof input.sku!=='string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(input.sku)) throw new HttpError(400,'ORDER_INVALID','商品或业务订单号不正确');
    const allowedKeys=['merchantOrderId','sku','quantity','channel','returnUrl','payerOpenid','clientIp','expectedTotal'];
    if (Object.keys(input).some(k=>!allowedKeys.includes(k))) throw new HttpError(400,'ORDER_FIELDS_INVALID','订单包含不支持的字段；价格由服务端商品配置确定');
  }
  private validate(client:Client,input:CreateInput):{product:Client['products'][string];quantity:number;returnUrl?:string} {
    if (client.disabled) throw new HttpError(403,'CLIENT_DISABLED','该产品已暂停创建新订单');
    if (!Object.hasOwn(client.products,input.sku)) throw new HttpError(400,'ORDER_INVALID','商品或业务订单号不正确');
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
  private validateReplay(order:Order,client:Client,input:CreateInput):void {
    const quantity=input.quantity??1;
    if (!Number.isSafeInteger(quantity) || quantity<1) throw new HttpError(400,'QUANTITY_INVALID','商品数量不正确');
    let returnUrl:string|undefined;
    if (input.returnUrl!==undefined) {
      try { const u=new URL(input.returnUrl);if(u.username || u.password || u.hash)throw Error();returnUrl=u.toString(); }
      catch { throw new HttpError(400,'RETURN_URL_INVALID','返回地址未登记'); }
    }
    if (order.clientId!==client.id || order.merchantOrderId!==input.merchantOrderId || order.sku!==input.sku || order.quantity!==quantity || order.channel!==input.channel || (order.returnUrl||undefined)!==returnUrl || (order.channel==='jsapi' && order.payerOpenid!==input.payerOpenid) || (order.channel==='h5' && order.clientIp!==input.clientIp)) throw new HttpError(409,'IDEMPOTENCY_CONFLICT','该业务订单号已用于其他订单内容，请使用原请求重试');
    if (input.expectedTotal!==undefined && (!Number.isSafeInteger(input.expectedTotal) || input.expectedTotal!==order.total)) throw new HttpError(409,'CATALOG_PRICE_CHANGED','商品价格与业务订单预期不一致，请同步商品配置后重试');
  }
  private async draft(id:string):Promise<Order|null> {
    const job=await this.store.read<WorkEntry>(workPath(id));
    if (!job) return null;
    if (job.value.id!==id || !job.value.draft || job.value.draft.id!==id || job.value.draft.version!==1) {
      // A concurrent creator may already have completed the canonical write.
      const current=await this.store.read<Order>(orderPath(id));
      if (current) return current.value;
      throw new HttpError(503,'WORK_RECORD_INVALID','订单恢复记录不正确');
    }
    return job.value.draft;
  }
  private async replay(order:Order,client:Client,input:CreateInput):Promise<Order> {
    this.validateReplay(order,client,input);
    if (order.status!=='CREATING' || client.disabled) return this.enforceExpiry(order);
    await this.store.create<WorkEntry>(workPath(order.id),{id:order.id,createdAt:order.createdAt,draft:order});
    return this.prepare(order);
  }
  async create(client:Client,input:CreateInput):Promise<Order> {
    this.validateInput(client,input);
    const id=(await hmac(this.env.ORDER_ID_SECRET!,`${client.id}\n${input.merchantOrderId}`)).slice(0,32);
    const existing=await this.store.read<Order>(orderPath(id));
    if (existing) return this.replay(existing.value,client,input);
    const pendingDraft=await this.draft(id);
    if (pendingDraft) {
      this.validateReplay(pendingDraft,client,input);
      const restored=await this.store.create(orderPath(id),pendingDraft)?pendingDraft:await this.read(id);
      return this.replay(restored,client,input);
    }
    const {product,quantity,returnUrl}=this.validate(client,input);
    const immutable={clientId:client.id,merchantOrderId:input.merchantOrderId,sku:input.sku,quantity,description:product.description,total:product.amount*quantity,channel:input.channel,appId:appIdFor(this.env,input.channel),returnUrl:returnUrl||null,payerOpenid:input.channel==='jsapi'?input.payerOpenid:null,clientIp:input.channel==='h5'?input.clientIp:null};
    const requestHash=await sha256(JSON.stringify(immutable));
    const ttl=5,createdAt=nowIso();
    let order:Order={version:1,id,clientId:client.id,clientName:client.name,merchantOrderId:input.merchantOrderId,sku:input.sku,quantity,description:product.description,total:product.amount*quantity,currency:'CNY',appId:immutable.appId,channel:input.channel,status:'CREATING',createdAt,expiresAt:new Date(Date.parse(createdAt)+ttl*60000).toISOString(),...(returnUrl?{returnUrl}:{}),...(input.channel==='jsapi'?{payerOpenid:input.payerOpenid}:{}),...(input.channel==='h5'?{clientIp:input.clientIp}:{}),requestHash,delivery:null,updatedAt:createdAt,history:[event('created',{toStatus:'CREATING',actor:client.id})]};
    // The durable draft wins races between concurrent creates, including a
    // catalog update between two attempts to create the same business order.
    if (!await this.store.create<WorkEntry>(workPath(id),{id,createdAt:order.createdAt,draft:order})) {
      const saved=await this.draft(id);
      if (!saved) throw new HttpError(503,'WORK_RECORD_INVALID','订单恢复记录不正确');
      order=saved;
    }
    this.validateReplay(order,client,input);
    if (!await this.store.create(orderPath(id),order)) order=await this.read(id);
    return this.replay(order,client,input);
  }
  private async prepare(order:Order):Promise<Order> {
    if (Date.parse(orderExpiresAt(order))<=Date.now() || order.closeRequested) return this.refresh(order.id);
    // WeChat extends a too-short time_expire to one minute after acceptance.
    // Do not create a late prepay session that could outlive our fixed deadline.
    if (Date.parse(orderExpiresAt(order))-Date.now()<90000) return order;
    let payment:Payment;
    try { payment=await this.provider.create({...order,expiresAt:orderExpiresAt(order)}); }
    catch (error) {
      if (error instanceof WechatError && ['ORDERPAID','OUT_TRADE_NO_USED','ORDER_CLOSED'].includes(error.providerCode)) return this.applyTransaction(await this.query(order.id));
      throw error;
    }
    const prepared=event('payment_prepared',{toStatus:'PENDING'});
    return (await this.store.update<Order>(orderPath(order.id),current=>{
      if (!current) throw new HttpError(404,'ORDER_NOT_FOUND','未找到订单');
      if (current.status==='SUCCESS' || current.status==='CLOSED') return current;
      if (current.closeRequested) return current;
      return record({...current,payment,status:'PENDING'}, {...prepared,fromStatus:current.status});
    }))!;
  }
  async publicOrder(order:Order):Promise<Record<string,unknown>> {
    let payment=order.payment;
    if (payment?.channel==='h5' && payment.h5Url) {
      const h5=new URL(payment.h5Url);
      h5.searchParams.set('redirect_url',await this.checkoutUrl(order));
      payment={...payment,h5Url:h5.toString()};
    }
    return {id:order.id,clientName:order.clientName,description:order.description,amount:{total:order.total,currency:order.currency},status:order.status,expiresAt:orderExpiresAt(order),returnUrl:order.returnUrl,payment:order.status==='PENDING' && !order.closeRequested && Date.parse(orderExpiresAt(order))>Date.now()?payment:undefined,deliveryStatus:order.delivery?.status||null,closedAt:order.closedAt,closeReason:order.closeReason,closing:!!order.closeRequested && !['SUCCESS','CLOSED'].includes(order.status)};
  }
  async clientOrder(order:Order):Promise<Record<string,unknown>> {
    return {...await this.publicOrder(order),clientId:order.clientId,merchantOrderId:order.merchantOrderId,sku:order.sku,quantity:order.quantity,transactionId:order.transactionId,paidAt:order.paidAt,checkoutUrl:await this.checkoutUrl(order)};
  }
  async checkoutUrl(order:Order):Promise<string> { return `${baseUrl(this.env)}/checkout/${order.id}#token=${await checkoutToken(order.id,this.env)}`; }
  private async query(id:string):Promise<WechatTransaction> {
    const tx=await this.provider.query(id);
    if (!tx || tx.out_trade_no!==id) throw new HttpError(400,'TRANSACTION_MISMATCH','微信查单结果与请求订单不匹配');
    return tx;
  }
  async applyTransaction(tx:WechatTransaction):Promise<Order> {
    if (!tx || !validId(tx.out_trade_no)) throw new HttpError(400,'TRANSACTION_INVALID','支付订单号不正确');
    const current=await this.read(tx.out_trade_no);
    validateTransaction(this.env,current,tx);
    // The work entry may already have been removed by a close or a previous delivery.
    // Restore it before persisting any newly confirmed payment so fulfillment is recoverable.
    if (tx.trade_state==='SUCCESS' && current.delivery?.status!=='delivered') {
      const transaction:WechatTransaction={appid:tx.appid,mchid:tx.mchid,out_trade_no:tx.out_trade_no,transaction_id:tx.transaction_id,trade_state:tx.trade_state,trade_type:tx.trade_type,success_time:tx.success_time,amount:tx.amount};
      await this.store.create<WorkEntry>(deliveryWorkPath(current.id),{id:current.id,createdAt:current.createdAt,transaction});
    }
    const changed=event(tx.trade_state==='SUCCESS'?'payment_confirmed':['CLOSED','REVOKED','REFUND'].includes(tx.trade_state)?'closed':'status_changed');
    const updated=await this.store.update<Order>(orderPath(current.id),order=>{
      if (!order) throw new HttpError(404,'ORDER_NOT_FOUND','未找到订单');
      validateTransaction(this.env,order,tx);
      if (order.status==='SUCCESS') {
        if (tx.trade_state==='SUCCESS' && order.transactionId!==tx.transaction_id) throw new HttpError(409,'TRANSACTION_CONFLICT','支付流水号冲突');
        return order;
      }
      // A stale unpaid query must never reopen a closed order. A verified payment
      // can still repair a close/payment race, with its work entry restored above.
      if (order.status==='CLOSED' && tx.trade_state!=='SUCCESS') return order;
      const common={...order,queryLeaseUntil:undefined,lastQueryAt:changed.at};
      if (tx.trade_state==='SUCCESS') return record({...common,status:'SUCCESS',transactionId:tx.transaction_id,paidAt:tx.success_time,delivery:{status:'pending',attempts:0,nextAt:changed.at}},{...changed,fromStatus:order.status,toStatus:'SUCCESS'});
      if (['CLOSED','REVOKED','REFUND'].includes(tx.trade_state)) return record({...common,status:'CLOSED',closedAt:changed.at,closeReason:order.closeRequested?.source||'provider'},{...changed,fromStatus:order.status,toStatus:'CLOSED'});
      if (tx.trade_state==='PAYERROR' && order.status!=='PAYERROR') return record({...common,status:'PAYERROR'},{...changed,fromStatus:order.status,toStatus:'PAYERROR'});
      return common;
    });
    return updated!;
  }
  async enforceExpiry(order:Order):Promise<Order> {
    if (!['SUCCESS','CLOSED'].includes(order.status) && (order.closeRequested || Date.parse(orderExpiresAt(order))<=Date.now())) return this.refresh(order.id);
    return order;
  }
  private async requestClose(order:Order,source:CloseRequest['source'],actor?:string,reason?:string):Promise<Order> {
    if (['SUCCESS','CLOSED'].includes(order.status)) return order;
    await this.store.create(workPath(order.id),{id:order.id,createdAt:order.createdAt});
    const entry=event('close_requested',{actor,reason:reason||'超过支付有效期',outcome:'requested'});
    return (await this.store.update<Order>(orderPath(order.id),current=>{
      if (!current) throw new HttpError(404,'ORDER_NOT_FOUND','未找到订单');
      if (current.closeRequested || ['SUCCESS','CLOSED'].includes(current.status)) return current;
      return record({...current,closeRequested:{at:entry.at,source,...(actor?{actor}:{}),...(reason?{reason}:{})}},entry);
    }))!;
  }
  async refresh(id:string,force=false,verifyClosed=false):Promise<Order> {
    let original=await this.read(id);
    if (original.status==='CLOSED' && verifyClosed) {
      try { return await this.applyTransaction(await this.query(id)); }
      catch (error) { if (error instanceof WechatError && ['ORDER_NOT_EXIST','ORDERNOTEXIST'].includes(error.providerCode)) return original;throw error; }
    }
    if (original.status==='SUCCESS' || original.status==='CLOSED') return original;
    if (!original.closeRequested && Date.parse(orderExpiresAt(original))<=Date.now()) original=await this.requestClose(original,'timeout');
    const now=Date.now();
    const claimed=await this.store.update<Order>(orderPath(id),order=>{
      if (!order || order.status==='SUCCESS' || order.status==='CLOSED' || Date.parse(order.queryLeaseUntil||'')>now || (!force && !order.closeRequested && now-Date.parse(order.lastQueryAt||'1970-01-01')<15000)) return null;
      return {...order,lastQueryAt:new Date(now).toISOString(),queryLeaseUntil:new Date(now+30000).toISOString()};
    });
    if (!claimed) return this.read(id);
    const tx=await this.queryOrRecover(claimed);
    if (!tx) return this.read(id);
    const updated=await this.applyTransaction(tx);
    if (updated.status==='SUCCESS' || updated.status==='CLOSED') return updated;
    if (updated.closeRequested && ['NOTPAY','PAYERROR'].includes(tx.trade_state)) {
      try { await this.provider.close(id); }
      catch (error) {
        // A failed/lost close response can race a payment or a successful close.
        // Only the next verified query decides whether either outcome happened.
        const reconciled=await this.applyTransaction(await this.query(id));
        if (['SUCCESS','CLOSED'].includes(reconciled.status)) return reconciled;
        throw error;
      }
      return this.applyTransaction(await this.query(id));
    }
    return updated;
  }
  private async queryOrRecover(order:Order):Promise<WechatTransaction|null> {
    try { return await this.query(order.id); }
    catch (error) {
      if (!(error instanceof WechatError && ['ORDER_NOT_EXIST','ORDERNOTEXIST'].includes(error.providerCode))) throw error;
      if (!order.closeRequested && Date.parse(orderExpiresAt(order))>Date.now()) { await this.prepare(order);return null; }
      // A prepay request may still be in flight. Keep the durable close intent
      // until either that order becomes visible or its payment deadline passes.
      if (order.status==='CREATING' && Date.parse(orderExpiresAt(order))>Date.now()) return null;
      const closed=event('closed',{toStatus:'CLOSED',reason:'微信确认订单不存在'});
      await this.store.update<Order>(orderPath(order.id),current=>{
        if (!current || current.status==='SUCCESS' || current.status==='CLOSED') return current;
        return record({...current,status:'CLOSED',closedAt:closed.at,closeReason:current.closeRequested?.source||'not-created',queryLeaseUntil:undefined},{...closed,fromStatus:current.status});
      });
      return null;
    }
  }
  async adminAction(id:string,action:'refresh'|'close'|'retry-notification',actor:string,reason:string):Promise<Order> {
    if (typeof reason!=='string' || reason.trim().length<3 || reason.trim().length>200 || /[\u0000-\u001f\u007f]/.test(reason)) throw new HttpError(400,'ACTION_REASON_REQUIRED','请填写 3–200 字的操作原因');
    if (!['refresh','close','retry-notification'].includes(action)) throw new HttpError(400,'ACTION_INVALID','不支持此订单操作');
    const original=await this.read(id);
    if (action==='close' && original.status==='SUCCESS') throw new HttpError(409,'ORDER_ALREADY_PAID','已付款订单不能关闭');
    if (action==='retry-notification' && original.status!=='SUCCESS') throw new HttpError(409,'ORDER_NOT_PAID','仅已支付订单可以重试通知');
    const requested=event('admin_'+action,{actor,reason:reason.trim(),outcome:'requested'});
    await this.store.update<Order>(orderPath(id),current=>current?record(current,requested):null);
    try {
      let result:Order;
      if (action==='close') { await this.requestClose(await this.read(id),'admin',actor,reason.trim());result=await this.refresh(id,true); }
      else if (action==='retry-notification') result=await this.retryNotification(await this.read(id));
      else result=await this.refresh(id,true,true);
      if (result.status==='SUCCESS' && result.delivery?.status==='pending' && action!=='retry-notification') result=await this.deliver(id);
      const completed=event('admin_'+action,{actor,reason:reason.trim(),outcome:'succeeded'});
      return (await this.store.update<Order>(orderPath(id),current=>current?record(current,completed):null))!;
    } catch (error) {
      const failed=event('admin_'+action,{actor,reason:reason.trim(),outcome:'failed',code:error instanceof HttpError?error.code:'ACTION_FAILED'});
      await this.store.update<Order>(orderPath(id),current=>current?record(current,failed):null);
      throw error;
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
    const deliveryEvent=event(delivered?'notification_delivered':'notification_failed',{outcome:delivered?'succeeded':'failed'});
    const updated=(await this.store.update<Order>(orderPath(id),current=>{
      if (!current?.delivery || current.delivery.status==='delivered') return current;
      // A worker that lost its lease must not overwrite a newer delivery result.
      if (current.delivery.leaseUntil!==order.delivery!.leaseUntil || current.delivery.attempts!==order.delivery!.attempts) return current;
      return record({...current,delivery:{...current.delivery,status:delivered?'delivered':current.delivery.attempts>=20?'manual':'pending',leaseUntil:undefined,nextAt:new Date(Date.now()+Math.min(6*3600000,60000*2**Math.min(current.delivery.attempts,9))).toISOString(),...(delivered?{deliveredAt:deliveryEvent.at}:{})}},deliveryEvent);
    }))!;
    if (updated.delivery?.status==='delivered') {
      await this.store.remove(workPath(id));
      await this.store.remove(deliveryWorkPath(id));
    }
    return updated;
  }
  async retryNotification(order:Order):Promise<Order> {
    order=await this.read(order.id);
    if (order.status!=='SUCCESS') throw new HttpError(409,'ORDER_NOT_PAID','仅已支付订单可以重试通知');
    if (order.delivery?.status==='delivered') return order;
    await this.store.create(deliveryWorkPath(order.id),{id:order.id,createdAt:order.createdAt});
    const retry=event('notification_retry');
    await this.store.update<Order>(orderPath(order.id),current=>current && current.delivery?.status!=='delivered' && !(Date.parse(current.delivery?.leaseUntil||'')>Date.now())?record({...current,delivery:{status:'pending',attempts:0,nextAt:retry.at}},retry):null);
    return this.deliver(order.id);
  }
  async processWork(scheduledTime=Date.now()):Promise<{processed:number;failed:number}> {
    const entries=(await this.store.list('work')).filter(x=>x.type==='file' && /^[a-f0-9]{32}(?:-delivery)?\.json$/.test(x.name));
    // Rotate through a bounded batch so low-volume GitHub storage stays within Worker budgets.
    const start=entries.length?Math.floor(scheduledTime/60000)*10%entries.length:0;
    let processed=0,failed=0;
    for (let i=0;i<Math.min(10,entries.length);i++) {
      const entry=entries[(start+i)%entries.length],id=entry.name.slice(0,32),deliveryWork=entry.name.endsWith('-delivery.json');
      try {
        let order:Order;
        try { order=await this.read(id); }
        catch (error) {
          if (!(error instanceof HttpError && error.code==='ORDER_NOT_FOUND') || deliveryWork) throw error;
          const job=await this.store.read<WorkEntry>(entry.path),draft=job?.value.draft;
          if (!draft || draft.version!==1 || draft.id!==id || job?.value.id!==id) throw error;
          await this.store.create(orderPath(id),draft);
          order=await this.read(id);
        }
        if (deliveryWork && order.status!=='SUCCESS') {
          const job=await this.store.read<WorkEntry>(entry.path);
          const transaction=job?.value.transaction||await this.query(id);
          if (transaction.out_trade_no!==id) throw new HttpError(400,'TRANSACTION_MISMATCH','支付结果与待恢复订单不匹配');
          order=await this.applyTransaction(transaction);
        }
        if (!deliveryWork && !['SUCCESS','CLOSED'].includes(order.status)) order=await this.refresh(id);
        if (order.status==='SUCCESS' && order.delivery?.status==='pending') order=await this.deliver(id);
        if (deliveryWork) {
          if (order.status==='SUCCESS' && order.delivery?.status==='delivered') await this.store.remove(entry.path);
        } else if (order.status==='CLOSED' || order.delivery?.status==='delivered') await this.store.remove(entry.path);
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
