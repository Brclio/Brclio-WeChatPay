import { rsaSign, rsaVerify, randomHex, decryptResource } from './crypto';
import { baseUrl } from './config';
import { HttpError, type Env, type Order, type Payment, type WechatTransaction } from './types';
export class WechatError extends HttpError {
  constructor(public providerCode:string) { super(502,'WECHAT_REQUEST_FAILED','微信支付暂时未完成请求，请使用同一业务订单号重试或查单'); }
}
export class WechatPay {
  constructor(private env:Env, private fetcher:typeof fetch=(input,init)=>globalThis.fetch(input,init)) {}
  async verify(headers:Headers,body:string):Promise<void> {
    const timestamp=headers.get('Wechatpay-Timestamp')||'';
    const nonce=headers.get('Wechatpay-Nonce')||'';
    const signature=headers.get('Wechatpay-Signature')||'';
    const serial=headers.get('Wechatpay-Serial')||'';
    if (!/^\d{10}$/.test(timestamp) || Math.abs(Date.now()/1000-Number(timestamp))>300 || !nonce || nonce.length>256 || !signature || signature.startsWith('WECHATPAY/SIGNTEST/')) throw new HttpError(401,'WECHAT_SIGNATURE_INVALID','微信支付签名校验失败');
    let keys:Record<string,string>;
    try { keys=JSON.parse(this.env.WECHAT_PUBLIC_KEYS_JSON||'{}'); } catch { throw new HttpError(503,'WECHAT_KEYS_INVALID','微信支付公钥配置不正确'); }
    const key=Object.hasOwn(keys,serial)?keys[serial]:undefined;
    if (!key || !serial.startsWith('PUB_KEY_ID_') || !await rsaVerify(key,`${timestamp}\n${nonce}\n${body}\n`,signature)) throw new HttpError(401,'WECHAT_SIGNATURE_INVALID','微信支付签名校验失败');
  }
  private async request<T>(method:string,path:string,value?:unknown):Promise<T> {
    const body=value===undefined?'':JSON.stringify(value);
    const timestamp=String(Math.floor(Date.now()/1000)), nonce=randomHex();
    const signature=await rsaSign(this.env.WECHAT_PRIVATE_KEY!,`${method}\n${path}\n${timestamp}\n${nonce}\n${body}\n`);
    const authorization=`WECHATPAY2-SHA256-RSA2048 mchid="${this.env.WECHAT_MCH_ID}",nonce_str="${nonce}",timestamp="${timestamp}",serial_no="${this.env.WECHAT_SERIAL_NO}",signature="${signature}"`;
    const keyMap=JSON.parse(this.env.WECHAT_PUBLIC_KEYS_JSON!);
    const publicKeyId=this.env.WECHAT_PUBLIC_KEY_ID||Object.keys(keyMap)[0];
    let response:Response;
    try { response=await this.fetcher('https://api.mch.weixin.qq.com'+path,{method,headers:{Authorization:authorization,Accept:'application/json','Content-Type':'application/json','User-Agent':'BrclioPay/0.1','Wechatpay-Serial':publicKeyId},body:body||undefined,redirect:'manual',signal:AbortSignal.timeout(8000)}); }
    catch { throw new HttpError(502,'WECHAT_UNAVAILABLE','微信支付网络暂时不可用，请稍后查单'); }
    const raw=await response.text();
    await this.verify(response.headers,raw);
    let data:any;
    try { data=raw?JSON.parse(raw):{}; } catch { throw new HttpError(502,'WECHAT_RESPONSE_INVALID','微信支付响应格式不正确'); }
    if (!response.ok) {
      const code=['ORDERPAID','ORDER_NOT_EXIST','ORDERNOTEXIST','OUT_TRADE_NO_USED','ORDER_CLOSED','PARAM_ERROR','NO_AUTH','APPID_MCHID_NOT_MATCH','FREQUENCY_LIMITED'].includes(data.code)?data.code:'UPSTREAM_ERROR';
      throw new WechatError(code);
    }
    return data as T;
  }
  async create(order:Order):Promise<Payment> {
    const value:Record<string,unknown>={appid:order.appId,mchid:this.env.WECHAT_MCH_ID,description:order.description,out_trade_no:order.id,time_expire:order.expiresAt,notify_url:baseUrl(this.env)+'/api/wechat/notify',amount:{total:order.total,currency:order.currency}};
    if (order.channel==='jsapi') value.payer={openid:order.payerOpenid};
    if (order.channel==='h5') value.scene_info={payer_client_ip:order.clientIp,h5_info:{type:'Wap'}};
    const data=await this.request<{code_url?:string;h5_url?:string;prepay_id?:string}>('POST','/v3/pay/transactions/'+order.channel,value);
    if (order.channel==='native') {
      if (!data.code_url?.startsWith('weixin://wxpay/bizpayurl?')) throw new HttpError(502,'WECHAT_RESPONSE_INVALID','微信二维码响应不正确');
      return {channel:'native',codeUrl:data.code_url};
    }
    if (order.channel==='h5') {
      const h5=new URL(data.h5_url||'');
      if (h5.protocol!=='https:' || h5.hostname!=='wx.tenpay.com') throw new HttpError(502,'WECHAT_RESPONSE_INVALID','微信 H5 响应不正确');
      // Token stays in a fragment; provider redirect first returns to the approved cashier domain.
      return {channel:'h5',h5Url:h5.toString()};
    }
    if (!data.prepay_id || !/^[a-zA-Z0-9_=-]{1,128}$/.test(data.prepay_id)) throw new HttpError(502,'WECHAT_RESPONSE_INVALID','微信预支付响应不正确');
    const timestamp=String(Math.floor(Date.now()/1000)),nonce=randomHex();
    if (order.channel==='jsapi') {
      const pkg='prepay_id='+data.prepay_id;
      return {channel:'jsapi',context:this.env.WECHAT_JSAPI_CONTEXT||'miniprogram',jsapi:{appId:order.appId,timeStamp:timestamp,nonceStr:nonce,package:pkg,signType:'RSA',paySign:await rsaSign(this.env.WECHAT_PRIVATE_KEY!,`${order.appId}\n${timestamp}\n${nonce}\n${pkg}\n`)}};
    }
    return {channel:'app',app:{appid:order.appId,partnerid:this.env.WECHAT_MCH_ID!,prepayid:data.prepay_id,package:'Sign=WXPay',noncestr:nonce,timestamp,sign:await rsaSign(this.env.WECHAT_PRIVATE_KEY!,`${order.appId}\n${timestamp}\n${nonce}\n${data.prepay_id}\n`)}};
  }
  query(id:string):Promise<WechatTransaction> { return this.request('GET',`/v3/pay/transactions/out-trade-no/${encodeURIComponent(id)}?mchid=${encodeURIComponent(this.env.WECHAT_MCH_ID!)}`); }
  async close(id:string):Promise<void> { await this.request('POST',`/v3/pay/transactions/out-trade-no/${encodeURIComponent(id)}/close`,{mchid:this.env.WECHAT_MCH_ID}); }
  async notification(headers:Headers,raw:string):Promise<WechatTransaction> {
    await this.verify(headers,raw);
    let event:any;
    try { event=JSON.parse(raw); } catch { throw new HttpError(400,'NOTIFY_INVALID','通知正文不正确'); }
    if (event.event_type!=='TRANSACTION.SUCCESS' || event.resource_type!=='encrypt-resource' || event.resource?.algorithm!=='AEAD_AES_256_GCM' || event.resource?.original_type!=='transaction') throw new HttpError(400,'NOTIFY_INVALID','通知类型不正确');
    try { return await decryptResource(this.env.WECHAT_API_V3_KEY!,event.resource) as WechatTransaction; }
    catch { throw new HttpError(400,'NOTIFY_DECRYPT_FAILED','支付通知解密失败'); }
  }
}
